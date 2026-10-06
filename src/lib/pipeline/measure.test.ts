import { describe, expect, it } from 'vitest';
import { FACE, type FaceRecord } from '../measure/format.ts';
import { assembleMeasure, measureRecord, surfaceDistance, thin, type RawSolid, type SolidMesh } from './measure.ts';

const loops = [[0]];
const face = (kind: number, ...surface: number[]): FaceRecord => [kind, 1, loops, ...surface];

describe('exact surfaces', () => {
	it.each([
		['plane z = 5', face(FACE.plane, 0, 0, 1, 5), [1, 2, 7], 2],
		['cylinder r = 3 on the z axis', face(FACE.cylinder, 0, 0, 0, 0, 0, 1, 10, 3, -1), [5, 0, 2], 2],
		['cone at 45°, a point on it', face(FACE.cone, 0, 0, 0, 0, 0, 1, Math.PI / 4, 1), [1, 0, 1], 0],
		['cone at 45°, a point behind its apex', face(FACE.cone, 0, 0, 0, 0, 0, 1, Math.PI / 4, 1), [0, 0, -1], 1],
		['sphere r = 3', face(FACE.sphere, 0, 0, 10, 3, 1), [0, 0, 0], 7],
		['torus R = 10, r = 2', face(FACE.torus, 0, 0, 0, 0, 0, 1, 10, 2, 1), [10, 0, 5], 3]
	])('measures the distance to a %s', (_name, record, [x, y, z], expected) => {
		expect(surfaceDistance(record, x, y, z)).toBeCloseTo(expected, 9);
	});

	it('has no surface for a free-form face', () => {
		expect(surfaceDistance(face(FACE.other), 0, 0, 0)).toBeNull();
	});
});

describe('polyline thinning', () => {
	it('drops points on a straight run and keeps the ends and corners', () => {
		expect(thin([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0], 0.01)).toEqual([0, 0, 0, 3, 0, 0]);
		expect(thin([0, 0, 0, 1, 0, 0, 1, 1, 0], 0.01)).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0]);
	});
});

/** A 10 × 10 square on z = 0 as two triangles, tessellated with its last vertex lifted by `lift`. */
function square(lift = 0): { raw: RawSolid; mesh: SolidMesh } {
	const positions = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, lift]);
	const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
	const raw: RawSolid = { p: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0], e: [[0, 0, 1], [0, 1, 2], [0, 2, 3], [0, 3, 0]], f: [[FACE.plane, 100, [[0, 1, 2, 3]], 0, 0, 1, 0]] };
	const mesh: SolidMesh = {
		positions,
		indices,
		faces: new Uint32Array(4),
		original: { positions, indices, faces: new Uint32Array(2) },
		error: 0.01,
		deflection: 0.01
	};
	return { raw, mesh };
}

describe('measurement data', () => {
	it('comes out the same on every run', () => {
		const { raw, mesh } = square();
		const assemble = () => assembleMeasure([measureRecord(raw, mesh)], 'ab'.repeat(32)).data;
		const data = assemble();
		expect(JSON.stringify(data)).toBe(JSON.stringify(assemble()));
		expect(data).toMatchObject({ v: 1, units: 'mm', glb: 'ab'.repeat(32) });
		const solid = data.solids[0]!;
		expect(solid.f[0]).toEqual([FACE.plane, 100, [[0, 1, 2, 3]], 0, 0, 1, 0]);
		// At least the simplify error plus the tessellation's deflection.
		expect(solid.tol).toBeGreaterThanOrEqual(0.02);
	});

	it('treats a face whose tessellation leaves its surface as free-form', () => {
		const { raw, mesh } = square(0.05);
		const { data } = assembleMeasure([measureRecord(raw, mesh)], '');
		expect(data.solids[0]!.f[0]).toEqual([FACE.other, 100, [[0, 1, 2, 3]]]);
	});

	it('warns about many faces off their surfaces, and throws in strict mode', () => {
		const { raw, mesh } = square(0.05);
		const records = Array.from({ length: 5 }, () => measureRecord(raw, mesh));
		expect(assembleMeasure(records, '').warnings).toHaveLength(1);
		expect(() => assembleMeasure(records, '', true)).toThrow(/do not lie on their surfaces/);
	});
});
