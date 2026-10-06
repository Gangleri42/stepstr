// Turns a converter's output (the assembly tree, one mesh and the exact geometry per solid) into the viewer's GLB and
// measurement data. Runs in a page, a Worker, a napplet or Node: everything that reads or writes comes in through
// `source` and `options`.
//
// The GLB keeps the CAD occurrence tree. Geometry is in millimetres, Z up; the root node carries the glTF-conventional
// scale and rotation, which the viewer resets so its world frame equals the CAD frame.
import { Document, Primitive, type Material, type Mesh, type Node, type Transform, type TypedArray, type mat4 } from '@gltf-transform/core';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import type { MeasureData } from '../measure/format.ts';
import { creaseNormals, exactShading, splitByFace, weld, type Geometry } from './geometry.ts';
import { partId } from './ids.ts';
import { assembleMeasure, measureRecord, type MeasureStats, type RawSolid, type SolidMesh } from './measure.ts';

export type Appearance = [string, string, unknown][];
export type Occurrence = { path: string; parent: string | null; name: string; component: string; linked?: boolean; matrix: number[] };
export type Manifest = {
	doc: string;
	units?: 'mm';
	occurrences: Occurrence[];
	bodies: { occ: string | null; body: string; mesh: number; appearance: string | null }[];
	meshes: { component: string; body: string }[];
	appearances: Record<string, Appearance>;
	fastener_partners?: Record<string, string>;
};

/** One solid as tessellated: nodes are not shared between faces, triangles come grouped by colour. */
export type RawMesh = {
	positions: Float32Array;
	indices: Uint32Array;
	faceIds: Uint32Array;
	/** Unit normals of the exact surface per node, or null to derive them from the triangles. */
	normals: Float32Array | null;
	/** appearance null is the body's own colour. */
	groups: { appearance: string | null; triangles: number }[];
	/** The linear deflection it was tessellated with, mm. */
	deflection: number;
};

export type ModelSource = {
	manifest: Manifest;
	mesh(index: number): RawMesh | Promise<RawMesh>;
	geometry(index: number): RawSolid | null | Promise<RawSolid | null>;
};

export type BuildOptions = {
	title: string;
	/** Largest deviation the simplifier may introduce in a solid, mm. */
	simplifyError(mesh: number): number;
	fastener?(occurrence: Occurrence): boolean;
	writeGlb(doc: Document): Promise<Uint8Array>;
	sha256(bytes: Uint8Array): string | Promise<string>;
	/** Called between solids, so a caller on the main thread can give the page a turn. */
	yield?(): Promise<void>;
	onProgress?(done: number, total: number): void;
	/** Throw where the lenient path would only warn: the pipeline's own tests. */
	strict?: boolean;
};

export type BuildResult = {
	glb: Uint8Array;
	measure: MeasureData;
	bodies: number;
	trianglesIn: number;
	trianglesOut: number;
	measureStats: MeasureStats;
	warnings: string[];
};

type Group = { appearance: string | null; geometry: Geometry };
type Solid = { groups: Group[]; mesh: SolidMesh };

const srgbToLinear = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

