// A conversion a site published for a STEP file in its catalogue, a version's or a companion revision's: the
// meshopt-compressed GLB and the gzipped measurement data (pipeline/convert.ts), fetched from the catalogue's Blossom
// servers in place of the STEP file and the converter. Each file must have the hash the catalogue names, and the measurement data must name the GLB.
import { gunzipSync } from 'fflate';
import type { Blob as BlobRef, Catalogue, CatalogueVersion } from '$lib/catalogue/catalogue';
import type { Converted } from '$lib/convert/types';
import type { Host, Progress } from '$lib/host/host';
import { TransportError } from '$lib/host/host';
import { MEASURE_VERSION, type MeasureData } from '$lib/measure/format';
import { blobUrl } from '$lib/source/blossom';
import { lastSegment } from '$lib/source/load';
import { sha256Hex } from '$lib/source/sha256';

/**
 * A STEP file the catalogue lists: a version's, or a companion revision's zipped one. `download` is where the file is
 * fetched from, `name` what it is called there.
 */
export type ListedStep = { title: string; name: string; size: number; download: string; files: CatalogueVersion['files'] };

/** The catalogue's version or companion revision whose STEP file has this sha256. */
export function listedStep(catalogue: Catalogue, sha256: string): ListedStep | null {
	for (const model of Object.values(catalogue.models)) {
		const version = model.versions.find((v) => v.step.sha256 === sha256);
		if (version) return { title: model.title, name: lastSegment(version.step.url), size: version.step.size, download: version.step.url, files: version.files };
		const track = model.companions;
		const revision = track?.revisions.find((r) => r.step.sha256 === sha256);
		if (track && revision) {
			const download = blobUrl(catalogue.servers[0], sha256, 'zip');
			return { title: `${model.title} ${track.label}`, name: lastSegment(download), size: revision.step.size, download, files: revision.files };
		}
	}
	return null;
}

/** Triangles in a GLB's meshes, from its JSON chunk: a published conversion carries no count of its own. */
function trianglesOf(glb: Uint8Array) {
	const length = new DataView(glb.buffer, glb.byteOffset, glb.byteLength).getUint32(12, true);
	const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length))) as {
		meshes?: { primitives: { mode?: number; indices?: number }[] }[];
		accessors?: { count: number }[];
	};
	let triangles = 0;
	for (const mesh of json.meshes ?? []) {
		for (const { mode = 4, indices } of mesh.primitives) if (mode === 4 && indices !== undefined) triangles += (json.accessors?.[indices]?.count ?? 0) / 3;
	}
	return triangles;
}

/**
 * The model a version's published files make, as a conversion would give it. Both files are fetched at once and checked
 * here, whatever the transport checked; a failure of either stops both. The files are in millimetres and keep no record
 * of the STEP file's own unit or the conversion's notes.
 */
export async function openPublished(
	host: Host,
	catalogue: Catalogue,
	files: CatalogueVersion['files'],
	onProgress: Progress,
	signal: AbortSignal
): Promise<Omit<Converted, 'ms'>> {
	// One signal for both files: the caller's, or the other file's failure. By hand, since AbortSignal.any is newer than
	// some WebViews this runs in (Chrome 116, Safari 17.4, Firefox 124).
	const both = new AbortController();
	const stop = both.signal;
	const forward = () => both.abort(signal.reason);
	if (signal.aborted) forward();
	else signal.addEventListener('abort', forward, { once: true });
	const parts = [files.glb, files.measure];
	const received: (number | null)[] = parts.map(() => 0);
	const total = parts.reduce((sum, file) => sum + file.size, 0);
	const get = async (file: BlobRef, i: number) => {
		const progress: Progress = (fraction) => {
			received[i] = fraction === null ? null : fraction * file.size;
			onProgress(received.includes(null) ? null : (received as number[]).reduce((a, b) => a + b, 0) / total);
		};
		const { bytes } = await host.transport.blob(file.sha256, catalogue.servers, progress, stop);
		if (sha256Hex(bytes) !== file.sha256) throw new TransportError('mismatch', 'a published file does not match the hash the catalogue names');
		return bytes;
	};
	const [glb, packed] = await Promise.all(parts.map((file, i) => get(file, i)))
		.catch((err: unknown) => {
			both.abort(err);
			throw err;
		})
		.finally(() => signal.removeEventListener('abort', forward));
	const measure = JSON.parse(new TextDecoder().decode(gunzipSync(packed))) as MeasureData;
	if (measure.v !== MEASURE_VERSION || measure.glb !== files.glb.sha256) throw new Error('the published measurement data is not for the published model');
	return { glb, measure, doc: '', unit: 'mm', solids: measure.solids.length, triangles: trianglesOf(glb), warnings: [] };
}
