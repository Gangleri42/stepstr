// What a file is, from its first bytes, and the STEP inside a zip or gzip wrapper.
import { gunzipSync, unzipSync } from 'fflate';
import { lfsPointer } from './github';

export type FileKind = 'step' | 'step-xml' | 'zip' | 'gzip' | 'glb' | 'lfs' | 'unknown';

const ascii = (bytes: Uint8Array, length: number) => String.fromCharCode(...bytes.subarray(0, length));

export function sniff(bytes: Uint8Array): FileKind {
	// A local file header, or the end record an empty archive consists of.
	if (bytes[0] === 0x50 && bytes[1] === 0x4b && ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06))) return 'zip';
	if (bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gzip';
	if (ascii(bytes, 4) === 'glTF') return 'glb';
	if (lfsPointer(bytes)) return 'lfs';
	// A UTF-8 byte-order mark (read here as three Latin-1 characters) or blank lines may come first.
	const head = ascii(bytes, 256).replace(/^\u00ef\u00bb\u00bf/, '').trimStart();
	if (head.startsWith('ISO-10303-21;')) return 'step';
	if (head.startsWith('<?xml') && /iso[_-]10303[_-]28/i.test(ascii(bytes, 2048))) return 'step-xml';
	return 'unknown';
}

const STEP_NAME = /\.(step|stp|p21)$/i;

/** The STEP file inside, for a zip (the first .step entry, else the largest) or gzip wrapper; STEP bytes as they are. */
export function unwrapStep(bytes: Uint8Array, name: string): { bytes: Uint8Array; name: string } {
	const kind = sniff(bytes);
	if (kind === 'step') return { bytes, name };
	if (kind === 'gzip') return unwrapStep(gunzipSync(bytes), name.replace(/\.gz$/i, ''));
	if (kind === 'zip') {
		const entries = Object.entries(unzipSync(bytes, { filter: (file) => !file.name.endsWith('/') }));
		const step = entries.find(([entry]) => STEP_NAME.test(entry)) ?? entries.sort((a, b) => b[1].length - a[1].length)[0];
		if (!step) throw new Error('the zip file is empty');
		return unwrapStep(step[1], step[0].split('/').pop() ?? step[0]);
	}
	if (kind === 'step-xml') throw new Error('this is STEP-XML (ISO 10303-28); only the plain STEP format (ISO 10303-21) opens here');
	if (kind === 'glb') throw new Error('this is a glTF model, not a STEP file');
	if (kind === 'lfs') throw new Error('this is a Git LFS pointer, not the file itself');
	throw new Error('this is not a STEP file');
}
