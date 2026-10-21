// meshoptimizer's decoder can decode in Workers it starts itself (useWorkers), and that code is in the module whether
// it runs or not. The napplet may start no workers and its page must not mention them (scripts/napplet-artifact.test.ts),
// so its build cuts that path out and keeps the decoder, which decodes on the page's own thread unless asked to use
// workers. Each cut must find its text exactly once: a decoder that changed shape stops the build here.
import type { Plugin } from 'vite';

/** The worker pool and its helpers, between the decoder tables and the object the module returns. */
const POOL = /\n\tvar workers = \[\];\n[\s\S]*?\n(?=\treturn \{\n)/g;
const CUTS: [string, RegExp][] = [
	['the worker pool', POOL],
	['useWorkers', /\n\t\tuseWorkers: function \(count\) \{\n\t\t\tinitWorkers\(count\);\n\t\t\},/g],
	['the decode through a worker', /\n\t\t\tif \(workers\.length > 0\) \{\n\t\t\t\treturn decodeWorker\([^)]*\);\n\t\t\t\}\n/g]
];

/** The decoder's source with every trace of its workers cut. */
export function withoutWorkers(source: string): string {
	let cut = source;
	for (const [what, pattern] of CUTS) {
		const found = cut.match(pattern)?.length ?? 0;
		if (found !== 1) throw new Error(`meshopt decoder: ${what} found ${found} times, not once`);
		cut = cut.replace(pattern, '');
	}
	if (/worker/i.test(cut)) throw new Error('meshopt decoder: worker code is left after the cuts');
	return cut;
}

/** The napplet build's copy of meshoptimizer's decoder, without its workers. */
export function meshoptNoWorkers(): Plugin {
	return {
		name: 'meshopt-no-workers',
		enforce: 'pre',
		transform: (code, id) => (id.split('?')[0].endsWith('/meshoptimizer/meshopt_decoder.mjs') ? withoutWorkers(code) : null)
	};
}
