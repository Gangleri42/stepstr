import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import { beforeAll, describe, expect, it } from 'vitest';
import { creaseNormals, exactShading, splitByFace, weld } from './geometry.ts';

/** A flat n × n grid over [0, 10]² at z = 0: face 0 left of x = 5, face 1 right of it. */
function grid(n: number) {
	const positions: number[] = [], indices: number[] = [], faces: number[] = [];
	for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) positions.push((10 * i) / n, (10 * j) / n, 0);
	for (let j = 0; j < n; j++) {
		for (let i = 0; i < n; i++) {
			const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
			const face = i < n / 2 ? 0 : 1;
			indices.push(a, b, d, a, d, c);
			faces.push(face, face);
		}
	}
	return { positions: new Float32Array(positions), indices: new Uint32Array(indices), faces: new Uint32Array(faces) };
}

/** Whether every triangle's corners carry one face id, and which ids occur. */
function faceCheck(indices: ArrayLike<number>, faces: ArrayLike<number>) {
	const seen = new Set<number>();
	let mixed = 0;
	for (let i = 0; i < indices.length; i += 3) {
		const f = faces[indices[i]];
		if (faces[indices[i + 1]] !== f || faces[indices[i + 2]] !== f) mixed++;
		seen.add(f);
	}
	return { mixed, faces: [...seen].sort() };
}

beforeAll(async () => {
	await MeshoptSimplifier.ready;
});

