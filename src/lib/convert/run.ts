// One STEP file through the wasm converter and the pipeline, wherever it runs: a Worker on the web, the main thread in
// a napplet (which cannot start workers). The caller supplies the yield, so a run on the main thread gives the page a
// turn between solids.
import { buildModel, type RawMesh } from '$lib/pipeline/build-model';
import { MemoryIO } from '$lib/pipeline/memory-io';
import { sha256Hex } from '$lib/source/sha256';
import { MESH_RULE, type MeshRule } from './mesh-rule';
import type { ConvertProgress, Converted, WasmConverter } from './types';

/**
 * Every solid is meshed finely enough that no facet shows (0.01 mm and 0.3 rad, loosened for very large models),
 * except the heavy ones (wire coils, springs), which stay dense at a coarser setting and would otherwise take most of
 * the time for no visible gain. MESH_RULE says how they are found.
 */
const HEAVY = { linear: 0.05, angular: 0.5, simplify: 0.05 };
const FINE_ANGULAR = 0.3;
/** Triangles at the heavy setting above which a solid keeps its first mesh ('once'). */
const ONCE_TRIANGLES = 16000;
/** The counting mesh, and the triangles in it above which a solid counts as heavy ('planned'). */
const COARSE = { linear: 0.1, angular: 0.5 };
const HEAVY_TRIANGLES = 12000;
/** Solids with more faces than this get no exact geometry: Measure leaves them out rather than stall on them. */
const GEOMETRY_FACE_LIMIT = 20000;

/** Fasteners explode along their own axis; standard part names give them away. */
const FASTENER = /\b(ISO|DIN)\s?\d|schraube|mutter|screw|\bnut\b|washer|scheibe|\bM\d+(\.\d+)?x\d+/i;

/** The model's size: the largest body's bounding-box diagonal, mm. */
function extent(meshes: { bbox?: number[] }[]) {
	let largest = 0;
	for (const { bbox } of meshes) {
		if (bbox?.length !== 6) continue;
		largest = Math.max(largest, Math.hypot(bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2]));
	}
	return largest;
}

export type RunOptions = {
	onProgress(progress: ConvertProgress): void;
	yieldToHost(): Promise<void>;
	signal?: AbortSignal;
	/** The build's MESH_RULE unless given: the tests check both. */
	meshRule?: MeshRule;
};

