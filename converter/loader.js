// Loads converter.wasm from bytes the caller provides, in a page, a Worker, a sandboxed napplet or Node. There is
// no Emscripten glue: the module imports a few WASI calls and two env functions, all implemented here. Nothing
// here loads code, reaches the network or touches storage.
//
//   let stop = false;                                        // set by a Cancel button, a deadline...
//   const onProgress = (phase, done, total) => stop;         // a truthy answer stops the call
//   const converter = await loadConverter(wasmBytes, { onProgress });
//   const { solids } = converter.open(stepBytes);            // or read(stepBytes) then transfer()
//   const tree = converter.tree();                           // the manifest (ABI.md)
//   for (let i = 0; i < solids; i++) {
//     const mesh = converter.mesh(i, 0.01, 0.3);             // { positions, indices, faceIds, normals, groups }
//     const geometry = converter.geometry(i);                // the Measure record, or null
//   }
//   converter.setOptions({ normals: false });                // normals and geometryFaceLimit apply per call
//   const triangles = converter.meshTriangles(0, 0.1, 0.5);  // the count alone, nothing copied out
//   converter.close();
//
// Errors are thrown as Error with the converter's message and `code` (ABI.md). A call stopped through onProgress
// throws one named AbortError with code -5; the instance stays usable and the next file starts clean. A listener
// that throws stops the call the same way, and the call throws the listener's error instead. A WebAssembly trap
// (OpenCascade is not hardened against every malformed entity) throws a WebAssembly.RuntimeError; the instance is
// then dead, and the next open() starts a fresh one from the same compiled module with the options in force.
//
// With { jspi: true } on an engine that has WebAssembly.Suspending, open/read/transfer/mesh/meshTriangles/geometry
// return promises and onProgress may be async: awaiting it yields to the event loop while the converter works,
// and a promise that resolves to a truthy value stops the call. Without JSPI a promise cannot be awaited and
// counts as go on; only a synchronous truthy return stops (a deadline in a Worker, a flag in Node).

const ABI_VERSION = 2;
const CANCELLED = -5;
const CLOCK_REALTIME = 0;
const ENOSYS = 52;
const EBADF = 8;
const OPTION = { healing: 1, normals: 2, geometryFaceLimit: 3 };

/**
 * Called from the long calls, at most every few milliseconds; a truthy return (with JSPI, a truthy resolution)
 * stops the call. Phases: 1 read, 2 transfer, 3 mesh, 4 geometry.
 * @typedef {(phase: number, done: number, total: number) => unknown} ProgressListener
 */

/**
 * @param {BufferSource | WebAssembly.Module} wasmBytes
 * @param {{ onProgress?: ProgressListener, onOutput?: (text: string) => void, jspi?: boolean }} [options]
 */
