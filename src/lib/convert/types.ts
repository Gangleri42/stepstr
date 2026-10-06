// The conversion from STEP to the viewer's model, as the app sees it, and the wasm converter as converter/loader.js
// hands it over (converter/ABI.md).
import type { MeasureData } from '$lib/measure/format';
import type { Manifest } from '$lib/pipeline/build-model';
import type { RawSolid } from '$lib/pipeline/measure';

export type ConvertPhase = 'start' | 'read' | 'transfer' | 'plan' | 'mesh' | 'build' | 'geometry';
/** done of total for phases that count solids; fraction, 0 to 1, for the converter's progress inside one long call. */
export type ConvertProgress = { phase: ConvertPhase; done?: number; total?: number; fraction?: number };

/** The converter's own progress phases (converter/ABI.md) that run as one long call; run.ts reports the rest per solid. */
export const LONG_PHASES: Record<number, ConvertPhase> = { 1: 'read', 2: 'transfer' };

export type Converted = {
	/** The viewer's GLB, uncompressed. */
	glb: Uint8Array;
	measure: MeasureData;
	/** The name of the file's top shape. */
	doc: string;
	/** The length unit the file was written in; the model is always in mm. */
	unit: string;
	solids: number;
	triangles: number;
	warnings: string[];
	/** Milliseconds per phase, for diagnostics and tests. */
	ms: Record<string, number>;
};

export interface Converter {
	/** Starts loading the converter, so its download overlaps the file's; a failure shows at convert. */
	prepare(): void;
	convert(step: Uint8Array, name: string, onProgress: (progress: ConvertProgress) => void, signal?: AbortSignal): Promise<Converted>;
}

export type ConverterTree = Manifest & {
	source_unit?: string;
	appearance_order: string[];
	meshes: { component: string; body: string; faces?: number; bbox?: number[] }[];
};

export type ConverterMesh = {
	positions: Float32Array;
	indices: Uint32Array;
	faceIds: Uint32Array;
	normals: Float32Array | null;
	/** appearance: an index into the tree's appearance_order, -1 for the body's own colour. */
	groups: { appearance: number; triangles: number }[];
};

export type ConverterOptions = { healing?: boolean; normals?: boolean; geometryFaceLimit?: number };

/** A result the loader hands back as a promise when the browser can suspend the converter (JSPI). */
type Long<T> = T | Promise<T>;

/** One loaded converter instance (converter/loader.js). */
export interface WasmConverter {
	abi: number;
	read(step: Uint8Array, options?: ConverterOptions): Long<unknown>;
	transfer(): Long<{ solids: number }>;
	tree(): ConverterTree;
	mesh(solid: number, linear: number, angular: number): Long<ConverterMesh>;
	/** Meshes like mesh() and returns only the triangle count. */
	meshTriangles(solid: number, linear: number, angular: number): Long<number>;
	geometry(solid: number): Long<RawSolid | null>;
	warnings(): string[];
	/** Options for the calls that follow: normals and geometryFaceLimit apply per call, healing at the next transfer. */
	setOptions(options: ConverterOptions): void;
	release(solid: number): void;
	close(): void;
	memoryBytes(): number;
}
