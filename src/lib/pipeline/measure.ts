// The measurement data for one model (src/lib/measure/format.ts). The converter hands over the exact geometry; this
// adds each solid's tolerance, measured against the triangles the GLB ends up with, thins free-form edges and rounds
// the numbers, so the same model gives the same file on any machine.
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { EDGE, FACE, MEASURE_VERSION, type EdgeRecord, type FaceRecord, type MeasureData, type SolidRecord } from '../measure/format.ts';

/** One solid's exact geometry as the converter writes it: full precision, no tolerance yet. */
export type RawSolid = { p: number[]; e: EdgeRecord[]; f: FaceRecord[] };

/** One solid's triangles as simplified for the GLB (a face id per vertex) and as tessellated (a face id per triangle). */
export type SolidMesh = {
	positions: Float32Array;
	indices: Uint32Array;
	faces: Uint32Array;
	original: { positions: Float32Array; indices: Uint32Array; faces: Uint32Array };
	/** The simplifier's error bound for this solid, mm. */
	error: number;
	/** The linear deflection the solid was tessellated with, mm. */
	deflection: number;
};

export type MeasureStats = { solids: number; analytic: number; demoted: number; tol: [number, number] };

/** How far a tessellation vertex may lie from its exact surface, mm; further means a wrong face id or frame. */
const FRAME_CHECK = 0.01;

const r3 = (v: number) => Number(v.toFixed(3));
const r4 = (v: number) => Number(v.toFixed(4));
const r6 = (v: number) => Number(v.toFixed(6));
const length3 = (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z);

/** Distance from a point to a face's exact (unbounded) surface, or null for a free-form face. */
export function surfaceDistance(face: FaceRecord, x: number, y: number, z: number): number | null {
	const s = face.slice(3) as number[];
	const axial = (ox: number, oy: number, oz: number, ax: number, ay: number, az: number) => {
		const vx = x - ox, vy = y - oy, vz = z - oz;
		const h = vx * ax + vy * ay + vz * az;
		return { h, rho: length3(vx - h * ax, vy - h * ay, vz - h * az), length: length3(vx, vy, vz) };
	};
	switch (face[0]) {
		case FACE.plane:
			return Math.abs(s[0] * x + s[1] * y + s[2] * z - s[3]);
		case FACE.cylinder:
			return Math.abs(axial(s[0], s[1], s[2], s[3], s[4], s[5]).rho - s[7]);
		case FACE.cone: {
			const { h, rho, length } = axial(s[0], s[1], s[2], s[3], s[4], s[5]);
			const a = s[6];
			return h * Math.cos(a) + rho * Math.sin(a) >= 0 ? Math.abs(rho * Math.cos(a) - h * Math.sin(a)) : length;
		}
		case FACE.sphere:
			return Math.abs(length3(x - s[0], y - s[1], z - s[2]) - s[3]);
		case FACE.torus: {
			const { h, rho } = axial(s[0], s[1], s[2], s[3], s[4], s[5]);
			return Math.abs(Math.sqrt(h * h + (rho - s[6]) ** 2) - s[7]);
		}
		default:
			return null;
	}
}

