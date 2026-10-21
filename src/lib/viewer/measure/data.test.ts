import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MEASURE_VERSION, type MeasureData, type SolidRecord } from '$lib/measure/format';
import { indexParts } from '../parts';
import { Topology } from './data';

const solid = (tol: number): SolidRecord => ({ tol, p: [], e: [], f: [] });
const file = (glb: string, ...solids: SolidRecord[]): MeasureData => ({ v: MEASURE_VERSION, units: 'mm', glb: glb.repeat(64), solids });
const data = [file('a', solid(1), solid(2))];

/** One occurrence per body, each body drawn by one primitive, with the given extras, over these files' data. */
function topologyOf(files: MeasureData[], ...bodies: Record<string, unknown>[]) {
	const root = new THREE.Group();
	bodies.forEach((extras, i) => {
		const occurrence = new THREE.Group();
		occurrence.userData.id = `o${i}`;
		const mesh = new THREE.Mesh(new THREE.BufferGeometry());
		Object.assign(mesh.userData, { id: `b${i}`, body: true }, extras);
		root.add(occurrence.add(mesh));
	});
	return new Topology(files, indexParts(root));
}
const topology = (...bodies: Record<string, unknown>[]) => topologyOf(data, ...bodies);

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

	it("a second file's body reads its own solid", () => {
		const t = topologyOf([...data, file('b', solid(3))], { solid: 0 }, { solid: 0, source: 1 }, { solid: 1, source: 0 });
		expect(t.solid(t.body('b0')!)?.tol).toBe(1);
		expect(t.solid(t.body('b1')!)?.tol).toBe(3);
		expect(t.solid(t.body('b2')!)?.tol).toBe(2);
	});

	it('a body whose file is missing has none', () => {
		const t = topology({ solid: 0, source: 1 });
		expect(t.solid(t.body('b0')!)).toBeNull();
	});
});
