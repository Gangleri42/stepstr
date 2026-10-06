// converter/converter.lock.json names the converter build the tracked sources give: a sha256 over those sources, and
// the sha256 and size of the wasm built from them (scripts/converter-build.mjs). The build itself is not tracked, and
// the golden values and parity hold for that build only, so test/converter-lock.test.ts compares both the sources and
// converter/dist/converter.wasm with it.
//   node scripts/converter-lock.mjs           says whether the sources and the build are the recorded ones
//   node scripts/converter-lock.mjs --write   records both, after a deliberate rebuild
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { converterSources, wasmBuild } from './converter-build.mjs';

const wasm = new URL('../converter/dist/converter.wasm', import.meta.url);
const lockFile = new URL('../converter/converter.lock.json', import.meta.url);

const sources = converterSources();
const build = existsSync(wasm) ? wasmBuild(wasm) : null;

if (process.argv.includes('--write')) {
	if (!build) {
		console.error('converter/dist/converter.wasm is missing; build it with converter/build.sh');
		process.exit(1);
	}
	writeFileSync(lockFile, `${JSON.stringify({ sources, wasm: build }, null, '\t')}\n`);
	console.log(`recorded the sources ${sources} and the build ${build.sha256}, ${build.size} bytes`);
} else {
	const lock = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, 'utf8')) : {};
	const sourcesRecorded = lock.sources === sources;
	const buildRecorded = build !== null && JSON.stringify(lock.wasm) === JSON.stringify(build);
	if (sourcesRecorded) console.log(`the sources are the recorded ones, ${sources}`);
	else console.error('the converter sources changed since the lock was written; rebuild with converter/build.sh');
	if (buildRecorded) console.log(`converter/dist/converter.wasm is the recorded build, ${build.sha256}, ${build.size} bytes`);
	else if (build) console.error('converter/dist/converter.wasm is not the recorded build');
	else console.error('converter/dist/converter.wasm is missing; build it with converter/build.sh');
	if (!sourcesRecorded || !buildRecorded) {
		console.error('after a deliberate rebuild, record it with node scripts/converter-lock.mjs --write');
		process.exit(1);
	}
}
