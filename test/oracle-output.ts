// The Python oracle's output for a test file, where `npm run oracle` (scripts/oracle.mjs) puts it. sources.json, written
// last, records the hashes of the oracle script and of the test file that made it.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FIXTURES, type FixtureName } from './fixtures';
import type { Prerequisite } from './prerequisites';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export const oracleOutput = (name: FixtureName): Prerequisite & { dir: string } => {
	const dir = `.cache/oracle/${name}`;
	return { dir, what: `the oracle output for ${name}`, path: `${dir}/sources.json`, how: 'make it with `npm run oracle`' };
};

/**
 * Why the oracle's output for a test file cannot be compared with, or undefined when it can. Output from an older oracle
 * script or another file would make the comparison mean nothing.
 */
export function staleOracle(name: FixtureName): string | undefined {
	const { dir, path } = oracleOutput(name);
	const stamp = JSON.parse(readFileSync(path, 'utf8'));
	const script = sha256(readFileSync('converter/oracle/step_to_manifest.py'));
	if (stamp.script === script && stamp.step === FIXTURES[name].sha256) return undefined;
	return `${dir} is out of date; run npm run oracle`;
}
