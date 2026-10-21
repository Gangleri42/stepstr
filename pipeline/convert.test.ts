// The Node conversion against the browser's (test/golden.json holds what the browser path makes of the same file), and
// the published files against what the viewer and Measure read from them.
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { gltfLoader } from '../src/lib/viewer/gltf.ts';
import golden from '../test/golden.json' with { type: 'json' };
import { fixtureBytes, fixtureFile, FIXTURES } from '../test/fixtures.ts';
import { CONVERTER, lacking } from '../test/prerequisites.ts';
import { about } from './about.ts';
import { convert, publishable, WASM, type Converted, type Published } from './convert.ts';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const skip = lacking({ ...CONVERTER, path: WASM }, fixtureFile('seed-v15'));

async function parse(glb: Uint8Array) {
	// The viewer's own loader, which opens compressed and uncompressed GLBs alike.
	const { scene } = await gltfLoader().parseAsync(glb.slice().buffer, '');
	// As the viewer has it: the root's glTF scale and turn dropped, so world coordinates are the file's, in mm.
	const root = scene.children[0];
	root.position.set(0, 0, 0);
	root.quaternion.identity();
	root.scale.set(1, 1, 1);
	scene.updateMatrixWorld(true);
	return scene;
}

/** Each triangle mesh by its body's id, with its face ids sorted (the compression reorders vertices) and its extent. */
function bodies(scene: THREE.Object3D) {
	const found = new Map<string, { faces: number[]; size: number[] }[]>();
	scene.traverse((object) => {
		const mesh = object as THREE.Mesh;
		if (!mesh.isMesh) return;
		const id = String(mesh.userData.id ?? mesh.parent?.userData.id);
		// Element by element: in the uncompressed GLB an attribute's array runs on past its own elements.
		const ids = mesh.geometry.getAttribute('_faceid');
		const faces = Array.from({ length: ids.count }, (_, i) => ids.getX(i)).sort((a, b) => a - b);
		mesh.geometry.computeBoundingBox();
		const box = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
		const size = box.max.clone().sub(box.min).toArray();
		found.set(id, [...(found.get(id) ?? []), { faces, size }]);
	});
	return found;
}

describe.skipIf(skip)('a STEP file converted in Node', () => {
	let converted: Converted;
	let published: Published;

	it('makes the GLB and measurement data the browser makes', async () => {
		converted = await convert(fixtureBytes('seed-v15')!, FIXTURES['seed-v15'].file);
		expect(sha256(converted.glb)).toBe(golden['seed-v15'].glb);
		expect(sha256(new TextEncoder().encode(JSON.stringify(converted.measure)))).toBe(golden['seed-v15'].measure);
	}, 300_000);

	it('publishes a compressed GLB that keeps every part id, face id and size', async () => {
		published = await publishable(fixtureBytes('seed-v15')!, converted);
		const json = JSON.parse(new TextDecoder().decode(published.glb.subarray(20, 20 + new DataView(published.glb.buffer).getUint32(12, true))));
		expect(json.extensionsRequired).toEqual(expect.arrayContaining(['EXT_meshopt_compression', 'KHR_mesh_quantization']));
		expect(published.glb.length).toBeLessThan(converted.glb.length / 2);

		const [before, after] = await Promise.all([parse(converted.glb), parse(published.glb)]);
		const ids = (scene: THREE.Object3D) => {
			const all: string[] = [];
			scene.traverse((object) => object.userData.id !== undefined && all.push(object.userData.id));
			return all.sort();
		};
		expect(ids(after)).toEqual(ids(before));
		const [was, is] = [bodies(before), bodies(after)];
		expect([...is.keys()].sort()).toEqual([...was.keys()].sort());
		for (const [id, meshes] of was) {
			const now = is.get(id)!;
			expect(now.map((m) => m.faces)).toEqual(meshes.map((m) => m.faces));
			// Within a step of the 16-bit grid: a thousandth of a millimetre on parts this size.
			for (const [i, mesh] of meshes.entries()) for (const [k, v] of mesh.size.entries()) expect(now[i].size[k]).toBeCloseTo(v, 2);
		}
	});

	it('keeps all the measurement data, naming the published GLB', () => {
		const measure = gunzipSync(published.measure).toString('utf8');
		expect(measure).toBe(JSON.stringify({ ...converted.measure, glb: sha256(published.glb) }));
		expect(published.summary).toEqual({
			conversion: about(WASM).conversion,
			step: { sha256: FIXTURES['seed-v15'].sha256, size: FIXTURES['seed-v15'].size },
			glb: { sha256: sha256(published.glb), size: published.glb.length },
			measure: { sha256: sha256(published.measure), size: published.measure.length },
			solids: golden['seed-v15'].solids,
			triangles: golden['seed-v15'].triangles,
			warnings: golden['seed-v15'].warnings
		});
	});
});
