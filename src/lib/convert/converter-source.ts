// Where the napplet's converter comes from: the text the build published next to it (converter.wasm, gzipped and
// base64-encoded), fetched through the shell by its hash or from the dev server, and refused unless it is that text.
import type { Transport } from '$lib/host/host';
import { TransportError } from '$lib/host/host';
import { sha256Hex } from '$lib/source/sha256';

export type ConverterSource = { sha256: string; source: string };

/** A function that fetches the converter's text: from the Blossom servers given when the source is blossom:. */
export function converterFetcher(transport: Transport, converter: ConverterSource, servers: string[]) {
	return async (): Promise<string> => {
		let bytes: Uint8Array;
		try {
			bytes = converter.source.startsWith('blossom:') ? (await transport.blob(converter.sha256, servers)).bytes : await transport.url(converter.source);
		} catch (err) {
			// The message names the converter, since the file being opened may have arrived fine.
			if (err instanceof TransportError) throw new TransportError(err.reason, `the converter could not be fetched: ${err.message}`, err.size);
			throw err;
		}
		if (sha256Hex(bytes) !== converter.sha256) throw new TransportError('mismatch', 'the converter that arrived is not the one this napplet was built with');
		return new TextDecoder().decode(bytes);
	};
}
