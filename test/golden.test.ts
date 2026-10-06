// Each test file's conversion under each meshing rule (src/lib/convert/mesh-rule.ts), summed up: counts, warnings, and
// the sha256 of the GLB and of the measurement data. A change in what the converter or the pipeline produce shows here.
// When a change is meant, check it (the Python oracle through converter/test/parity.mjs, and the viewer), then write
// the new values:
//   UPDATE_GOLDEN=1 STEPSTR_SLOW=1 npx vitest run test/golden.test.ts
// Hammer takes half a minute a rule, so it runs only with STEPSTR_SLOW=1. The files come from `node scripts/fixtures.mjs`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConverter } from '$converter/loader.js';
import { MESH_RULES } from '$lib/convert/mesh-rule';
import { convertStep } from '$lib/convert/run';
import type { WasmConverter } from '$lib/convert/types';
import { sha256Hex } from '$lib/source/sha256';
import { fixtureBytes, fixtureFile, FIXTURES, goldenKey, type FixtureName } from './fixtures';
import { CONVERTER, lacking, SLOW } from './prerequisites';

const goldenPath = new URL('./golden.json', import.meta.url);
const golden: Record<string, unknown> = existsSync(goldenPath) ? JSON.parse(readFileSync(goldenPath, 'utf8')) : {};
const slow = new Set<FixtureName>(['hammer-v50']);

describe.each(Object.keys(FIXTURES) as FixtureName[])('%s', (name) => {
	const skip = (slow.has(name) && !SLOW) || lacking(CONVERTER, fixtureFile(name));
	const step = fixtureBytes(name);
	for (const meshRule of MESH_RULES) {
		it.skipIf(skip)(`converts as it did, meshed '${meshRule}'`, async () => {
			const key = goldenKey(name, meshRule);
			const wasm = (await loadConverter(readFileSync(CONVERTER.path), { onOutput: () => {} })) as unknown as WasmConverter;
			const result = await convertStep(wasm, step!, FIXTURES[name].file, { onProgress: () => {}, yieldToHost: async () => {}, meshRule });
			const summary = {
				solids: result.solids,
				triangles: result.triangles,
				unit: result.unit,
				warnings: result.warnings,
				glb: sha256Hex(result.glb),
				measure: sha256Hex(new TextEncoder().encode(JSON.stringify(result.measure)))
			};
			expect(result.measure.glb).toBe(summary.glb);
			if (process.env.UPDATE_GOLDEN) {
				const current = existsSync(goldenPath) ? JSON.parse(readFileSync(goldenPath, 'utf8')) : {};
				writeFileSync(goldenPath, `${JSON.stringify({ ...current, [key]: summary }, null, '\t')}\n`);
			} else {
				expect(summary).toEqual(golden[key]);
			}
		}, 300_000);
	}
});