/** Ramer-Douglas-Peucker on a flat x, y, z list; keeps both ends. */
export function thin(points: number[], tolerance: number): number[] {
	const n = points.length / 3;
	if (n <= 2) return points;
	const keep = new Uint8Array(n);
	keep[0] = keep[n - 1] = 1;
	const stack: [number, number][] = [[0, n - 1]];
	const p = (i: number) => new THREE.Vector3(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
	const line = new THREE.Line3(), closest = new THREE.Vector3();
	while (stack.length) {
		const [a, b] = stack.pop()!;
		line.set(p(a), p(b));
		let worst = -1, far = 0;
		for (let i = a + 1; i < b; i++) {
			const point = p(i);
			const d = line.closestPointToPoint(point, true, closest).distanceTo(point);
			if (d > far) {
				far = d;
				worst = i;
			}
		}
		if (worst >= 0 && far > tolerance) {
			keep[worst] = 1;
			stack.push([a, worst], [worst, b]);
		}
	}
	return points.filter((_, i) => keep[(i / 3) | 0]);
}

/**
 * The solid's tolerance: how far the simplified triangles stray from the exact faces (at centroids and edge
 * midpoints) and how far the exact faces stray from them (at the original tessellation's vertices), never less than
 * the simplifier's error bound plus the tessellation's deflection. meshopt's own error estimate is not a bound.
 * Faces whose tessellation does not lie on their surface are demoted to free-form.
 */
function measureSolid(solid: RawSolid, mesh: SolidMesh) {
	const { original } = mesh;
	const vertex = (list: Float32Array, i: number) => [list[i * 3], list[i * 3 + 1], list[i * 3 + 2]] as const;

	const demoted = new Set<number>();
	for (let t = 0; t < original.faces.length; t++) {
		const face = solid.f[original.faces[t]];
		if (!face) continue;
		for (let k = 0; k < 3; k++) {
			const d = surfaceDistance(face, ...vertex(original.positions, original.indices[t * 3 + k]));
			if (d !== null && d > FRAME_CHECK) demoted.add(original.faces[t]);
		}
	}
	const analytic = (f: number) => solid.f[f] !== undefined && solid.f[f][0] !== FACE.other && !demoted.has(f);

	let worst = 0;
	const byFace = new Map<number, number[]>();
	for (let i = 0; i < mesh.indices.length; i += 3) {
		const f = mesh.faces[mesh.indices[i]];
		if (!analytic(f)) continue;
		const [a, b, c] = [0, 1, 2].map((k) => vertex(mesh.positions, mesh.indices[i + k]));
		const probes = [
			[(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3],
			[(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
			[(b[0] + c[0]) / 2, (b[1] + c[1]) / 2, (b[2] + c[2]) / 2],
			[(c[0] + a[0]) / 2, (c[1] + a[1]) / 2, (c[2] + a[2]) / 2]
		] as const;
		for (const q of probes) worst = Math.max(worst, surfaceDistance(solid.f[f], q[0], q[1], q[2]) ?? 0);
		let list = byFace.get(f);
		if (!list) byFace.set(f, (list = []));
		list.push(...a, ...b, ...c);
	}

	const originalByFace = new Map<number, Set<number>>();
	for (let t = 0; t < original.faces.length; t++) {
		const f = original.faces[t];
		if (!byFace.has(f)) continue;
		let set = originalByFace.get(f);
		if (!set) originalByFace.set(f, (set = new Set()));
		for (let k = 0; k < 3; k++) set.add(original.indices[t * 3 + k]);
	}
	const target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
	const probe = new THREE.Vector3();
	for (const [f, soup] of byFace) {
		const geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(soup, 3));
		const bvh = new MeshBVH(geometry);
		for (const v of originalByFace.get(f) ?? []) {
			probe.set(...vertex(original.positions, v));
			if (bvh.closestPointToPoint(probe, target)) worst = Math.max(worst, target.distance);
		}
		geometry.dispose();
	}

	const tol = Math.ceil(Math.max(worst, mesh.error + mesh.deflection) * 1000) / 1000;
	return { tol, demoted };
}

function roundEdge(edge: EdgeRecord, thinTo: number): EdgeRecord {
	if (!edge) return null;
	switch (edge[0]) {
		case EDGE.line:
			return edge;
		case EDGE.arc: {
			const [kind, a, b, ...rest] = edge;
			const [cx, cy, cz, nx, ny, nz, rx, ry, rz, radius, sweep] = rest;
			return [kind, a, b, r4(cx), r4(cy), r4(cz), r6(nx), r6(ny), r6(nz), r6(rx), r6(ry), r6(rz), r4(radius), r6(sweep)];
		}
		case EDGE.curve: {
			const [kind, a, b, length, mx, my, mz, polyline] = edge;
			return [kind, a, b, r4(length), r4(mx), r4(my), r4(mz), thin(polyline, thinTo).map(r3)];
		}
	}
}

/** Unit vectors to 1e-6, positions and lengths to 1e-4 mm, the side flag as it is. */
const SURFACE_ROUNDING: Record<number, ((v: number) => number)[]> = {
	[FACE.plane]: [r6, r6, r6, r4],
	[FACE.cylinder]: [r4, r4, r4, r6, r6, r6, r4, r4, Math.sign],
	[FACE.cone]: [r4, r4, r4, r6, r6, r6, r6, Math.sign],
	[FACE.sphere]: [r4, r4, r4, r4, Math.sign],
	[FACE.torus]: [r4, r4, r4, r6, r6, r6, r4, r4, Math.sign]
};

function roundFace(face: FaceRecord, demoted: boolean): FaceRecord {
	const [kind, area, loops, ...surface] = face;
	const rounding = demoted ? undefined : SURFACE_ROUNDING[kind];
	if (!rounding) return [FACE.other, r4(area), loops];
	return [kind, r4(area), loops, ...surface.map((v, i) => rounding[i](v))];
}

/** One solid's record for the measurement data, or null when it has no exact geometry or no triangles. */
export function measureRecord(solid: RawSolid | null, mesh: SolidMesh | null) {
	if (!solid || !mesh) return null;
	const { tol, demoted } = measureSolid(solid, mesh);
	const record: SolidRecord = {
		tol,
		p: solid.p.map(r4),
		e: solid.e.map((edge) => roundEdge(edge, mesh.error)),
		f: solid.f.map((face, f) => roundFace(face, demoted.has(f)))
	};
	return { record, analytic: solid.f.filter((f) => f[0] !== FACE.other).length, demoted: demoted.size };
}

/**
 * The measurement data for a GLB, from its solids' records. A few odd faces happen; many mean the ids or frames no
 * longer line up with the triangles, which is an error in strict mode (the pipeline's tests) and a warning otherwise.
 */
export function assembleMeasure(records: (ReturnType<typeof measureRecord>)[], glbSha256: string, strict = false) {
	const stats: MeasureStats = { solids: 0, analytic: 0, demoted: 0, tol: [Infinity, 0] };
	const warnings: string[] = [];
	const solids = records.map((entry) => {
		if (!entry) return null;
		stats.solids++;
		stats.analytic += entry.analytic;
		stats.demoted += entry.demoted;
		stats.tol = [Math.min(stats.tol[0], entry.record.tol), Math.max(stats.tol[1], entry.record.tol)];
		return entry.record;
	});
	if (stats.demoted > Math.max(3, stats.analytic * 0.01)) {
		const message = `${stats.demoted} of ${stats.analytic} faces do not lie on their surfaces: face ids or frames are off`;
		if (strict) throw new Error(message);
		warnings.push(message);
	}
	const data: MeasureData = { v: MEASURE_VERSION, units: 'mm', glb: glbSha256, solids };
	return { data, stats, warnings };
}
