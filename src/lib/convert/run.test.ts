// The whole conversion on a real file: the wasm converter, the planning, the pipeline, and a GLB three.js can read.
// It takes the Seed test file unless STEPSTR_STEP names another STEP file, and converter/dist/converter.wasm unless
// STEPSTR_WASM names another build. Then the messages for a conversion that fails, on a stand-in converter.
import { readFileSync } from 'node:fs';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { loadConverter } from '$converter/loader.js';
import { explainLoadError } from '$lib/source/load';
import { sha256Hex } from '$lib/source/sha256';
import { fixtureFile } from '../../../test/fixtures';
import { CONVERTER, lacking } from '../../../test/prerequisites';
import { MESH_RULE } from './mesh-rule';
import { convertStep } from './run';
import type { ConvertProgress, WasmConverter } from './types';

const step = process.env.STEPSTR_STEP
	? { what: 'the STEP file STEPSTR_STEP names', path: process.env.STEPSTR_STEP, how: 'point STEPSTR_STEP at a STEP file' }
	: fixtureFile('seed-v15');

describe.skipIf(lacking(CONVERTER, step))('conversion of a real file', () => {
	it('gives a GLB and measurement data that belong together', async () => {
		const wasm = (await loadConverter(readFileSync(CONVERTER.path), { onOutput: () => {} })) as unknown as WasmConverter;
		const phases = new Set<string>();
		const start = performance.now();
		const result = await convertStep(wasm, new Uint8Array(readFileSync(step.path)), 'test.step', {
			onProgress: (p: ConvertProgress) => phases.add(p.phase),
			yieldToHost: async () => {}
		});
		const seconds = (performance.now() - start) / 1000;

		expect([...phases]).toEqual(['read', 'transfer', ...(MESH_RULE === 'planned' ? ['plan'] : []), 'mesh', 'build', 'geometry']);
		expect(result.measure.glb).toBe(sha256Hex(result.glb));
		expect(result.measure.solids).toHaveLength(result.solids);
		expect(result.measure.solids.filter(Boolean).length).toBeGreaterThan(0);

		const gltf = await new GLTFLoader().parseAsync(result.glb.slice().buffer, '');
		let bodies = 0, withFaceIds = 0, withNormals = 0;
		gltf.scene.traverse((object) => {
			if (object.userData.body) bodies++;
			const geometry = (object as { geometry?: { getAttribute(name: string): unknown } }).geometry;
			if (geometry?.getAttribute('_faceid')) withFaceIds++;
			if (geometry?.getAttribute('normal')) withNormals++;
		});
		expect(bodies).toBeGreaterThan(0);
		expect(withFaceIds).toBeGreaterThan(0);
		expect(withNormals).toBe(withFaceIds);

		console.log(JSON.stringify({ seconds: Number(seconds.toFixed(1)), solids: result.solids, bodies, triangles: result.triangles, glbBytes: result.glb.length, unit: result.unit, warnings: result.warnings, ms: result.ms }));
	}, 900_000);
});

/** A converter that reads any file into `solids` solids, or traps in the transfer when `trap` is given. */
function fakeConverter(solids: number, trap?: string) {
	const calls: string[] = [];
	const unused = () => {
		throw new Error('not expected in this test');
	};
	const wasm: WasmConverter = {
		abi: 2,
		read: () => void calls.push('read'),
		transfer: () => {
			calls.push('transfer');
			if (trap) throw new WebAssembly.RuntimeError(trap);
			return { solids };
		},
		tree: unused,
		mesh: unused,
		meshTriangles: unused,
		geometry: unused,
		warnings: () => [],
		setOptions: () => {},
		release: unused,
		close: () => void calls.push('close'),
		memoryBytes: () => 0
	};
	return { wasm, calls };
}

/** The message the page shows for a conversion that failed. */
async function shownFor(wasm: WasmConverter) {
	const failure = await convertStep(wasm, new Uint8Array(), 'test.step', { onProgress: () => {}, yieldToHost: async () => {} }).catch((err) => err);
	return explainLoadError(failure);
}

describe('a conversion that fails', () => {
	it('says a file without shapes holds none, rather than opening an empty view', async () => {
		const { wasm, calls } = fakeConverter(0);
		expect(await shownFor(wasm)).toEqual({ message: 'This file holds no solids or surfaces, so there is nothing to show.' });
		expect(calls).toEqual(['read', 'transfer', 'close']);
	});

	it('puts a trap down to the converter, without calling the file damaged', async () => {
		const { wasm, calls } = fakeConverter(1, 'null function');
		expect(await shownFor(wasm)).toEqual({ message: 'The converter failed on this file (null function).' });
		expect(calls).toEqual(['read', 'transfer', 'close']);
	});
});