export async function convertStep(wasm: WasmConverter, step: Uint8Array, name: string, options: RunOptions): Promise<Converted> {
	const { onProgress, yieldToHost, signal, meshRule = MESH_RULE } = options;
	const ms: Record<string, number> = {};
	const warnings: string[] = [];
	const cancelled = () => new DOMException('The conversion was cancelled', 'AbortError');
	const check = async () => {
		await yieldToHost();
		if (signal?.aborted) throw cancelled();
	};
	// A converter call returns a promise where the browser can suspend the converter mid-call (JSPI).
	const timed = async <T>(label: string, fn: () => T | Promise<T>): Promise<T> => {
		const start = performance.now();
		try {
			return await fn();
		} finally {
			ms[label] = (ms[label] ?? 0) + Math.round(performance.now() - start);
		}
	};

	try {
		onProgress({ phase: 'read' });
		await check();
		await timed('read', () => wasm.read(step, { healing: true, geometryFaceLimit: GEOMETRY_FACE_LIMIT }));
		onProgress({ phase: 'transfer' });
		await check();
		const { solids } = await timed('transfer', () => wasm.transfer());
		// A file can describe parts without any geometry, or with curves and points only; it would open as an empty view.
		if (!solids) throw new Error('this file holds no solids or surfaces, so there is nothing to show');
		const tree = wasm.tree();
		warnings.push(...wasm.warnings());

		// Finer than 0.01 mm is invisible on any screen; very large models get proportionally coarser facets, and heavy
		// solids are never meshed finer than the rest.
		const fine = Math.min(0.1, Math.max(0.01, extent(tree.meshes) * 1e-5));
		const heavyLinear = Math.max(HEAVY.linear, fine);

		/** Meshes a solid to count its triangles. Normals are left off; the mesh that is kept gets them anyway. */
		const count = async (i: number, linear: number, angular: number) => {
			wasm.setOptions({ normals: false });
			const triangles = await wasm.meshTriangles(i, linear, angular);
			wasm.setOptions({ normals: true });
			return triangles;
		};

		const heavy: boolean[] = [];
		if (meshRule === 'planned') {
			for (let i = 0; i < solids; i++) {
				onProgress({ phase: 'plan', done: i, total: solids });
				heavy.push((await timed('plan', () => count(i, COARSE.linear, COARSE.angular))) > HEAVY_TRIANGLES);
				// BRepMesh keeps a triangulation whose linear deflection is fine enough, whatever the angle asked for: without
				// this, a model large enough for fine to equal COARSE.linear would keep its coarse mesh.
				wasm.release(i);
				await check();
			}
		}

		const meshes: RawMesh[] = [];
		for (let i = 0; i < solids; i++) {
			onProgress({ phase: 'mesh', done: i, total: solids });
			if (meshRule === 'once') {
				// Released first, because a file can bring triangles of its own (AP242), which BRepMesh would keep at any
				// setting.
				wasm.release(i);
				heavy.push((await timed('mesh', () => count(i, heavyLinear, HEAVY.angular))) > ONCE_TRIANGLES);
				// A heavy solid keeps this mesh; asked for again at the same setting, the converter returns it as it is. A
				// light one is released and meshed again, since BRepMesh would keep this mesh where fine equals heavyLinear.
				if (!heavy[i]) wasm.release(i);
				await check();
			}
			const [linear, angular] = heavy[i] ? [heavyLinear, HEAVY.angular] : [fine, FINE_ANGULAR];
			const mesh = await timed('mesh', () => wasm.mesh(i, linear, angular));
			meshes.push({
				positions: mesh.positions,
				indices: mesh.indices,
				faceIds: mesh.faceIds,
				normals: mesh.normals,
				groups: mesh.groups.map((g) => ({ appearance: g.appearance < 0 ? null : tree.appearance_order[g.appearance], triangles: g.triangles })),
				deflection: linear
			});
			wasm.release(i);
			await check();
		}
		warnings.push(...wasm.warnings());

		const start = performance.now();
		let geometryDone = 0;
		const unmeasured: string[] = [];
		const built = await buildModel(
			{
				manifest: tree,
				mesh: (i) => meshes[i],
				geometry: async (i) => {
					onProgress({ phase: 'geometry', done: geometryDone++, total: solids });
					const record = await timed('geometry', () => wasm.geometry(i));
					if (!record) unmeasured.push(tree.meshes[i]?.body ?? `solid ${i + 1}`);
					return record;
				}
			},
			{
				title: tree.doc || name,
				simplifyError: (i) => (heavy[i] ? Math.max(HEAVY.simplify, fine) : fine),
				fastener: (occ) => FASTENER.test(occ.component),
				writeGlb: (doc) => new MemoryIO().writeBinary(doc),
				sha256: sha256Hex,
				yield: check,
				onProgress: (done, total) => onProgress({ phase: 'build', done, total })
			}
		);
		ms.build = Math.round(performance.now() - start) - (ms.geometry ?? 0);
		warnings.push(...wasm.warnings(), ...built.warnings);
		for (const body of unmeasured) warnings.push(`${body}: more than ${GEOMETRY_FACE_LIMIT} faces, so Measure leaves it out`);
		return {
			glb: built.glb,
			measure: built.measure,
			doc: tree.doc,
			unit: tree.source_unit ?? 'mm',
			solids,
			triangles: built.trianglesOut,
			warnings: [...new Set(warnings)],
			ms
		};
	} catch (err) {
		// A crash inside OpenCascade surfaces as a trap. Sound files have caused them too, so the message blames the
		// converter, not the file.
		if (err instanceof WebAssembly.RuntimeError) throw new Error(`the converter failed on this file (${err.message})`);
		// A call the host stopped from its progress report (converter/ABI.md, code -5).
		if ((err as { code?: number }).code === -5) throw cancelled();
		throw err;
	} finally {
		try {
			wasm.close();
		} catch {
			// A crashed instance refuses every call. The crash is the error to report, and the instance is dropped with
			// its memory either way.
		}
	}
}
