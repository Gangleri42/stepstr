// What converter/converter.lock.json records of the converter build: a sha256 over the sources converter/build.sh
// reads, and the sha256 and size of the wasm it made from them. scripts/converter-lock.mjs writes the lock and
// test/converter-lock.test.ts checks it, both through these functions.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';

const converter = new URL('../converter/', import.meta.url);

/** The build script and what src/* matches in the shell (dot files left out), in a fixed order. */
function sourceFiles() {
	const sources = readdirSync(new URL('src/', converter))
		.filter((name) => !name.startsWith('.'))
		.sort()
		.map((name) => `src/${name}`);
	return ['build.sh', ...sources];
}

/** The sha256 of the converter's sources, each with its path. */
export function converterSources() {
	const hash = createHash('sha256');
	for (const path of sourceFiles()) {
		// Line endings as committed, whatever the checkout made of them.
		hash.update(`converter/${path}\n${readFileSync(new URL(path, converter), 'utf8').replace(/\r\n/g, '\n')}\n`);
	}
	return hash.digest('hex');
}

/**
 * The sha256 and size of a converter build.
 * @param {string | URL} path
 */
export function wasmBuild(path) {
	const bytes = readFileSync(path);
	return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
}
