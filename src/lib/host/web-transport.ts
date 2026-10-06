// Bytes and events on a plain web page: fetch for files, relays for Nostr. Only the web build imports this; the
// napplet has no network of its own (napplet-transport.ts).
import { blobUrl } from '$lib/source/blossom';
import { sha256Hex } from '$lib/source/sha256';
import type { Progress, Transport } from './host';
import { moreTelling, TransportError } from './host';

/** Reads a response body in chunks so the loading bar can follow. */
async function readWithProgress(response: Response, onProgress?: Progress): Promise<Uint8Array> {
	const total = Number(response.headers.get('content-length')) || 0;
	if (!response.body) return new Uint8Array(await response.arrayBuffer());
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		received += value.byteLength;
		onProgress?.(total ? Math.min(1, received / total) : null);
	}
	const out = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

async function get(url: string, onProgress?: Progress, signal?: AbortSignal) {
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
	return readWithProgress(response, onProgress);
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
