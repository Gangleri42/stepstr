// The converter as the napplet fetches it: converter.wasm gzipped, as base64 text. Shells pass text on where they refuse
// binary types, and the napplet names the file by the sha256 of this text.
import { existsSync, readFileSync } from 'node:fs';
import { constants, gzipSync } from 'node:zlib';

export const CONVERTER_FILE = 'converter.txt';

export function converterText(wasmPath: string): string {
	if (!existsSync(wasmPath)) throw new Error(`${wasmPath} is missing: build the converter first (converter/build.sh)`);
	return gzipSync(readFileSync(wasmPath), { level: constants.Z_BEST_COMPRESSION }).toString('base64');
}
