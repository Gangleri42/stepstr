// The converter build is not tracked; converter/converter.lock.json names the one the tracked sources give, and the
// golden values and parity results hold for that build only. Checking the sources too catches a change to them that
// was never built.
import { expect, it } from 'vitest';
import lock from '../converter/converter.lock.json' with { type: 'json' };
import { converterSources, wasmBuild } from '../scripts/converter-build.mjs';
import { CONVERTER, lacking } from './prerequisites';

const record = 'node scripts/converter-lock.mjs --write';

it('the converter sources are the ones converter/converter.lock.json records', () => {
	expect(converterSources(), `the converter sources changed since the lock was written; rebuild with converter/build.sh, then run ${record}`).toBe(lock.sources);
});

it.skipIf(lacking(CONVERTER))('the converter is the build converter/converter.lock.json records', () => {
	expect(wasmBuild(CONVERTER.path), `${CONVERTER.path} is another build; after a deliberate rebuild, run ${record}`).toEqual(lock.wasm);
});
