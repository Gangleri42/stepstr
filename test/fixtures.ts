// The test files of test/fixtures.json, where scripts/fixtures.mjs puts them. A test that needs one names it through
// fixtureFile, so it skips without the file, or fails under STEPSTR_STRICT=1 (test/prerequisites.ts).
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { MeshRule } from '../src/lib/convert/mesh-rule';
import fixtures from './fixtures.json' with { type: 'json' };
import type { Prerequisite } from './prerequisites';

export type FixtureName = keyof typeof fixtures;

export const FIXTURES = fixtures;

/** Where test/golden.json keeps what a test file converts to under a meshing rule: 'once' under the file's name. */
export const goldenKey = (name: FixtureName, rule: MeshRule) => (rule === 'once' ? name : `${name} ${rule}`);

export const fixtureFile = (name: FixtureName): Prerequisite => ({
	what: `the test file ${name}`,
	path: fileURLToPath(new URL(`../.cache/fixtures/${fixtures[name].file}`, import.meta.url)),
	how: 'fetch it with `npm run fixtures`'
});

/** The path of a fetched test file, or null until `node scripts/fixtures.mjs` has fetched it. */
export function fixture(name: FixtureName): string | null {
	const { path } = fixtureFile(name);
	return existsSync(path) ? path : null;
}

export const fixtureBytes = (name: FixtureName) => {
	const path = fixture(name);
	return path ? new Uint8Array(readFileSync(path)) : null;
};
