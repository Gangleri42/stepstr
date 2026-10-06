// Pure mesh helpers: weld, split per B-rep face, normals and feature edges. Units are mm.

/** Two triangles whose normals differ by more than 30 degrees form a crease: an edge, and a break in the shading. */
const CREASE = Math.cos((30 * Math.PI) / 180);

/** The cosine of the angle between triangles s and t, from their unit normals. */
const cosine = (unit: Float32Array, s: number, t: number) => unit[s * 3] * unit[t * 3] + unit[s * 3 + 1] * unit[t * 3 + 1] + unit[s * 3 + 2] * unit[t * 3 + 2];

/** `faces` holds each vertex's B-rep face id; no vertex is shared by two faces. */
export type Geometry = { positions: Float32Array; normals: Float32Array; indices: Uint32Array; edges: Uint32Array; faces: Uint32Array };

/** Merges nodes at the same position (1e-4 mm) so the simplifier sees a closed surface. */
export function weld(positions: Float32Array, indices: Uint32Array) {
	const map = new Map<string, number>();
	const remap = new Uint32Array(positions.length / 3);
	const out: number[] = [];
	for (let i = 0; i < remap.length; i++) {
		const k = `${Math.round(positions[i * 3] * 1e4)},${Math.round(positions[i * 3 + 1] * 1e4)},${Math.round(positions[i * 3 + 2] * 1e4)}`;
		let j = map.get(k);
		if (j === undefined) {
			j = out.length / 3;
			map.set(k, j);
			out.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
		}
		remap[i] = j;
	}
	const welded = indices.map((i) => remap[i]);
	return { positions: new Float32Array(out), indices: welded };
}

/**
 * Gives every (vertex, face) pair its own vertex, so no vertex is shared by two B-rep faces. The simplifier then treats
 * face borders as seams, which it keeps, and every triangle it returns lies on one face.
 *
 * `normals` carries per-node normals of the unwelded mesh (`source` holds the corners' node indices before welding):
 * each output vertex takes the normal of a node on its own face, so exact normals survive the weld.
 */
export function splitByFace(
	positions: Float32Array,
	indices: Uint32Array,
	triangleFaces: Uint32Array,
	normals?: { values: Float32Array; source: Uint32Array }
) {
	let stride = 1;
	for (const face of triangleFaces) if (face >= stride) stride = face + 1;
	const map = new Map<number, number>();
	const out: number[] = [];
	const faces: number[] = [];
	const outNormals: number[] = [];
	const split = new Uint32Array(indices.length);
	for (let i = 0; i < indices.length; i++) {
		const v = indices[i], face = triangleFaces[(i / 3) | 0];
		const key = v * stride + face;
		let j = map.get(key);
		if (j === undefined) {
			j = faces.length;
			map.set(key, j);
			out.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
			faces.push(face);
			if (normals) {
				const n = normals.source[i] * 3;
				outNormals.push(normals.values[n], normals.values[n + 1], normals.values[n + 2]);
			}
		}
		split[i] = j;
	}
	return {
		positions: new Float32Array(out),
		indices: split,
		faces: Uint32Array.from(faces),
		normals: normals ? new Float32Array(outNormals) : null
	};
}

/** Triangle normals, both area-weighted and unit length. */
function triangleNormals(positions: Float32Array, indices: Uint32Array) {
	const triCount = indices.length / 3;
	const weighted = new Float32Array(triCount * 3);
	const unit = new Float32Array(triCount * 3);
	for (let t = 0; t < triCount; t++) {
		const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
		const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
		const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
		const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
		const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
		weighted[t * 3] = nx; weighted[t * 3 + 1] = ny; weighted[t * 3 + 2] = nz;
		unit[t * 3] = nx / len; unit[t * 3 + 1] = ny / len; unit[t * 3 + 2] = nz / len;
	}
	return { weighted, unit };
}

/** Numbers each distinct position, so the per-face copies of a vertex count once: the number at every corner, and the count. */
function cornersByPosition(positions: Float32Array, indices: Uint32Array) {
	const byPosition = new Map<string, number>();
	const canon = new Uint32Array(positions.length / 3);
	let vertexCount = 0;
	for (let v = 0; v < canon.length; v++) {
		const key = `${positions[v * 3]},${positions[v * 3 + 1]},${positions[v * 3 + 2]}`;
		let c = byPosition.get(key);
		if (c === undefined) byPosition.set(key, (c = vertexCount++));
		canon[v] = c;
	}
	return { corner: indices.map((v) => canon[v]), vertexCount };
}

/**
 * Feature edges of the welded mesh: a crease sharper than 30 degrees between two triangles, or a border with only one.
 * With `faceOf`, a triangle's B-rep face, only creases between two faces count. Returns pairs of corner numbers (see
 * cornersByPosition).
 */
