// Runs the Python oracle (converter/oracle/step_to_manifest.py) on the test files of test/fixtures.json, into
// .cache/oracle/<name>/, where test/parity.test.ts reads it. Output made by the same script
// from the same file stays: sources.json beside it records both hashes.
//   node scripts/oracle.mjs             every file
//   node scripts/oracle.mjs seed-v15    one
// ORACLE_PYTHON is the Python command, by default uv with the OpenCascade bindings the converter's OCCT matches.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const python = (process.env.ORACLE_PYTHON ?? 'uv run --with cadquery-ocp==8.0.1.0.0 python').split(/\s+/).filter(Boolean);
const script = new URL('../converter/oracle/step_to_manifest.py', import.meta.url);
const fixtures = JSON.parse(readFileSync(new URL('../test/fixtures.json', import.meta.url), 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const scriptHash = sha256(readFileSync(script));

for (const [name, fixture] of Object.entries(fixtures)) {
	if (process.argv[2] && process.argv[2] !== name) continue;
	const step = new URL(`../.cache/fixtures/${fixture.file}`, import.meta.url);
	if (!existsSync(step) || sha256(readFileSync(step)) !== fixture.sha256) {
		console.error(`${name}: the test file is missing or not the pinned one; run npm run fixtures`);
		process.exitCode = 1;
		continue;
	}
	const out = new URL(`../.cache/oracle/${name}/`, import.meta.url);
	const sources = new URL('sources.json', out);
	const stamp = JSON.stringify({ script: scriptHash, step: fixture.sha256 });
	if (existsSync(sources) && readFileSync(sources, 'utf8') === stamp) {
		console.log(`${name}: present`);
		continue;
	}
	// A run on another file or script leaves meshes this run may not overwrite.
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true });
	const start = performance.now();
	try {
		// The manifest's version is the Fusion document's; parity and the pipeline do not read it.
		execFileSync(python[0], [...python.slice(1), fileURLToPath(script), fileURLToPath(step), fileURLToPath(out), '--version', '0'], { stdio: 'inherit' });
	} catch (err) {
		rmSync(out, { recursive: true, force: true });
		console.error(`${name}: the oracle failed: ${err.message}`);
		process.exitCode = 1;
		continue;
	}
	writeFileSync(sources, stamp);
	console.log(`${name}: made in ${((performance.now() - start) / 1000).toFixed(0)} s`);
}
