// The web build's converter: a module Worker, handed the wasm the page compiled.
import wasmUrl from '$converter/dist/converter.wasm?url';
import type { Converter, Converted, ConvertProgress } from './types';

type Reply = { id: number; progress?: ConvertProgress; result?: Converted; error?: string };

export function workerConverter(): Converter {
	let worker: Worker | null = null;
	let module: Promise<WebAssembly.Module> | null = null;
	let next = 0;
	/** Fetched and compiled once for the page, so a worker that a cancel dropped costs no second download. */
	const compiled = () =>
		(module ??= fetch(wasmUrl)
			.then(async (response) => {
				if (!response.ok) throw new Error(`the converter could not be loaded (${response.status})`);
				return WebAssembly.compile(await response.arrayBuffer());
			})
			.catch((err) => {
				module = null;
				throw err;
			}));
	return {
		prepare: () => void compiled().catch(() => undefined),
		async convert(step, name, onProgress, signal) {
			onProgress({ phase: 'start' });
			const wasm = await compiled();
			signal?.throwIfAborted();
			return new Promise((resolve, reject) => {
				worker ??= new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
				const current = worker;
				const id = ++next;
				const done = () => {
					current.removeEventListener('message', onMessage);
					current.removeEventListener('error', onError);
					current.removeEventListener('messageerror', onError);
					signal?.removeEventListener('abort', onAbort);
				};
				const drop = () => {
					done();
					current.terminate();
					if (worker === current) worker = null;
				};
				const onMessage = (event: MessageEvent<Reply>) => {
					const reply = event.data;
					if (reply.id !== id) return;
					if (reply.progress) return onProgress(reply.progress);
					done();
					if (reply.result) resolve(reply.result);
					else reject(new Error(reply.error ?? 'the conversion failed'));
				};
				// A worker whose script did not load, say after a deploy replaced the page's files, never answers. It is
				// dropped, so the next conversion starts a new one.
				const onError = () => {
					drop();
					reject(new Error('the converter could not be started; reload the page'));
				};
				// While the worker converts, its one thread is inside the converter and no message reaches it, so
				// dropping the worker is how a conversion stops.
				const onAbort = () => {
					drop();
					reject(new DOMException('The conversion was cancelled', 'AbortError'));
				};
				current.addEventListener('message', onMessage);
				current.addEventListener('error', onError);
				current.addEventListener('messageerror', onError);
				signal?.addEventListener('abort', onAbort, { once: true });
				// The worker gets its own copy; the page keeps the bytes for a later download.
				const bytes = step.slice();
				current.postMessage({ id, module: wasm, step: bytes, name }, [bytes.buffer]);
			});
		}
	};
}
