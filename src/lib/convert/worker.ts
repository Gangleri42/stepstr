// The web build converts in this Worker, so the page stays responsive however long a file takes. The page compiles the
// wasm once and sends the module along with each file; a cancel ends the Worker.
import { loadConverter } from '$converter/loader.js';
import { convertStep } from './run';
import { LONG_PHASES, type WasmConverter } from './types';
import { yieldToHost } from './yield';

type Request = { id: number; module: WebAssembly.Module; step: Uint8Array; name: string };

/** At most this often, in ms, the Worker tells the page how far a long converter call has come. */
const REPORT = 100;

self.onmessage = async (event: MessageEvent<Request>) => {
	const { id, module, step, name } = event.data;
	try {
		let reported = 0;
		const wasm = (await loadConverter(module, {
			// Progress inside a long call reaches the page at once: a Worker's messages go out while it is busy.
			onProgress: (phase, done, total) => {
				const long = LONG_PHASES[phase];
				const now = performance.now();
				if (!long || total <= 0 || now - reported < REPORT) return;
				reported = now;
				self.postMessage({ id, progress: { phase: long, fraction: done / total } });
			}
		})) as unknown as WasmConverter;
		const result = await convertStep(wasm, step, name, {
			onProgress: (progress) => self.postMessage({ id, progress }),
			yieldToHost
		});
		self.postMessage({ id, result }, { transfer: [result.glb.buffer] });
	} catch (err) {
		self.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
	}
};
