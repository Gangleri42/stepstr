// What the viewer needs from wherever it runs. A plain web page has a URL, the network and a clipboard; a napplet
// sandbox has none of those and asks its shell instead. Everything environment-specific goes through this seam so the
// app itself stays one component tree.
import type { Catalogue } from '$lib/catalogue/catalogue';
import type { Converter } from '$lib/convert/types';
import type { RecentStore } from '$lib/recent/types';
import type { NostrEventLike } from '$lib/source/nostr-files';
import type { ThemeSource } from '$lib/theme.svelte';

/** `fraction` null means the total is unknown. */
export type Progress = (fraction: number | null) => void;

/** How bytes and events reach the viewer. Failures throw a TransportError when the reason is known. */
export interface Transport {
	/**
	 * A Blossom blob from the first server that has it, checked against its hash, with the https address it came from
	 * when the transport knows it.
	 */
	blob(sha256: string, servers: string[], onProgress?: Progress, signal?: AbortSignal): Promise<{ bytes: Uint8Array; url: string | null }>;
	/** The bytes at an https URL; `size`, when the caller knows it, is what the progress counts against. */
	url(url: string, onProgress?: Progress, signal?: AbortSignal, size?: number): Promise<Uint8Array>;
	/** A Nostr event by NIP-19 pointer, its signature checked; null when not found. Absent without relay access. */
	event?(pointer: string): Promise<NostrEventLike | null>;
	/** The Blossom servers a user lists (kind 10063), best first. */
	servers?(pubkey: string): Promise<string[]>;
	/** The largest file this host fetches, when it says. */
	limit?(): Promise<number | undefined>;
}

/** Why a transfer failed, in the words of NAP-RESOURCE's error codes where a shell reports them. */
export type TransportFailure = 'too-large' | 'unsupported-type' | 'not-found' | 'blocked' | 'unreachable' | 'timeout' | 'mismatch' | 'unsupported';

export class TransportError extends Error {
	constructor(
		readonly reason: TransportFailure,
		message: string,
		/** The file's size in bytes, when known: a "too large" message says it. */
		readonly size?: number
	) {
		super(message);
	}
}

/** Which of two failures to report: a "not found" from one server does not hide a more specific failure from another. */
export function moreTelling(kept: unknown, next: unknown): unknown {
	const notFound = (err: unknown) => err instanceof TransportError && err.reason === 'not-found';
	return notFound(next) && !notFound(kept) ? kept : next;
}

export type ShareLink = {
	id: 'web' | 'intent';
	label: string;
	/** What the link is for, shown small under the label. */
	hint: string;
	text: string;
};

export type PickedFile = { name: string; bytes: Uint8Array };

export interface Host {
	/** The route to open with, in the hash grammar. Empty for nothing open. */
	initialRoute(): string;
	/** Routes that arrive later (a hash change, an intent from the shell). Returns the unsubscribe. */
	onRoute(listener: (route: string) => void): () => void;
	/** The view changed; the environment may mirror it, for example into the URL hash. */
	publishRoute(route: string): void;
	transport: Transport;
	converter: Converter;
	/** Blossom servers to try for a blob when a link names none of its own. */
	servers: string[];
	theme: ThemeSource;
	shareLinks(route: string): ShareLink[];
	/** Puts text on the clipboard. False when the environment does not allow it. */
	copy(text: string): Promise<boolean>;
	/** Opens a link outside the viewer (a download, the web viewer). False when the environment refuses. */
	openExternal(url: string, label: string): Promise<boolean>;
	/** The host's own file picker, where the page's cannot be used. */
	pickFile?(): Promise<PickedFile | null>;
	/** The web viewer's address for a route, when this is not the web viewer. */
	webViewer?(route: string): string;
	/** Recently viewed files, kept on this device, where the environment has room for them. */
	recent?: RecentStore;
	/** The site's models and their versions, where it has a catalogue. */
	catalogue?: Catalogue;
}