export async function loadConverter(wasmBytes, { onProgress, onOutput, jspi = false } = {}) {
	const module = wasmBytes instanceof WebAssembly.Module ? wasmBytes : await WebAssembly.compile(wasmBytes);
	const decoder = new TextDecoder();
	const output = onOutput ?? ((text) => console.log('[converter]', text));
	const suspending = jspi && typeof WebAssembly.Suspending === 'function';

	/** @type {WebAssembly.Memory} */
	let memory;
	/** @type {Record<string, Function>} */
	let x;
	let calls;
	let crashed = false;
	/** The options in force: set again on a fresh instance after a trap. */
	const options = {};

	const wasi = {
		fd_write(fd, iovs, count, written) {
			const view = new DataView(memory.buffer);
			let text = '';
			let total = 0;
			for (let i = 0; i < count; i++) {
				const ptr = view.getUint32(iovs + i * 8, true);
				const len = view.getUint32(iovs + i * 8 + 4, true);
				text += decoder.decode(new Uint8Array(memory.buffer, ptr, len));
				total += len;
			}
			view.setUint32(written, total, true);
			if (fd !== 1 && fd !== 2) return EBADF;
			if (text.trim()) output(text.trimEnd());
			return 0;
		},
		fd_close: () => EBADF,
		fd_seek: () => ENOSYS,
		fd_read: () => ENOSYS,
		environ_sizes_get(count, size) {
			const view = new DataView(memory.buffer);
			view.setUint32(count, 0, true);
			view.setUint32(size, 0, true);
			return 0;
		},
		environ_get: () => 0,
		clock_time_get(id, precision, out) {
			// The wall clock in Unix time: OpenCascade builds dates from it and rejects years before 1979. The others
			// are monotonic.
			const ns = id === CLOCK_REALTIME ? BigInt(Date.now()) * 1000000n : BigInt(Math.round(performance.now() * 1e6));
			new DataView(memory.buffer).setBigUint64(out, ns, true);
			return 0;
		},
		random_get(ptr, len) {
			crypto.getRandomValues(new Uint8Array(memory.buffer, ptr, len));
			return 0;
		},
		proc_exit(code) {
			throw new Error(`converter exited with code ${code}`);
		}
	};
	/** The host's answer to a progress report, as the module reads it: 1 to stop, 0 to go on. */
	const answer = (stop) => (stop ? 1 : 0);
	// What the listener threw at a report. An exception must not cross the import into the module (a C++ handler
	// may catch it as a foreign exception, or it unwinds the module's frames and leaves the instance unusable), so
	// the report answers stop instead, and the call throws the listener's error in place of the AbortError.
	let listenerError = null;
	const failed = (error) => {
		listenerError = error;
		return 1;
	};
	const env = {
		emscripten_notify_memory_growth: () => {},
		conv_progress: suspending
			? new WebAssembly.Suspending(async (phase, done, total) => {
					try {
						return answer(await onProgress?.(phase, done, total));
					} catch (error) {
						return failed(error);
					}
				})
			: (phase, done, total) => {
					try {
						const stop = onProgress?.(phase, done, total);
						// A promise is truthy but cannot be awaited here, so it counts as go on.
						return answer(stop && typeof stop.then !== 'function');
					} catch (error) {
						return failed(error);
					}
				}
	};

	/** Sets the given options on the module and remembers them for the next instance. */
	const applyOptions = (changes) => {
		for (const [name, key] of Object.entries(OPTION)) {
			const value = changes[name];
			if (value === undefined) continue;
			if (x.conv_set_option(key, Number(value)) < 0) throw new Error(`invalid option ${name}: ${value}`);
			options[name] = value;
		}
	};

	async function instantiate() {
		const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi, env });
		x = instance.exports;
		memory = x.memory;
		x._initialize?.();
		const abi = x.conv_abi();
		if (abi !== ABI_VERSION) throw new Error(`converter ABI ${abi} is not the ABI this loader speaks (${ABI_VERSION})`);
		// The long calls: wrapped to return promises when JSPI is on.
		const long = (name) => (suspending ? WebAssembly.promising(x[name]) : x[name]);
		calls = { read: long('conv_read'), transfer: long('conv_transfer'), mesh: long('conv_mesh'), geometry: long('conv_geometry') };
		crashed = false;
		applyOptions(options);
	}
	await instantiate();
	const abi = x.conv_abi();

	/** Applies fn to a value that is a promise only in JSPI mode. */
	const after = (value, fn) => (value instanceof Promise ? value.then(fn) : fn(value));
	const crashedError = () => new Error('the converter crashed on the previous file: open() starts a fresh instance');
	// A suspended JSPI call holds the module's state mid-call, and a second entry before it returns would corrupt
	// that state (ABI.md): the instance refuses other calls while one is suspended.
	let busy = false;
	const idle = () => {
		if (busy) throw new Error('the converter is busy with another call: wait for it to return');
	};
	/** One call into the module; an exception out of the wasm itself (a trap) leaves the instance unusable. */
	function guarded(fn) {
		if (crashed) throw crashedError();
		idle();
		const fail = (error) => {
			crashed = true;
			throw error;
		};
		listenerError = null;
		try {
			const value = fn();
			if (!(value instanceof Promise)) return value;
			busy = true;
			return value.finally(() => (busy = false)).catch(fail);
		} catch (error) {
			fail(error);
		}
	}
	const cstring = (ptr) => {
		const heap = new Uint8Array(memory.buffer);
		const start = ptr >>> 0;
		return decoder.decode(heap.subarray(start, heap.indexOf(0, start)));
	};
	const check = (code) => {
		// The listener's error outranks the stop it caused; it is also thrown when the stop came too late to end the
		// call (ABI.md), since a host whose listener failed should hear of it.
		if (listenerError) {
			const error = listenerError;
			listenerError = null;
			throw error;
		}
		if (code < 0) {
			const error = new Error(cstring(x.conv_error()));
			error.code = code;
			if (code === CANCELLED) error.name = 'AbortError';
			throw error;
		}
		return code;
	};
	const resultText = (length) => decoder.decode(new Uint8Array(memory.buffer, x.conv_result_ptr() >>> 0, length));
	const resultJson = (code) => JSON.parse(resultText(check(code)));

	function read(stepBytes, changes = {}) {
		if (crashed) return instantiate().then(() => read(stepBytes, changes));
		idle();
		applyOptions(changes);
		if (stepBytes.byteLength) {
			const ptr = x.conv_alloc(stepBytes.byteLength) >>> 0;
			if (!ptr) throw new Error(`cannot allocate ${stepBytes.byteLength} bytes for the STEP file`);
			new Uint8Array(memory.buffer, ptr, stepBytes.byteLength).set(stepBytes);
		}
		return after(guarded(calls.read), (code) => {
			check(code);
		});
	}
	function transfer() {
		return after(guarded(calls.transfer), (code) => ({ solids: check(code) }));
	}
	/** Options for the calls that follow: healing at the next transfer, normals and geometryFaceLimit per call. */
	function setOptions(changes) {
		if (crashed) throw crashedError();
		idle();
		applyOptions(changes);
	}
	/** Copies one mesh out of wasm memory; the copies are aligned whatever the result's address. */
	function readMesh(length) {
		const base = x.conv_result_ptr() >>> 0;
		const header = new DataView(memory.buffer, base, 8);
		const nodes = header.getUint32(0, true);
		const triangles = header.getUint32(4, true);
		let at = base + 8;
		const take = (Type, count) => {
			const bytes = count * Type.BYTES_PER_ELEMENT;
			const array = new Type(memory.buffer.slice(at, at + bytes));
			at += bytes;
			return array;
		};
		const positions = take(Float32Array, 3 * nodes);
		const indices = take(Uint32Array, 3 * triangles);
		const faceIds = take(Uint32Array, triangles);
		const [groupCount] = take(Uint32Array, 1);
		const appearances = take(Int32Array, groupCount);
		const counts = take(Uint32Array, groupCount);
		const [flags] = take(Uint32Array, 1);
		const normals = flags & 1 ? take(Float32Array, 3 * nodes) : null;
		if (at - base !== length) throw new Error(`mesh result has ${length} bytes, expected ${at - base}`);
		const groups = Array.from(appearances, (appearance, i) => ({ appearance, triangles: counts[i] }));
		return { positions, indices, faceIds, normals, groups };
	}
	/** The triangle count from a mesh result's header; the arrays stay in wasm memory. */
	const triangleCount = () => new DataView(memory.buffer, x.conv_result_ptr() >>> 0, 8).getUint32(4, true);

	return {
		abi,
		get exports() {
			return x;
		},
		read,
		transfer,
		open: (stepBytes, changes) => after(read(stepBytes, changes), transfer),
		setOptions,
		tree: () => resultJson(guarded(x.conv_tree)),
		mesh: (solid, linear, angular) => after(guarded(() => calls.mesh(solid, linear, angular)), (code) => readMesh(check(code))),
		meshTriangles: (solid, linear, angular) =>
			after(guarded(() => calls.mesh(solid, linear, angular)), (code) => {
				check(code);
				return triangleCount();
			}),
		geometry: (solid) => after(guarded(() => calls.geometry(solid)), resultJson),
		warnings: () => resultJson(guarded(x.conv_warnings)),
		release: (solid) => {
			check(guarded(() => x.conv_release(solid)));
		},
		close: () => {
			check(guarded(x.conv_close));
		},
		memoryBytes: () => memory.buffer.byteLength
	};
}

/** Base64 of a gzip stream, as a module inlined in a page ships, back to bytes. */
export async function gunzipBase64(text) {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}
