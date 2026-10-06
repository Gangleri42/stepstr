// Feeds the converter what a user might: garbage, a truncated file, an empty file, calls out of order, a second
// file after the first, and a stop answered to a progress report. Checks that it answers with errors rather than
// traps, and keeps working.
//
//   node converter/test/robustness.mjs <converter.wasm> <file.step>
//
// With --experimental-wasm-jspi (Node) the last section also stops a transfer from a timer through an async
// listener that yields to the event loop.
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { loadConverter } from '../loader.js';

const [wasmPath, stepPath] = process.argv.slice(2);
if (!stepPath) {
	console.error('usage: node robustness.mjs <converter.wasm> <file.step>');
	process.exit(2);
}
let failed = 0;
const check = (label, ok, detail = '') => {
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
	if (!ok) failed++;
};
const throws = (label, fn, expectedCode) => {
	try {
		fn();
		check(label, false, 'no error');
	} catch (error) {
		check(label, error.code === expectedCode, `${error.code} ${error.message}`);
	}
};
const sameArray = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameMesh = (a, b) => sameArray(a.positions, b.positions) && sameArray(a.indices, b.indices) && sameArray(a.normals, b.normals);
const triangles = (mesh) => mesh.indices.length / 3;
let onProgress = null;
// Answers the reports of one phase and stops at the first that `decide` picks; records when, for the latency.
const stopper = (phase, decide) => {
	const state = { reports: 0, answeredAt: 0 };
	onProgress = (p, done, total) => {
		if (p !== phase || state.answeredAt) return false;
		state.reports++;
		if (!decide(state.reports, done, total)) return false;
		state.answeredAt = performance.now();
		return true;
	};
	return state;
};
const stopped = (label, fn, state) => {
	try {
		fn();
		check(label, false, state.answeredAt ? 'no error' : 'never asked to stop');
	} catch (error) {
		const latency = (performance.now() - state.answeredAt).toFixed(1);
		check(label, error.code === -5 && error.name === 'AbortError', `${error.name} ${error.code} "${error.message}" at report ${state.reports}, returned ${latency} ms after the answer`);
	}
	onProgress = null;
};

const converter = await loadConverter(readFileSync(wasmPath), { onOutput: () => {}, onProgress: (phase, done, total) => onProgress?.(phase, done, total) });
const step = new Uint8Array(readFileSync(stepPath));
const encoder = new TextEncoder();

console.log('calls out of order');
throws('tree before transfer', () => converter.tree(), -1);
throws('mesh before transfer', () => converter.mesh(0, 0.01, 0.3), -1);
check('read before alloc', converter.exports.conv_read() === -1);
throws('transfer before read', () => converter.transfer(), -1);

console.log('bad input');
throws('garbage bytes', () => converter.open(encoder.encode('this is not a STEP file\n'.repeat(1000))), -1);
throws('empty file', () => converter.open(new Uint8Array(0)), -1);
throws('truncated file', () => converter.open(step.subarray(0, Math.floor(step.length / 3))), -1);
throws('transfer after a failed read', () => converter.transfer(), -1);
// OpenCascade reads a point with one coordinate out of range: the wasm traps where the native library segfaults.
// The instance is lost; open() must start a fresh one.
const stepText = new TextDecoder().decode(step);
const mangled = encoder.encode(stepText.replace(/CARTESIAN_POINT\('',\([^)]*\)\)/g, "CARTESIAN_POINT('',(1.0))"));
try {
	const { solids } = converter.open(mangled);
	check('file with one-coordinate points', true, `${solids} solids, ${converter.warnings().length} warnings`);
} catch (error) {
	const trap = error instanceof WebAssembly.RuntimeError;
	check('file with one-coordinate points', trap || error.code === -1 || error.code === -2, `${trap ? 'trap' : error.code} ${error.message}`);
	if (trap) {
		let dead = false;
		try {
			converter.tree();
		} catch (after) {
			dead = /crashed/.test(after.message);
		}
		check('calls after a trap say the converter crashed', dead);
		const reopened = await converter.open(step);
		check('open after a trap starts a fresh instance', reopened.solids > 0, `${reopened.solids} solids`);
	}
}
converter.close();

