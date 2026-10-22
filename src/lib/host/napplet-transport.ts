// Bytes and events inside a NIP-5D sandbox, which has no network of its own: files come through the shell's resource
// capability, events through its outbox, local files through its file access. Every capability is optional.
import { blobUrl } from '$lib/source/blossom';
import { sha256Hex } from '$lib/source/sha256';
import type { PickedFile, Transport, TransportFailure } from './host';
import { moreTelling, TransportError } from './host';
import { has } from './napplet-runtime';
import { newest, serversOf, wanted, type EventFilter } from './nostr-events';

/** A shell reports failures as "<code>: <message>"; the code says what the user can do about it. */
function shellError(err: unknown, url: string): TransportError {
	const text = err instanceof Error ? err.message : String(err);
	const code = /^(too-large|decode-failed|not-found|network-error|timeout|blocked-by-policy|unsupported-scheme|invalid-request|quota-exceeded)\b/.exec(text)?.[1];
	const reason: Record<string, TransportFailure> = {
		'too-large': 'too-large',
		'quota-exceeded': 'too-large',
		'decode-failed': 'unsupported-type',
		'not-found': 'not-found',
		'network-error': 'unreachable',
		timeout: 'timeout',
		'blocked-by-policy': 'blocked',
		'unsupported-scheme': 'unsupported',
		'invalid-request': 'unsupported'
	};
	const failure = code ? reason[code] : /timed out/i.test(text) ? 'timeout' : 'unreachable';
	const host = url.startsWith('blossom:') ? null : new URL(url).host;
	const say: Partial<Record<TransportFailure, string>> = host
		? { 'not-found': `${host} does not have this file`, unreachable: `${host} could not be reached`, timeout: `${host} did not answer in time` }
		: { 'not-found': 'no Blossom server asked has this file', unreachable: 'the Blossom servers could not be reached', timeout: 'the Blossom servers did not answer in time' };
	return new TransportError(failure, say[failure] ?? `${host ?? 'the Blossom file'}: ${text}`);
}

async function bytesOf(url: string, servers?: string[], signal?: AbortSignal): Promise<Uint8Array> {
	const resource = has('resource', 'bytes');
	if (!resource) throw new TransportError('unsupported', 'this host does not let napplets fetch files');
	try {
		const blob = await resource.bytes(url, { ...(servers?.length ? { servers } : {}), ...(signal ? { signal } : {}) });
		return new Uint8Array(await blob.arrayBuffer());
	} catch (err) {
		signal?.throwIfAborted();
		throw shellError(err, url);
	}
}

/** The newest validly signed event that matches the filter, through the shell's outbox; null when there is none. */
async function query(filter: EventFilter, relays: string[] = [], author?: string) {
	const outbox = has('outbox', 'getEvent', 'query');
	if (!outbox) throw new TransportError('unsupported', 'this host cannot read Nostr events');
	// The shell routes by author and takes a pointer's relays as hints.
	const hints = relays.length ? { relays } : {};
	if (filter.ids?.length === 1) {
		const { result } = await outbox.getEvent(filter.ids[0], { ...hints, ...(author ? { author } : {}) });
		return newest([result?.event], filter);
	}
	// One per relay: each keeps only its newest version of a replaceable or addressable event.
	const { events } = await outbox.query({ ...filter, limit: 1 }, { ...hints, ...(filter.authors ? { authors: filter.authors } : {}) });
	return newest(events.map((r) => r.event), filter);
}

/** The servers a link names: Myco reads four (October 2026), Paja eight. */
const LINK_HINTS = 4;

/**
 * A blob as a BUD-10 link, `blossom:<sha256>?xs=<host>&…`, naming the first servers in it. Shells built on the common
 * shim pass a napplet's `servers` option on to nobody, so the link carries them; Paja reads both and asks for this
 * spelling rather than `blossom:sha256:`.
 */
export function blossomLink(sha256: string, servers: string[]) {
	const hosts: string[] = [];
	for (const server of servers) {
		try {
			const { host, protocol } = new URL(server);
			if (protocol === 'https:' && !hosts.includes(host)) hosts.push(host);
		} catch {
			// Not a server address: nothing to hint.
		}
		if (hosts.length === LINK_HINTS) break;
	}
	return `blossom:${sha256}${hosts.length ? `?${hosts.map((host) => `xs=${encodeURIComponent(host)}`).join('&')}` : ''}`;
}

export function nappletTransport(): Transport {
	return {
		async blob(sha256, servers, onProgress, signal) {
			onProgress?.(null);
			// The BUD-10 link first, where the shell picks the server; runtimes that only speak https get each server's
			// BUD-01 address.
			const attempts: [string, string[]?][] = [[blossomLink(sha256, servers), servers], ...servers.map((s): [string] => [blobUrl(s, sha256)])];
			let failure: unknown = new TransportError('not-found', 'no Blossom server was named for this file');
			for (const [url, hints] of attempts) {
				try {
					const bytes = await bytesOf(url, hints, signal);
					if (sha256Hex(bytes) !== sha256) {
						failure = new TransportError('mismatch', 'the file does not match its hash');
						continue;
					}
					onProgress?.(1);
					return { bytes, url: url.startsWith('https:') ? url : null };
				} catch (err) {
					signal?.throwIfAborted();
					failure = moreTelling(failure, err);
					// A size or type the shell refuses will not change with another server.
					if (err instanceof TransportError && (err.reason === 'too-large' || err.reason === 'unsupported-type')) break;
				}
			}
			throw failure;
		},
		async url(url, onProgress, signal) {
			onProgress?.(null);
			const bytes = await bytesOf(url, undefined, signal);
			onProgress?.(1);
			return bytes;
		},
		...(has('outbox', 'getEvent', 'query')
			? {
					async event(pointer: string) {
						const want = wanted(pointer);
						return want ? query(want.filter, want.relays, want.author) : null;
					},
					async servers(pubkey: string) {
						return serversOf(await query({ kinds: [10063], authors: [pubkey] }));
					}
				}
			: {}),
		async limit() {
			const info = await has('resource', 'info')?.info?.().catch(() => undefined);
			return info?.maxBytes;
		}
	};
}

/** The shell's file picker, read in chunks; null when the shell has none or nothing was picked. */
export async function pickWithShell(): Promise<PickedFile | null> {
	const fs = has('fs', 'pickFile', 'read');
	if (!fs) return null;
	const { entries } = await fs.pickFile({
		accept: [{ extension: '.step' }, { extension: '.stp' }, { mime: 'model/step' }, { extension: '.zip' }],
		description: 'STEP files'
	});
	const entry = entries.find((e) => e.kind === 'file');
	if (!entry) return null;
	const limit = (await fs.info?.().catch(() => undefined))?.limits?.maxReadBytes ?? 4 * 1024 * 1024;
	const chunks: Uint8Array[] = [];
	let offset = 0;
	for (;;) {
		const part = await fs.read(entry.path, { offset, length: limit });
		const binary = atob(part.data);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		chunks.push(bytes);
		offset += part.bytesRead;
		if (part.eof || part.bytesRead === 0) break;
	}
	const out = new Uint8Array(offset);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return { name: entry.name, bytes: out };
}