type Mat4 = number[];
/** A row-major CAD matrix as a glTF column-major matrix. */
function toColumnMajor(m: number[]): Mat4 {
	const out = new Array(16);
	for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[c * 4 + r] = m[r * 4 + c];
	return out;
}
/** Inverse of an affine column-major matrix. */
function invertAffine(m: Mat4): Mat4 {
	const [a, b, c, d, e, f, g, h, i] = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
	const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
	const det = a * A + b * B + c * C;
	const inv = [A, c * h - b * i, b * f - c * e, B, a * i - c * g, c * d - a * f, C, b * g - a * h, a * e - b * d].map((v) => v / det);
	const out = [inv[0], inv[3], inv[6], 0, inv[1], inv[4], inv[7], 0, inv[2], inv[5], inv[8], 0, 0, 0, 0, 1];
	for (let r = 0; r < 3; r++) out[12 + r] = -(out[r] * m[12] + out[4 + r] * m[13] + out[8 + r] * m[14]);
	return out;
}
function multiply(a: Mat4, b: Mat4): Mat4 {
	const out = new Array(16).fill(0);
	for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
	return out;
}
/** False for a placement that scales or shears: its axes are not unit length and square to each other. */
function rigid(m: Mat4) {
	const col = (c: number) => [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]];
	const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
	for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (Math.abs(dot(col(i), col(j)) - (i === j ? 1 : 0)) > 1e-6) return false;
	return true;
}
/** The vertices the triangles use, renumbered from 0, with their face ids and normals. */
function compact(positions: Float32Array, indices: number[], faces: Uint32Array, normals: Float32Array | null) {
	const remap = new Map<number, number>();
	const out: number[] = [];
	const outNormals: number[] = [];
	const outFaces: number[] = [];
	const outIndices = new Uint32Array(indices.length);
	indices.forEach((v, i) => {
		let j = remap.get(v);
		if (j === undefined) {
			remap.set(v, (j = outFaces.length));
			out.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
			if (normals) outNormals.push(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
			outFaces.push(faces[v]);
		}
		outIndices[i] = j;
	});
	return {
		positions: new Float32Array(out),
		normals: normals ? new Float32Array(outNormals) : null,
		indices: outIndices,
		faces: Uint32Array.from(outFaces)
	};
}

export async function buildModel(source: ModelSource, options: BuildOptions): Promise<BuildResult> {
	await MeshoptSimplifier.ready;
	const { manifest } = source;
	const stats = { trianglesIn: 0, trianglesOut: 0, bodies: 0 };
	const warnings: string[] = [];
	const warn = (message: string) => {
		if (options.strict) throw new Error(message);
		warnings.push(message);
	};

	/**
	 * The solid's triangles: welded, split per B-rep face and simplified once, then cut into its colour groups. Face
	 * borders are seams to the simplifier, so every triangle stays on one face and neighbouring faces (and colours)
	 * keep meeting without cracks. Exact normals from the converter survive all of it; without them, crease normals.
	 */
	function solidOf(idx: number, raw: RawMesh): Solid {
		const { positions } = raw;
		stats.trianglesIn += raw.indices.length / 3;
		const entry = manifest.meshes[idx];
		const error = options.simplifyError(idx);

		// Faces carry their colour, so each face belongs to one colour group.
		const groupOf = new Map<number, number>();
		let start = 0;
		raw.groups.forEach(({ triangles }, g) => {
			for (let t = start; t < start + triangles; t++) groupOf.set(raw.faceIds[t], g);
			start += triangles;
		});

		const welded = weld(positions, raw.indices);
		const normals = raw.normals ? { values: raw.normals, source: raw.indices } : undefined;
		const split = splitByFace(welded.positions, welded.indices, raw.faceIds, normals);
		// Not 'Permissive', the one mode that may collapse a vertex across a seam onto another face.
		let [simplified] = MeshoptSimplifier.simplify(split.indices, split.positions, 3, 3, error, ['ErrorAbsolute']);
		for (let i = 0; i < simplified.length; i += 3) {
			const face = split.faces[simplified[i]];
			if (split.faces[simplified[i + 1]] !== face || split.faces[simplified[i + 2]] !== face) {
				warn(`${entry.body}: a simplified triangle spans two faces; the solid keeps its full tessellation`);
				simplified = split.indices;
				break;
			}
		}
		const groups: Group[] = [];
		raw.groups.forEach(({ appearance }, g) => {
			const picked: number[] = [];
			for (let i = 0; i < simplified.length; i += 3) {
				if (groupOf.get(split.faces[simplified[i]]) === g) picked.push(simplified[i], simplified[i + 1], simplified[i + 2]);
			}
			if (!picked.length) return;
			const part = compact(split.positions, picked, split.faces, split.normals);
			const geometry = part.normals
				? exactShading(part.positions, part.normals, part.indices, part.faces)
				: creaseNormals(part.positions, part.indices, part.faces);
			groups.push({ appearance, geometry });
		});
		const original = { positions, indices: raw.indices, faces: raw.faceIds };
		return { groups, mesh: { positions: split.positions, indices: simplified, faces: split.faces, original, error, deflection: raw.deflection } };
	}

	const solids: Solid[] = [];
	for (let idx = 0; idx < manifest.meshes.length; idx++) {
		solids.push(solidOf(idx, await source.mesh(idx)));
		options.onProgress?.(idx + 1, manifest.meshes.length);
		await options.yield?.();
	}

	const doc = new Document();
	const buffer = doc.createBuffer();
	const edgeMaterial = doc.createMaterial('edges').setBaseColorFactor([0, 0, 0, 1]).setExtras({ kind: 'edges' });
	const materials = new Map<string, Material>();
	const meshes = new Map<string, Mesh>();

	function makeMaterial(name: string | null): Material {
		const props = new Map((name ? manifest.appearances[name] : []).map(([id, , value]) => [id, value]));
		const model = props.get('interior_model') as number | undefined;
		const colorOf = (id: string): [number, number, number] | null => {
			const c = props.get(id) as number[] | undefined;
			return c ? [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])] : null;
		};
		const color = colorOf('metal_f0') ?? colorOf('transparent_color') ?? colorOf('opaque_albedo') ?? [0.5, 0.5, 0.5];
		const kind = model === 1 ? 'metal' : model === 3 ? 'glass' : 'opaque';
		const roughness = (props.get('surface_roughness') as number | undefined) ?? 0.5;
		const material = doc.createMaterial(name ?? 'default')
			.setRoughnessFactor(Math.max(roughness, 0.05)).setDoubleSided(false);
		if (kind === 'metal') material.setMetallicFactor(1).setBaseColorFactor([...color, 1]);
		else if (kind === 'glass') {
			// Opacity follows how dark the tint is, so clear glass nearly vanishes and tinted glass stays dark.
			const luminance = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
			material.setMetallicFactor(0).setBaseColorFactor([...color, 0.1 + 0.6 * (1 - luminance)]).setAlphaMode('BLEND');
		}
		else material.setMetallicFactor(0).setBaseColorFactor([...color, 1]);
		material.setExtras({ appearance: name, kind });
		return material;
	}

	function materialFor(name: string | null) {
		const key = String(name);
		let material = materials.get(key);
		if (!material) materials.set(key, (material = makeMaterial(name)));
		return material;
	}

	const accessor = (type: 'VEC3' | 'SCALAR', array: Float32Array | Uint32Array | Uint16Array) =>
		doc.createAccessor().setType(type).setArray(array as TypedArray).setBuffer(buffer);

	/** The B-rep face of each vertex, for the Measure tool: 16-bit integers when they fit, exact floats otherwise. */
	function faceIdArray(faces: Uint32Array) {
		let max = 0;
		for (const f of faces) if (f > max) max = f;
		return max <= 0xffff ? Uint16Array.from(faces) : Float32Array.from(faces);
	}

	function meshFor(idx: number, appearance: string | null): Mesh | null {
		const key = `${idx}|${appearance}`;
		const made = meshes.get(key);
		if (made) return made;
		const solid = solids[idx];
		if (!solid.groups.length) return null;
		const mesh = doc.createMesh(manifest.meshes[idx].body);
		for (const { appearance: own, geometry } of solid.groups) {
			// Faces in the body's own colour take the instance colour; faces with a colour of their own keep it.
			const material = own ? materialFor(own) : materialFor(appearance);
			const position = accessor('VEC3', geometry.positions);
			mesh.addPrimitive(
				doc.createPrimitive().setAttribute('POSITION', position).setAttribute('NORMAL', accessor('VEC3', geometry.normals))
					.setAttribute('_FACEID', accessor('SCALAR', faceIdArray(geometry.faces)))
					.setIndices(accessor('SCALAR', geometry.indices)).setMaterial(material)
			);
			if (geometry.edges.length) {
				mesh.addPrimitive(
					doc.createPrimitive().setMode(Primitive.Mode.LINES).setAttribute('POSITION', position)
						.setIndices(accessor('SCALAR', geometry.edges)).setMaterial(edgeMaterial)
				);
			}
		}
		meshes.set(key, mesh);
		return mesh;
	}

	const root = doc.createNode(options.title)
		.setScale([0.001, 0.001, 0.001])
		.setRotation([-Math.SQRT1_2, 0, 0, Math.SQRT1_2])
		.setExtras({ doc: manifest.doc, units: 'mm', up: 'z' });
	doc.createScene(options.title).addChild(root);

	const nodes = new Map<string | null, Node>([[null, root]]);
	const world = new Map<string, Mat4>();
	for (const occ of manifest.occurrences) {
		const w = toColumnMajor(occ.matrix);
		if (!rigid(w)) warnings.push(`${occ.path}: its placement scales or shears, so lengths measured in it are off`);
		world.set(occ.path, w);
		const local = occ.parent ? multiply(invertAffine(world.get(occ.parent)!), w) : w;
		const fastener = occ.path in (manifest.fastener_partners ?? {}) || (options.fastener?.(occ) ?? false);
		const node = doc.createNode(occ.name).setMatrix(local as mat4).setExtras({
			id: partId(occ.path), name: occ.name, component: occ.component, linked: occ.linked ?? false, fastener
		});
		nodes.get(occ.parent)!.addChild(node);
		nodes.set(occ.path, node);
	}
	for (const body of manifest.bodies) {
		const mesh = meshFor(body.mesh, body.appearance);
		if (!mesh) continue;
		const path = `${body.occ ?? ''}/${body.body}`;
		// `solid` names the body's entry in the measurement data.
		const extras = { id: partId(path), name: body.body, body: true, solid: body.mesh };
		nodes.get(body.occ)!.addChild(doc.createNode(body.body).setMesh(mesh).setExtras(extras));
		stats.bodies++;
	}
	for (const solid of solids) for (const g of solid.groups) stats.trianglesOut += g.geometry.indices.length / 3;

	const glb = await options.writeGlb(doc);
	const records = [];
	for (let idx = 0; idx < solids.length; idx++) {
		const solid = solids[idx];
		records.push(measureRecord(await source.geometry(idx), solid.groups.length ? solid.mesh : null));
	}
	const measure = assembleMeasure(records, await options.sha256(glb), options.strict);
	warnings.push(...measure.warnings);

	return {
		glb,
		measure: measure.data,
		bodies: stats.bodies,
		trianglesIn: stats.trianglesIn,
		trianglesOut: stats.trianglesOut,
		measureStats: measure.stats,
		warnings
	};
}