console.log('a good file after the bad ones');
const { solids } = converter.open(step);
const tree = converter.tree();
check('opens', solids > 0 && tree.meshes.length === solids, `${solids} solids`);
check('a second open without a close starts clean', converter.open(step).solids === solids && JSON.stringify(converter.tree()) === JSON.stringify(tree));
throws('mesh of a solid that does not exist', () => converter.mesh(solids, 0.01, 0.3), -1);
throws('mesh with a zero deflection', () => converter.mesh(0, 0, 0.3), -1);
throws('release of a solid that does not exist', () => converter.release(-1), -1);
check('invalid option key', converter.exports.conv_set_option(9, 1) === -1);
check('invalid face limit', converter.exports.conv_set_option(3, -5) === -1);
try {
	converter.setOptions({ geometryFaceLimit: -5 });
	check('setOptions rejects an invalid value', false, 'no error');
} catch (error) {
	check('setOptions rejects an invalid value', /invalid option/.test(error.message), error.message);
}

// The deflection checks want a solid with a few hundred triangles at a coarse setting: the first such one, else
// the one with the most.
let subject = 0;
for (let i = 0, most = -1; i < solids; i++) {
	const count = converter.meshTriangles(i, 0.1, 0.5);
	converter.release(i);
	if (count > most) [subject, most] = [i, count];
	if (count >= 200) break;
}
const coarse = converter.mesh(subject, 0.1, 0.5);
const fine = converter.mesh(subject, 0.01, 0.3);
const coarseAgain = converter.mesh(subject, 0.1, 0.5);
check('a finer deflection meshes again', triangles(fine) > triangles(coarse), `solid ${subject}: ${triangles(coarse)} -> ${triangles(fine)} triangles`);
check('a coarser one keeps the fine mesh', sameArray(coarseAgain.indices, fine.indices));
// BRepMesh compares only the linear deflection with the existing triangulation (ABI.md).
check('the same linear deflection keeps the mesh whatever the angular one', sameArray(converter.mesh(subject, 0.01, 0.1).indices, fine.indices));
converter.release(subject);
check('release then mesh again', sameArray(converter.mesh(subject, 0.1, 0.5).indices, coarse.indices));
check('meshTriangles is the triangle count', converter.meshTriangles(subject, 0.1, 0.5) === triangles(coarse));
converter.setOptions({ geometryFaceLimit: 1 });
check('face limit gives null', converter.geometry(0) === null);
converter.setOptions({ geometryFaceLimit: 0 });
check('no face limit gives a record', converter.geometry(0)?.f.length === tree.meshes[0].faces);
converter.setOptions({ normals: false });
check('normals off', converter.mesh(subject, 0.1, 0.5).normals === null);
converter.setOptions({ normals: true });
const withNormals = converter.mesh(subject, 0.1, 0.5);
check('normals on again', withNormals.normals?.length === withNormals.positions.length);
check('warnings is an array', Array.isArray(converter.warnings()));
converter.close();
throws('tree after close', () => converter.tree(), -1);

console.log('the same file twice gives the same bytes');
converter.open(step);
const first = { tree: JSON.stringify(converter.tree()), mesh: converter.mesh(0, 0.02, 0.4), geometry: JSON.stringify(converter.geometry(0)) };
converter.close();
converter.open(step);
const second = { tree: JSON.stringify(converter.tree()), mesh: converter.mesh(0, 0.02, 0.4), geometry: JSON.stringify(converter.geometry(0)) };
converter.close();
check('tree', first.tree === second.tree);
check('mesh', sameMesh(first.mesh, second.mesh));
check('geometry', first.geometry === second.geometry);

console.log('a stop answered to a progress report');
converter.read(step);
stopped('stop inside transfer after three reports', () => converter.transfer(), stopper(2, (n) => n >= 3));
throws('no document after a stopped transfer', () => converter.tree(), -1);
check('close after a stopped transfer', converter.exports.conv_close() === 0);
stopped('stop at the start of a read', () => converter.read(step), stopper(1, () => true));
throws('transfer after a stopped read', () => converter.transfer(), -1);
let openMs = performance.now();
const afterStop = converter.open(step);
openMs = performance.now() - openMs;
check('the same instance then reads and transfers the file', afterStop.solids === solids && JSON.stringify(converter.tree()) === first.tree);
let unconverted = 0;
for (let i = 0; i < solids; i++) {
	if (!(converter.meshTriangles(i, 0.1, 0.5) > 0) || converter.geometry(i) === null) unconverted++;
	converter.release(i);
}
check('and converts every solid', unconverted === 0, `${solids} solids`);
check('mesh after the stopped calls', sameMesh(converter.mesh(0, 0.02, 0.4), first.mesh));
check('geometry after the stopped calls', JSON.stringify(converter.geometry(0)) === first.geometry);
// The mesh and geometry stops want a solid whose call reports from inside: the one with the most faces.
const big = tree.meshes.reduce((best, m, i) => (m.faces > tree.meshes[best].faces ? i : best), 0);
const midway = (n, done, total) => done > 0 && done < total;
const reference = { mesh: converter.mesh(big, 0.01, 0.3), geometry: JSON.stringify(converter.geometry(big)) };
converter.release(big);
stopped(`stop inside the mesh of solid ${big}`, () => converter.mesh(big, 0.01, 0.3), stopper(3, midway));
check('the mesh after a stopped mesh equals a fresh one', sameMesh(converter.mesh(big, 0.01, 0.3), reference.mesh));
converter.release(big);
stopped(`stop inside the geometry of solid ${big}`, () => converter.geometry(big), stopper(4, midway));
check('the geometry after a stopped geometry equals a fresh one', JSON.stringify(converter.geometry(big)) === reference.geometry);
converter.close();

