// The converter against the Python oracle, which defines a correct conversion: converter/test/parity.mjs on each test
// file, compared with the oracle's output from `npm run oracle`. Hammer takes about a minute, so it runs only with
// STEPSTR_SLOW=1.
import { describe, expect, it } from 'vitest';
import { parity } from '../converter/test/parity.mjs';
import { fixtureFile, FIXTURES, type FixtureName } from './fixtures';
import { oracleOutput, staleOracle } from './oracle-output';
import { CONVERTER, lacking, SLOW } from './prerequisites';

const slow = new Set<FixtureName>(['hammer-v50']);

describe.each(Object.keys(FIXTURES) as FixtureName[])('%s', (name) => {
	const oracle = oracleOutput(name);
	const skip = (slow.has(name) && !SLOW) || lacking(CONVERTER, fixtureFile(name), oracle);

	it.skipIf(skip)('converts as the Python oracle does', async () => {
		expect(staleOracle(name)).toBeUndefined();
		const { failures } = await parity(CONVERTER.path, fixtureFile(name).path, oracle.dir);
		expect(failures.length, failures.slice(0, 5).join('\n')).toBe(0);
	}, 900_000);
});
