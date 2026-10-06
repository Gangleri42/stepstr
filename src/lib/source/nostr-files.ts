// Files a Nostr event points at: a NIP-94 file event (kind 1063) describes one with tags, any other event may carry
// NIP-92 imeta tags for the files its text links to. Only STEP files count here.
import { blobOfUrl, HEX64 } from './blossom';

export type NostrEventLike = { kind: number; pubkey: string; tags: string[][]; content: string };

export type FileCandidate = {
	url?: string;
	sha256?: string;
	mime?: string;
	/** A name to show: the event's own, or the last part of the URL. */
	name?: string;
	size?: number;
	/** Blossom servers that should hold the file, most specific first. */
	servers: string[];
};

const STEP_TYPES = new Set(['model/step', 'model/step+zip', 'application/step', 'application/x-step', 'model/x-step', 'application/p21']);
const STEP_NAME = /\.(step|stp|stpz|p21)$/i;

function https(text: string | undefined) {
	if (!text) return null;
	try {
		const url = new URL(text);
		return url.protocol === 'https:' ? url : null;
	} catch {
		return null;
	}
}

const nameOf = (url: URL) => {
	try {
		return decodeURIComponent(url.pathname.split('/').pop() ?? '') || undefined;
	} catch {
		return undefined;
	}
};

function candidate(fields: Map<string, string[]>): FileCandidate {
	const first = (key: string) => fields.get(key)?.[0];
	const url = https(first('url'));
	const sha = first('x')?.toLowerCase();
	const size = Number(first('size'));
	const servers: string[] = [];
	for (const link of [url, ...(fields.get('fallback') ?? []).map(https)]) {
		const blob = link && blobOfUrl(link);
		if (blob && (!sha || blob.sha256 === sha)) servers.push(blob.servers[0]);
	}
	return {
		url: url?.href,
		sha256: sha && HEX64.test(sha) ? sha : undefined,
		mime: first('m')?.toLowerCase(),
		name: first('name') ?? (url ? nameOf(url) : undefined),
		size: Number.isSafeInteger(size) && size > 0 ? size : undefined,
		servers
	};
}

const isStep = (c: FileCandidate) => (c.mime && STEP_TYPES.has(c.mime)) || STEP_NAME.test(c.name ?? '') || STEP_NAME.test(c.url ?? '');

/** The STEP files an event points at, with the Blossom servers its tags name. */
export function stepFilesOf(event: NostrEventLike): FileCandidate[] {
	const found: FileCandidate[] = [];
	if (event.kind === 1063) {
		const fields = new Map<string, string[]>();
		for (const [key, value] of event.tags) if (value !== undefined) fields.set(key, [...(fields.get(key) ?? []), value]);
		found.push(candidate(fields));
	}
	for (const tag of event.tags) {
		if (tag[0] !== 'imeta') continue;
		const fields = new Map<string, string[]>();
		for (const entry of tag.slice(1)) {
			const space = entry.indexOf(' ');
			if (space <= 0) continue;
			const key = entry.slice(0, space);
			fields.set(key, [...(fields.get(key) ?? []), entry.slice(space + 1).trim()]);
		}
		found.push(candidate(fields));
	}
	const listed = event.tags.filter((t) => t[0] === 'server').map((t) => https(t[1])?.origin).filter((s): s is string => !!s);
	return found.filter(isStep).map((c) => ({ ...c, servers: [...new Set([...c.servers, ...listed])] }));
}
