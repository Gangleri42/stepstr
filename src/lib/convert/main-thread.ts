// The napplet's converter: a sandboxed napplet may not start workers, so the conversion runs on the page's own thread,
// in steps with a yield between them. The wasm is not part of the napplet: it arrives on first use, as the gzipped,
// base64-encoded text the build published next to it.
import { gunzipBase64, loadConverter } from '$converter/loader.js';
import { convertStep } from './run';
import { LONG_PHASES, type Converter, type WasmConverter } from './types';
import { yieldToHost } from './yield';

/** How long the converter may hold the page before it gives the page a turn, where it can (JSPI), in ms. */
const TURN = 32;

/** fetchText must return the converter's text already checked against its hash (converter-source.ts). */
export function mainThreadConverter(fetchText: () => Promise<string>): Converter {
	let compiled: Promise<WebAssembly.Module> | null = null;
	// Fetched, decoded and compiled once; each file gets a fresh instance, whose memory goes with it. A failure is not
	// kept, so the next file tries again.
	const module = () =>
		(compiled ??= fetchText()
			.then((text) => gunzipBase64(text))
			.then((bytes) => WebAssembly.compile(bytes as BufferSource))
			.catch((err) => {
				compiled = null;
				throw err;
			}));
	return {
		prepare: () => void module().catch(() => undefined),
		async convert(step, name, onProgress, signal) {
			onProgress({ phase: 'start' });
			await yieldToHost();
			// Where the browser can suspend the converter in the middle of a call (JSPI), its progress reports give the
			// page a turn every few frames, move the bar through the long calls, and stop the call once the file is
			// cancelled. Elsewhere the page waits for each call to end, and a cancel takes effect between them.
			const wasmModule = await module();
			let turn = performance.now();
			const report = async (phase: number, done: number, total: number) => {
				const long = LONG_PHASES[phase];
				if (long && total > 0) onProgress({ phase: long, fraction: done / total });
				if (performance.now() - turn > TURN) {
					await yieldToHost();
					turn = performance.now();
				}
				return signal?.aborted ?? false;
			};
			const jspi = typeof (WebAssembly as { Suspending?: unknown }).Suspending === 'function';
			const wasm = (jspi ? await loadConverter(wasmModule, { jspi: true, onProgress: report }) : await loadConverter(wasmModule)) as unknown as WasmConverter;
			return convertStep(wasm, step, name, { onProgress, yieldToHost, signal });
		}
	};
}
