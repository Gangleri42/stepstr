// Files opened from this device (a drop, the picker, a paste, bytes an intent brought). They are known by their
// sha256, so the route is the same one a Blossom copy of the file would have.
import { sha256Hex } from './sha256';

const files = new Map<string, { name: string; bytes: Uint8Array }>();

/** Keeps the file for this session and returns its sha256. */
export function addLocalFile(name: string, bytes: Uint8Array): string {
	const sha256 = sha256Hex(bytes);
	files.set(sha256, { name, bytes });
	return sha256;
}

export const localFile = (sha256: string) => files.get(sha256) ?? null;