console.log('a listener that throws');
// The throw must not reach the module: the call ends with the listener's error, and the instance stays usable.
const boom = new Error('the listener failed');
let thrown = false;
onProgress = () => {
	if (thrown) return false;
	thrown = true;
	throw boom;
};
try {
	converter.open(step);
	check('the call throws the listener\'s error', false, 'no error');
} catch (error) {
	check('the call throws the listener\'s error', error === boom, `${error.name} ${error.code ?? ''} ${error.message}`);
}
onProgress = null;
check('the next call on the same instance works', converter.open(step).solids === solids && JSON.stringify(converter.tree()) === first.tree);
converter.close();

if (typeof WebAssembly.Suspending === 'function') {
	console.log('JSPI: a timer stops a transfer through an async listener that yields');
	let stop = false;
	let yields = 0;
	const jspi = await loadConverter(readFileSync(wasmPath), {
		jspi: true,
		onOutput: () => {},
		onProgress: async () => {
			yields++;
			await new Promise((resolve) => setImmediate(resolve));
			return stop;
		}
	});
	await jspi.read(step);
	const start = performance.now();
	let flagged = 0;
	let refused = '';
	setTimeout(() => {
		// While the transfer is suspended, the instance takes no other call.
		try {
			jspi.tree();
		} catch (error) {
			refused = error.message;
		}
		stop = true;
		flagged = performance.now();
	}, 200);
	try {
		const pending = jspi.transfer();
		let entered = '';
		try {
			jspi.setOptions({ normals: true });
		} catch (error) {
			entered = error.message;
		}
		check('a suspended call keeps other calls out', /busy/.test(entered), entered || 'setOptions went through');
		await pending;
		check('the timer stops the transfer', false, 'no error');
	} catch (error) {
		const returned = performance.now();
		const detail = `${error.name} ${error.code} after ${(returned - start).toFixed(0)} ms and ${yields} yields, ${(returned - flagged).toFixed(1)} ms after the flag; a read and transfer take ${openMs.toFixed(0)} ms`;
		check('the timer stops the transfer', error.code === -5 && error.name === 'AbortError' && flagged > 0, detail);
		check('well before the transfer would have finished', returned - start < openMs / 2);
		check('the timer found the instance busy', /busy/.test(refused), refused || 'tree() went through');
	}
	stop = false;
	const again = await jspi.open(step);
	check('the JSPI instance then converts the file', again.solids === solids && JSON.stringify(jspi.tree()) === first.tree);
	jspi.close();
	// An async listener that rejects at its first report: the promise rejects with that error and nothing else.
	const asyncBoom = new Error('the async listener failed');
	let rejected = false;
	const rejecting = await loadConverter(readFileSync(wasmPath), {
		jspi: true,
		onOutput: () => {},
		onProgress: async () => {
			if (rejected) return false;
			rejected = true;
			throw asyncBoom;
		}
	});
	try {
		await rejecting.open(step);
		check('a JSPI call rejects with the listener\'s error', false, 'no error');
	} catch (error) {
		check('a JSPI call rejects with the listener\'s error', error === asyncBoom, `${error.name} ${error.code ?? ''} ${error.message}`);
	}
	const afterReject = await rejecting.open(step);
	check('the next JSPI call on the same instance works', afterReject.solids === solids && JSON.stringify(rejecting.tree()) === first.tree);
	rejecting.close();
} else {
	console.log('JSPI: skipped (no WebAssembly.Suspending; Node wants --experimental-wasm-jspi)');
}
console.log(`memory ${Math.round(converter.memoryBytes() / 1048576)} MB`);
console.log(failed ? `FAIL: ${failed}` : 'PASS');
process.exit(failed ? 1 : 0);
