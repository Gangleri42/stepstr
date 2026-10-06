import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MEASURE_VERSION, type MeasureData, type SolidRecord } from '$lib/measure/format';
import { indexParts } from '../parts';
import { Topology } from './data';

const solid = (tol: number): SolidRecord => ({ tol, p: [], e: [], f: [] });
const data: MeasureData = { v: MEASURE_VERSION, units: 'mm', glb: 'a'.repeat(64), solids: [solid(1), solid(2)] };

/** One occurrence per body, each body drawn by one primitive, with the given extras. */
function topology(...bodies: Record<string, unknown>[]) {
	const root = new THREE.Group();
	bodies.forEach((extras, i) => {
		const occurrence = new THREE.Group();
		occurrence.userData.id = `o${i}`;
		const mesh = new THREE.Mesh(new THREE.BufferGeometry());
		Object.assign(mesh.userData, { id: `b${i}`, body: true }, extras);
		root.add(occurrence.add(mesh));
	});
	return new Topology(data, indexParts(root));
}

describe('measurement topology', () => {
	it("finds a body's solid by the index its extras name", () => {
		const t = topology({ solid: 1 }, { solid: 0 });
		expect(t.solid(t.body('b0')!)?.tol).toBe(2);
		expect(t.solid(t.body('b1')!)?.tol).toBe(1);
	});

	it('has no solid for a body without one, or one the data does not hold', () => {
		const t = topology({}, { solid: 2 });
		expect(t.solid(t.body('b0')!)).toBeNull();
		expect(t.solid(t.body('b1')!)).toBeNull();
	});
});