describe('face ids through the pipeline', () => {
	it('gives a border vertex one copy per face and shares no vertex between faces', () => {
		const { positions, indices, faces } = grid(4);
		const split = splitByFace(positions, indices, faces);
		// 25 grid points, the 5 on x = 5 twice.
		expect(split.positions.length / 3).toBe(30);
		expect(faceCheck(split.indices, split.faces)).toEqual({ mixed: 0, faces: [0, 1] });
		for (let i = 0; i < split.indices.length; i++) expect(split.faces[split.indices[i]]).toBe(faces[(i / 3) | 0]);
	});

	it('keeps the simplifier from merging two faces, even at a coarse error', () => {
		const { positions, indices, faces } = grid(20);
		const welded = weld(positions, indices);
		const split = splitByFace(welded.positions, welded.indices, faces);
		const [simplified] = MeshoptSimplifier.simplify(split.indices, split.positions, 3, 3, 1, ['ErrorAbsolute']);
		expect(simplified.length).toBeLessThan(split.indices.length);
		expect(faceCheck(simplified, split.faces)).toEqual({ mixed: 0, faces: [0, 1] });
	});

	it('shades and draws a smooth border between faces like the inside of a face', () => {
		const { positions, indices, faces } = grid(4);
		const split = splitByFace(positions, indices, faces);
		const geometry = creaseNormals(split.positions, split.indices, split.faces);
		for (let i = 0; i < geometry.normals.length; i += 3) expect([...geometry.normals.subarray(i, i + 3)]).toEqual([0, 0, 1]);
		expect(faceCheck(geometry.indices, geometry.faces).mixed).toBe(0);
		// Edges run along the outer border only: 16 segments, none of them on x = 5 between y = 0 and 10.
		expect(geometry.edges.length / 2).toBe(16);
		for (let e = 0; e < geometry.edges.length; e += 2) {
			const [a, b] = [geometry.edges[e], geometry.edges[e + 1]];
			const onInnerLine = geometry.positions[a * 3] === 5 && geometry.positions[b * 3] === 5 && geometry.positions[a * 3 + 1] % 10 !== 0;
			expect(onInnerLine).toBe(false);
		}
	});

	it('draws the crease between two faces at a right angle', () => {
		// A floor (face 0) and a wall (face 1) that meet along the y axis.
		const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1]);
		const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 0, 3, 5, 0, 5, 4]);
		const split = splitByFace(positions, indices, new Uint32Array([0, 0, 1, 1]));
		const geometry = creaseNormals(split.positions, split.indices, split.faces);
		const edges = new Set<string>();
		for (let e = 0; e < geometry.edges.length; e += 2) {
			const ends = [geometry.edges[e], geometry.edges[e + 1]].map((v) => [...geometry.positions.subarray(v * 3, v * 3 + 3)].join(','));
			edges.add(ends.sort().join(' '));
		}
		expect(edges.has('0,0,0 0,1,0')).toBe(true);
	});

	it('carries each node\'s exact normal through the weld to the copy on its own face', () => {
		// Two faces meeting at x = 5 with different normals on each side; welding merges the shared nodes.
		const { positions, indices, faces } = grid(2);
		const normals = new Float32Array(positions.length);
		for (let v = 0; v < positions.length / 3; v++) normals.set(positions[v * 3] <= 5 ? [0, 0, 1] : [0, 1, 0], v * 3);
		// Duplicate the x = 5 nodes for the right face, as the converter does (nodes are never shared between faces).
		const pos = [...positions], nor = [...normals];
		const idx = [...indices];
		for (let i = 0; i < idx.length; i++) {
			if (faces[(i / 3) | 0] === 1 && positions[idx[i] * 3] === 5) {
				pos.push(...positions.subarray(idx[i] * 3, idx[i] * 3 + 3));
				nor.push(0, 1, 0);
				idx[i] = pos.length / 3 - 1;
			}
		}
		const source = new Uint32Array(idx);
		const welded = weld(new Float32Array(pos), source);
		const split = splitByFace(welded.positions, welded.indices, faces, { values: new Float32Array(nor), source });
		for (let v = 0; v < split.faces.length; v++) {
			expect([...split.normals!.subarray(v * 3, v * 3 + 3)]).toEqual(split.faces[v] === 0 ? [0, 0, 1] : [0, 1, 0]);
		}
	});

	it('keeps face ids above 65535', () => {
		const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
		const split = splitByFace(positions, new Uint32Array([0, 1, 2]), new Uint32Array([70000]));
		expect([...split.faces]).toEqual([70000, 70000, 70000]);
	});

	it('keeps exact normals and still draws the crease between two faces', () => {
		const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1]);
		const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 0, 3, 5, 0, 5, 4]);
		const split = splitByFace(positions, indices, new Uint32Array([0, 0, 1, 1]));
		const normals = new Float32Array(split.faces.length * 3);
		for (let v = 0; v < split.faces.length; v++) normals.set(split.faces[v] === 0 ? [0, 0, 1] : [1, 0, 0], v * 3);
		const geometry = exactShading(split.positions, normals, split.indices, split.faces);
		expect(geometry.normals).toBe(normals);
		const edges = new Set<string>();
		for (let e = 0; e < geometry.edges.length; e += 2) {
			const ends = [geometry.edges[e], geometry.edges[e + 1]].map((v) => [...geometry.positions.subarray(v * 3, v * 3 + 3)].join(','));
			edges.add(ends.sort().join(' '));
		}
		expect(edges.has('0,0,0 0,1,0')).toBe(true);
	});

	it('draws no edge inside one face, however its triangles lean, when the normals are exact', () => {
		// The floor and wall above as one face: a sliver the simplifier left on a curved face folds like this.
		const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1]);
		const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 0, 3, 5, 0, 5, 4]);
		const split = splitByFace(positions, indices, new Uint32Array([0, 0, 0, 0]));
		// The normals play no part in the edges.
		const geometry = exactShading(split.positions, new Float32Array(split.faces.length * 3), split.indices, split.faces);
		const edges = new Set<string>();
		for (let e = 0; e < geometry.edges.length; e += 2) {
			const ends = [geometry.edges[e], geometry.edges[e + 1]].map((v) => [...geometry.positions.subarray(v * 3, v * 3 + 3)].join(','));
			edges.add(ends.sort().join(' '));
		}
		expect(edges.has('0,0,0 0,1,0')).toBe(false);
		// The open border all round: three sides of the floor, three of the wall.
		expect(edges.size).toBe(6);
	});
});
