// Types for loader.js; the semantics are in ABI.md.

/**
 * Called from the long calls at most every few milliseconds. phase: 1 read, 2 transfer, 3 mesh, 4 geometry;
 * done/total is the phase's progress as a fraction. A truthy return (with JSPI, a truthy resolution) stops the
 * call, which then throws an Error named AbortError with code -5.
 */
export type ProgressListener = (phase: number, done: number, total: number) => unknown;

export type ConverterOptions = { healing?: boolean; normals?: boolean; geometryFaceLimit?: number };

export type ConverterMesh = {
	positions: Float32Array;
	indices: Uint32Array;
	faceIds: Uint32Array;
	normals: Float32Array | null;
	/** appearance: an index into the tree's appearance_order, -1 for the body's own colour. */
	groups: { appearance: number; triangles: number }[];
};

export type Converter = {
	readonly abi: number;
	/** The module's raw exports, for callers that read results in place. */
	readonly exports: Record<string, unknown> & { memory: WebAssembly.Memory };
	/** A promise when the previous file crashed the instance and a fresh one has to start first: await it either way. */
	read(stepBytes: Uint8Array, options?: ConverterOptions): void | Promise<void>;
	transfer(): { solids: number };
	/** read then transfer; a promise after a crash, as with read. */
	open(stepBytes: Uint8Array, options?: ConverterOptions): { solids: number } | Promise<{ solids: number }>;
	/** Options for the calls that follow: healing at the next transfer, normals and geometryFaceLimit per call. */
	setOptions(options: ConverterOptions): void;
	tree(): unknown;
	mesh(solid: number, linear: number, angular: number): ConverterMesh;
	/** Meshes like mesh() and returns the triangle count alone, without copying the arrays out. */
	meshTriangles(solid: number, linear: number, angular: number): number;
	geometry(solid: number): unknown;
	warnings(): string[];
	release(solid: number): void;
	close(): void;
	memoryBytes(): number;
};

/**
 * The converter loaded with { jspi: true }: the long calls return promises and onProgress may be async; the rest
 * stays synchronous. On an engine without WebAssembly.Suspending the loader falls back to synchronous calls,
 * whose plain results an await accepts all the same.
 */
export type AsyncConverter = Omit<Converter, 'read' | 'transfer' | 'open' | 'mesh' | 'meshTriangles' | 'geometry'> & {
	read(stepBytes: Uint8Array, options?: ConverterOptions): Promise<void>;
	transfer(): Promise<{ solids: number }>;
	open(stepBytes: Uint8Array, options?: ConverterOptions): Promise<{ solids: number }>;
	mesh(solid: number, linear: number, angular: number): Promise<ConverterMesh>;
	/** Meshes like mesh() and returns the triangle count alone, without copying the arrays out. */
	meshTriangles(solid: number, linear: number, angular: number): Promise<number>;
	geometry(solid: number): Promise<unknown>;
};

export type LoadOptions = { onProgress?: ProgressListener; onOutput?: (text: string) => void };

export function loadConverter(
	wasm: BufferSource | WebAssembly.Module,
	options: LoadOptions & { jspi: true }
): Promise<AsyncConverter>;
export function loadConverter(
	wasm: BufferSource | WebAssembly.Module,
	options?: LoadOptions & { jspi?: false }
): Promise<Converter>;
export function loadConverter(
	wasm: BufferSource | WebAssembly.Module,
	options: LoadOptions & { jspi: boolean }
): Promise<Converter | AsyncConverter>;

/** Base64 of a gzip stream back to bytes. */
export function gunzipBase64(text: string): Promise<Uint8Array>;
