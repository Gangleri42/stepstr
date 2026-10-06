// Short part ids for share links: six base-36 characters of a hash of the part's path in the assembly
// ("frame:1+side_plates:1/body"). The same path gives the same id in every build, so an old link finds its part as long
// as the part keeps its place and name. In a model of 1,000 parts, the chance that two share an id is about 1 in 4,400.
import { sha256 } from '@noble/hashes/sha2.js';

const utf8 = new TextEncoder();

export function partId(path: string): string {
	const d = sha256(utf8.encode(path));
	// The first six bytes, big-endian: 48 bits, exact in a double.
	const n = ((((d[0] * 256 + d[1]) * 256 + d[2]) * 256 + d[3]) * 256 + d[4]) * 256 + d[5];
	return (n % 36 ** 6).toString(36).padStart(6, '0');
}