function creases(corner: Uint32Array, vertexCount: number, unit: Float32Array, faceOf?: (triangle: number) => number) {
	const edgeTris = new Map<number, number[]>();
	for (let t = 0; t < corner.length / 3; t++) {
		for (let e = 0; e < 3; e++) {
			const a = corner[t * 3 + e], b = corner[t * 3 + ((e + 1) % 3)];
			const k = Math.min(a, b) * vertexCount + Math.max(a, b);
			const list = edgeTris.get(k);
			if (list) list.push(t);
			else edgeTris.set(k, [t]);
		}
	}
	const pairs: number[] = [];
	for (const [k, tris] of edgeTris) {
		if (tris.length === 2 && cosine(unit, tris[0], tris[1]) >= CREASE) continue;
		if (tris.length === 2 && faceOf && faceOf(tris[0]) === faceOf(tris[1])) continue;
		pairs.push(Math.floor(k / vertexCount), k % vertexCount);
	}
	return pairs;
}

/** Edge endpoints as output vertices: the first copy of each welded vertex the triangles use. */
function edgeVertices(pairs: number[], corner: Uint32Array, outIndices: Uint32Array, vertexCount: number) {
	const firstCopy = new Int32Array(vertexCount).fill(-1);
	for (let i = 0; i < corner.length; i++) if (firstCopy[corner[i]] < 0) firstCopy[corner[i]] = outIndices[i];
	return new Uint32Array(pairs.map((v) => firstCopy[v]));
}

/**
 * Splits vertices along creases sharper than 30 degrees and collects those creases (plus open borders) as edges.
 * Neighbours are found by position, so a smooth border between two faces shades and draws like the inside of a face;
 * an output vertex never serves two faces. For meshes without exact normals.
 */
export function creaseNormals(positions: Float32Array, indices: Uint32Array, vertexFaces?: Uint32Array): Geometry {
	const { weighted, unit } = triangleNormals(positions, indices);
	const { corner, vertexCount } = cornersByPosition(positions, indices);

	const start = new Uint32Array(vertexCount + 1);
	for (const v of corner) start[v + 1]++;
	for (let v = 0; v < vertexCount; v++) start[v + 1] += start[v];
	const fill = start.slice(0, vertexCount);
	const incident = new Uint32Array(corner.length);
	for (let i = 0; i < corner.length; i++) incident[fill[corner[i]]++] = (i / 3) | 0;

	const outPos: number[] = [], outNor: number[] = [], outFace: number[] = [];
	const outIdx = new Uint32Array(indices.length);
	const seen = new Map<string, number>();
	for (let i = 0; i < indices.length; i++) {
		const t = (i / 3) | 0, v = corner[i], face = vertexFaces?.[indices[i]] ?? 0;
		let nx = 0, ny = 0, nz = 0;
		for (let k = start[v]; k < start[v + 1]; k++) {
			const s = incident[k];
			if (cosine(unit, s, t) < CREASE) continue;
			nx += weighted[s * 3]; ny += weighted[s * 3 + 1]; nz += weighted[s * 3 + 2];
		}
		const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
		nx /= len; ny /= len; nz /= len;
		const k = `${v}:${face}:${Math.round(nx * 500)},${Math.round(ny * 500)},${Math.round(nz * 500)}`;
		let j = seen.get(k);
		if (j === undefined) {
			j = outPos.length / 3;
			seen.set(k, j);
			const p = indices[i];
			outPos.push(positions[p * 3], positions[p * 3 + 1], positions[p * 3 + 2]);
			outNor.push(nx, ny, nz);
			outFace.push(face);
		}
		outIdx[i] = j;
	}
	const edges = edgeVertices(creases(corner, vertexCount, unit), corner, outIdx, vertexCount);
	return { positions: new Float32Array(outPos), normals: new Float32Array(outNor), indices: outIdx, edges, faces: Uint32Array.from(outFace) };
}

/**
 * Keeps the exact surface normals the converter measured at every node, so shading is smooth however coarse the
 * triangles are, and adds feature edges where two faces meet at a crease, or at a border.
 *
 * No edge is drawn inside one face, even where neighbouring triangles meet at more than 30 degrees: slivers the
 * simplifier leaves on small curved faces (corners on the surface, normals leaning) and the coarse facets of heavy
 * solids such as coils. Drawing them put black hairlines across tyres, screw heads and springs. The cost is a true
 * crease inside one face (a kinked surface, a profile of straight segments kept as one face), which gets no line.
 */
export function exactShading(positions: Float32Array, normals: Float32Array, indices: Uint32Array, faces: Uint32Array): Geometry {
	const { unit } = triangleNormals(positions, indices);
	const { corner, vertexCount } = cornersByPosition(positions, indices);
	const edges = edgeVertices(creases(corner, vertexCount, unit, (t) => faces[indices[t * 3]]), corner, indices, vertexCount);
	return { positions, normals, indices, edges, faces };
}
