// Converts a STEP file in Node exactly as the viewer does in a browser, and makes the files a site publishes from it:
//   model.glb         the viewer's GLB, meshopt-compressed (compress.ts)
//   measure.json.gz   the measurement data, whole, its glb field naming model.glb by its sha256
//   summary.json      the conversion id, the sha256 and size of the STEP file and of both files, and the counts
// The same STEP file, converter and conversion id always give the same bytes.
//   npx tsx pipeline/convert.ts <file.step> --out <dir>
// CONVERTER_WASM swaps in another converter build than converter/dist/converter.wasm; the conversion id follows it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'fflate';
import { runnerImport } from 'vite';
import { loadConverter } from '../converter/loader.js';
import type { MeasureData } from '../src/lib/measure/format.ts';
import { about } from './about.ts';
import { compressGlb } from './compress.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

export const WASM = process.env.CONVERTER_WASM ?? join(root, 'converter/dist/converter.wasm');

/** What src/lib/convert/run.ts returns; its own type imports through $lib, which tsc cannot follow from here. */
export type Converted = {
	glb: Uint8Array;
	measure: MeasureData;
	doc: string;
	unit: string;
	solids: number;
	triangles: number;
	warnings: string[];
};
export type Progress = { phase: string; done?: number; total?: number };
type ConvertStep = (
	wasm: unknown,
	step: Uint8Array,
	name: string,
	options: { onProgress(progress: Progress): void; yieldToHost(): Promise<void> }
) => Promise<Converted>;

export type Pin = { sha256: string; size: number };
export type Summary = {
	/** ABOUT.conversion of the web build, which a viewer compares before it takes these files for its own. */
	conversion: string;
	step: Pin;
	glb: Pin;
	measure: Pin;
	solids: number;
	triangles: number;
	warnings: string[];
};
export type Published = { glb: Uint8Array; measure: Uint8Array; summary: Summary };

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const pin = (bytes: Uint8Array): Pin => ({ sha256: sha256(bytes), size: bytes.length });

let module: Promise<{ convertStep: ConvertStep }> | null = null;

/**
 * run.ts as the web build bundles it. It and the pipeline behind it import each other through $lib, which only Vite
 * resolves, so it goes through Vite's module runner with stepstr's alias and tsconfig; the packages it calls load
 * from stepstr's node_modules, the versions the conversion id names. That tsconfig extends the one `svelte-kit sync`
 * writes, which an install without scripts (npm ci --ignore-scripts) never runs, so it is written first when missing.
 */
function runner() {
	if (!module && !existsSync(join(root, '.svelte-kit/tsconfig.json'))) {
		execFileSync(join(root, 'node_modules/.bin/svelte-kit'), ['sync'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
	}
	return (module ??= runnerImport<{ convertStep: ConvertStep }>(join(root, 'src/lib/convert/run.ts'), {
		root,
		logLevel: 'warn',
		tsconfig: join(root, 'tsconfig.json'),
		resolve: { alias: { $lib: join(root, 'src/lib') } }
	}).then((imported) => imported.module));
}

/** The viewer's own conversion of a STEP file: the uncompressed GLB and measurement data a browser makes from it. */
export async function convert(step: Uint8Array, name: string, onProgress: (progress: Progress) => void = () => {}): Promise<Converted> {
	const { convertStep } = await runner();
	const wasm = await loadConverter(readFileSync(WASM), { onOutput: () => {} });
	return convertStep(wasm, step, name, { onProgress, yieldToHost: async () => {} });
}

/** The files to publish for a conversion of these STEP bytes. */
export async function publishable(step: Uint8Array, converted: Converted): Promise<Published> {
	const { conversion } = about(WASM);
	if (!conversion) throw new Error(`${WASM} is missing: build the converter with converter/build.sh`);
	const glb = await compressGlb(converted.glb);
	// fflate writes the same header everywhere; node:zlib's names the system it was built on.
	const measure = gzipSync(new TextEncoder().encode(JSON.stringify({ ...converted.measure, glb: sha256(glb) })), { level: 9, mtime: 0 });
	const { solids, triangles, warnings } = converted;
	return { glb, measure, summary: { conversion, step: pin(step), glb: pin(glb), measure: pin(measure), solids, triangles, warnings } };
}

async function main() {
	const { values, positionals } = parseArgs({ options: { out: { type: 'string' } }, allowPositionals: true });
	if (positionals.length !== 1 || !values.out) {
		console.error('usage: npx tsx pipeline/convert.ts <file.step> --out <dir>');
		process.exit(2);
	}
	const [path] = positionals;
	const out = resolve(values.out);
	const step = new Uint8Array(readFileSync(path));
	let phase = '';
	const converted = await convert(step, basename(path), (progress) => {
		if (progress.phase === phase) return;
		phase = progress.phase;
		console.log(`${phase}${progress.total ? ` (${progress.total} solids)` : ''}`);
	});
	const { glb, measure, summary } = await publishable(step, converted);
	mkdirSync(out, { recursive: true });
	writeFileSync(join(out, 'model.glb'), glb);
	writeFileSync(join(out, 'measure.json.gz'), measure);
	writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, '\t')}\n`);
	const mb = (bytes: number) => `${(bytes / 1e6).toFixed(2)} MB`;
	console.log(`${summary.solids} solids, ${summary.triangles} triangles; GLB ${mb(converted.glb.length)} → ${mb(glb.length)}`);
	for (const warning of summary.warnings) console.log(`  ${warning}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
