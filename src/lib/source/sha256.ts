import { sha256 } from '@noble/hashes/sha2.js';

/** Hex sha256 of bytes. Synchronous and without WebCrypto, which sandboxed and insecure contexts may lack. */
export function sha256Hex(data: Uint8Array): string {
	const digest = sha256(data);
	let hex = '';
	for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
	return hex;
}
