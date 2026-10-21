// Fetches the STEP bytes a route's source names: a local file, a Blossom blob, a file at a URL, or the file a Nostr
// event points at. Bytes a route pins by sha256 are checked; zip and gzip wrappers come off.
import type { Host, Progress } from '$lib/host/host';
import { moreTelling, TransportError } from '$lib/host/host';
import type { FileSource } from '$lib/state/hash';
import { blobUrl, extOf } from './blossom';
import { lfsMediaUrl, lfsPointer } from './github';
import { localFile } from './local';
import { stepFilesOf } from './nostr-files';
import { sha256Hex } from './sha256';
import { unwrapStep } from './sniff';

export type Loaded = {
	/** The STEP file itself, unwrapped. */
	bytes: Uint8Array;
	/** sha256 of the bytes as fetched (before unwrapping): what a pinned link names. */
	sha256: string;
	name: string;
	/** Where the original file can be downloaded, when it lives somewhere public. */
	download: string | null;
	/** Size as fetched. */
	size: number;
};

const unique = (list: string[]) => [...new Set(list.map((s) => s.replace(/\/+$/, '')))];

function checked(bytes: Uint8Array, sha256: string | undefined) {
	const actual = sha256Hex(bytes);
	if (sha256 && actual !== sha256) throw new TransportError('mismatch', 'the file does not match the hash the link names; it may have changed since');
	return actual;
}

