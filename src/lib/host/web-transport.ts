// Bytes and events on a plain web page: fetch for files, relays for Nostr. Only the web build imports this; the
// napplet has no network of its own (napplet-transport.ts).
import { blobUrl } from '$lib/source/blossom';
import { sha256Hex } from '$lib/source/sha256';
import type { Progress, Transport } from './host';
import { moreTelling, TransportError } from './host';

/**
 * The body's size as the reader will count it, when the response says. Content-Length is the size sent, so a body the
 * server compressed is longer than that (raw.githubusercontent.com gzips text: a 25 MB STEP file travels as 4.6 MB),
 * and a page on another origin cannot see Content-Encoding unless the server exposes it. The length counts for a body
 * sent as it is, and for one of a binary type whose encoding is hidden; servers compress text, not binary files.
 */
function bodySize(response: Response): number | null {
	const length = Number(response.headers.get('content-length')) || 0;
	const encoding = response.headers.get('content-encoding');
	if (!length || (encoding && encoding !== 'identity')) return null;
	if (!encoding && response.type === 'cors' && /^text\//i.test(response.headers.get('content-type') ?? '')) return null;
	return length;
}

/**
 * Reads a response body in chunks so the loading bar can follow: a fraction where the size is known, from the caller
 * or the response, else null.
 */
async function readWithProgress(response: Response, onProgress?: Progress, size?: number): Promise<Uint8Array> {
	let total = size ?? bodySize(response);
	if (!response.body) return new Uint8Array(await response.arrayBuffer());
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		received += value.byteLength;
		// More than the length: it was not the body's, whatever the headers said.
		if (total && received > total) total = null;
		onProgress?.(total ? received / total : null);
	}
	const out = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

async function get(url: string, onProgress?: Progress, signal?: AbortSignal, size?: number) {
	let response: Response;
	try {
		response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal });
	} catch {
		signal?.throwIfAborted();
		// A browser reports refused cross-origin reads and network failures the same way.
		throw new TransportError('unreachable', `${new URL(url).host} could not be reached, or does not let other sites read this file`);
	}
	if (response.status === 404) throw new TransportError('not-found', `${new URL(url).host} does not have this file`);
	if (!response.ok) throw new TransportError('unreachable', `${new URL(url).host} answered ${response.status} ${response.statusText}`.trim());
	return readWithProgress(response, onProgress, size);
}

export function webTransport(): Transport {
	return {
		async blob(sha256, servers, onProgress, signal) {
			let failure: unknown = new TransportError('not-found', 'no Blossom server was named for this file');
			for (const server of servers) {
				const url = blobUrl(server, sha256);
				try {
					const bytes = await get(url, onProgress, signal);
					if (sha256Hex(bytes) === sha256) return { bytes, url };
					failure = new TransportError('mismatch', `${new URL(server).host} sent different bytes than the link names`);
				} catch (err) {
					signal?.throwIfAborted();
					failure = moreTelling(failure, err);
				}
			}
			throw failure;
		},
		url: get,
		async event(pointer) {
			const { fetchEvent } = await import('./web-nostr');
			return fetchEvent(pointer);
		},
		async servers(pubkey) {
			const { fetchServerList } = await import('./web-nostr');
			return fetchServerList(pubkey);
		}
	};
}