/** The last part of a URL's path, decoded where it can be. */
export function lastSegment(url: string) {
	const segment = new URL(url).pathname.split('/').pop() ?? '';
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

/** Failures that trying another server or address will not fix. */
const final = (err: unknown) =>
	(err instanceof DOMException && err.name === 'AbortError') || (err instanceof TransportError && (err.reason === 'too-large' || err.reason === 'unsupported-type'));

/** `size` is the file's size when the caller knows it, so a download whose response does not say still shows how far it is. */
export async function loadSource(source: FileSource, name: string | null, host: Host, onProgress: Progress, signal?: AbortSignal, size?: number): Promise<Loaded> {
	const { transport } = host;
	const finish = (bytes: Uint8Array, sha256: string, fallbackName: string, download: string | null): Loaded => {
		const step = unwrapStep(bytes, name ?? fallbackName);
		return { bytes: step.bytes, sha256, name: name ?? step.name, download, size: bytes.length };
	};

	/** Refuses up front a file the host says it cannot fetch, when the link says how large it is. */
	let limit: Promise<number | undefined> | undefined;
	const fits = async (size: number | undefined) => {
		if (!size || !transport.limit) return;
		const max = await (limit ??= transport.limit().catch(() => undefined));
		if (max && size > max) throw new TransportError('too-large', `the file is ${size} bytes, over this host's ${max}`, size);
	};
	const sized = (err: unknown, size: number | undefined) =>
		err instanceof TransportError && err.reason === 'too-large' && size && !err.size ? new TransportError(err.reason, err.message, size) : err;

	/**
	 * A blob from the servers a link names; only when none of them has it, from the servers the author lists (a relay
	 * lookup that can take seconds) and the defaults.
	 */
	const blobFrom = async (sha256: string, named: string[], author: string | undefined, size: number | undefined) => {
		await fits(size);
		const first = unique(named);
		let failure: unknown = new TransportError('not-found', 'no Blossom server was named for this file');
		try {
			if (first.length) return { ...(await transport.blob(sha256, first, onProgress, signal)), servers: first };
		} catch (err) {
			signal?.throwIfAborted();
			if (final(err)) throw sized(err, size);
			failure = err;
		}
		const listed = author && transport.servers ? await transport.servers(author).catch(() => []) : [];
		signal?.throwIfAborted();
		const rest = unique([...listed, ...host.servers]).filter((s) => !first.includes(s));
		if (!rest.length) throw failure;
		try {
			return { ...(await transport.blob(sha256, rest, onProgress, signal)), servers: rest };
		} catch (err) {
			signal?.throwIfAborted();
			throw sized(moreTelling(failure, err), size);
		}
	};
	/** A blob with its hash checked here as well. A transport checks only to move on to the next server; the pin must not depend on that. */
	const blob = async (sha256: string, named: string[], author: string | undefined, size: number | undefined) => {
		const got = await blobFrom(sha256, named, author, size);
		checked(got.bytes, sha256);
		return got;
	};

	if (source.kind === 'blob') {
		const local = localFile(source.sha256);
		if (local) return finish(local.bytes, source.sha256, local.name, null);
		const got = await blob(source.sha256, source.servers, source.author, source.size);
		// The address that served the file, or where the first server that should hold it keeps it.
		const download = got.url ?? blobUrl(got.servers[0], source.sha256, source.ext);
		return finish(got.bytes, source.sha256, `${source.sha256.slice(0, 12)}${source.ext ? `.${source.ext}` : '.step'}`, download);
	}

	if (source.kind === 'url') {
		let bytes = await transport.url(source.url, onProgress, signal, size);
		let download = source.url;
		// A repository that keeps its CAD files in Git LFS hands out a pointer; the content lives elsewhere.
		const pointer = lfsPointer(bytes);
		if (pointer) {
			await fits(pointer.size);
			// GitHub serves the content from its media host; a Blossom server may hold it under the same sha256.
			const media = lfsMediaUrl(source.url);
			let fetched = false;
			if (media) {
				try {
					bytes = await transport.url(media, onProgress, signal);
					download = media;
					fetched = true;
				} catch (err) {
					signal?.throwIfAborted();
					if (final(err)) throw sized(err, pointer.size);
				}
			}
			if (!fetched) {
				const got = await blob(pointer.oid, [], undefined, pointer.size).catch((err) => {
					if (final(err)) throw err;
					throw new TransportError('not-found', 'this is a Git LFS pointer, and its content could not be reached');
				});
				bytes = got.bytes;
				download = got.url ?? source.url;
			}
		}
		return finish(bytes, checked(bytes, source.sha256), lastSegment(source.url) || 'model.step', download);
	}

	if (!transport.event) throw new TransportError('unsupported', 'this host cannot read Nostr events');
	const event = await transport.event(source.pointer);
	signal?.throwIfAborted();
	if (!event) throw new TransportError('not-found', 'the Nostr event was not found on the relays asked');
	const files = stepFilesOf(event);
	if (!files.length) throw new TransportError('not-found', 'the Nostr event does not point at a STEP file');
	// A pinned link opens only the bytes it names: the file with that hash, or one whose hash the event does not say
	// (checked once fetched). An event edited to point elsewhere does not change what the link shows.
	const pin = source.sha256;
	const file = pin ? (files.find((f) => f.sha256 === pin) ?? files.find((f) => !f.sha256 && f.url)) : files[0];
	if (!file) throw new TransportError('mismatch', 'the Nostr event no longer points at the file this link names');
	const sha256 = pin ?? file.sha256;
	const fileName = file.name || (file.url ? lastSegment(file.url) : '') || `model.${extOf(file.url ?? '') || 'step'}`;
	if (sha256) {
		try {
			const got = await blob(sha256, file.servers, event.pubkey, file.size);
			return finish(got.bytes, sha256, fileName, got.url ?? file.url ?? null);
		} catch (err) {
			signal?.throwIfAborted();
			if (!file.url || final(err)) throw err;
		}
	}
	if (!file.url) throw new TransportError('not-found', 'the Nostr event names the file only by a hash no server has');
	const bytes = await transport.url(file.url, onProgress, signal).catch((err) => {
		throw sized(err, file.size);
	});
	return finish(bytes, checked(bytes, sha256), fileName, file.url);
}

/** What went wrong, for the person looking at the screen, and what they can do about it. */
export function explainLoadError(err: unknown): { message: string; hint?: 'local' | 'web' } {
	const sentence = (text: string) => {
		// A host name that starts the sentence stays as it is written.
		const capital = /^[a-z0-9-]+(\.[a-z0-9-]+)+(\s|$)/.test(text) ? text : text.charAt(0).toUpperCase() + text.slice(1);
		return /[.!?]$/.test(capital) ? capital : `${capital}.`;
	};
	if (!(err instanceof TransportError)) return { message: sentence(err instanceof Error ? err.message : String(err)) };
	switch (err.reason) {
		case 'too-large':
			return { message: `This host fetches files only up to a limit, and this one is larger${err.size ? ` (${(err.size / 1e6).toFixed(1)} MB)` : ''}.`, hint: 'local' };
		case 'unsupported-type':
			return { message: 'This host passes only plain text and images to napplets, so a zipped or binary file cannot come through.', hint: 'local' };
		case 'blocked':
			return { message: 'This host does not allow fetching that address.', hint: 'web' };
		case 'unsupported':
			return { message: sentence(err.message), hint: 'web' };
		default:
			return { message: sentence(err.message) };
	}
}
