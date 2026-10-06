// Turns whatever someone pastes, drops or sends into a source: a Blossom blob, an https file, or a Nostr event that
// points at one. GitHub page links become raw links; addresses a browser app can never read are refused with a reason.
import type { Source } from '$lib/state/hash';
import { blobOfUrl, HEX64, parseBlossomUri } from './blossom';
import { githubRaw } from './github';

export type Resolved = { source: Source; name?: string } | { error: string };

const POINTER = /^(?:note|nevent|naddr)1[02-9ac-hj-np-z]{6,}$/;
const PROFILE = /^(?:npub|nprofile)1[02-9ac-hj-np-z]{6,}$/;

const unique = (list: string[]) => [...new Set(list)];

function fileName(url: URL) {
	try {
		const name = decodeURIComponent(url.pathname.split('/').pop() ?? '');
		return name && !HEX64.test(name.replace(/\.[a-z0-9]+$/i, '')) ? name : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The source a link names. `sha256` pins it to known bytes; `servers` are Blossom servers to try first, `fallback` the
 * ones to try after those a link names itself.
 */
export function resolveLink(link: string, options: { sha256?: string; servers?: string[]; fallback?: string[] } = {}): Resolved | null {
	const text = link.trim();
	const sha = options.sha256?.toLowerCase();
	const pin = sha && HEX64.test(sha) ? { sha256: sha } : {};
	const extra = options.servers ?? [];
	const fallback = options.fallback ?? [];

	if (text.startsWith('blossom:')) {
		const blossom = parseBlossomUri(text);
		if (!blossom) return { error: 'That blossom: link is malformed.' };
		const source: Source = { kind: 'blob', sha256: blossom.sha256, servers: unique([...blossom.servers, ...extra, ...fallback]) };
		if (blossom.ext) source.ext = blossom.ext;
		if (blossom.size) source.size = blossom.size;
		if (blossom.author) source.author = blossom.author;
		return { source };
	}

	const bech32 = text.replace(/^nostr:/i, '').toLowerCase();
	if (POINTER.test(bech32)) return { source: { kind: 'nostr', pointer: bech32, ...pin } };
	if (PROFILE.test(bech32)) return { error: 'That is a Nostr profile. Paste a link to the note or file event instead.' };

	if (HEX64.test(text.toLowerCase())) {
		return { source: { kind: 'blob', sha256: text.toLowerCase(), servers: unique([...extra, ...fallback]) } };
	}

	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return null;
	}
	if (url.protocol === 'http:') return { error: 'Only https links can be opened here.' };
	if (url.protocol !== 'https:') return null;
	if (url.username || url.password) return { error: 'Links with a user name or password are not opened.' };
	const github = githubRaw(url);
	if (github && 'error' in github) return github;
	if (github) url = new URL(github.url);
	const blob = blobOfUrl(url);
	if (blob && (!sha || sha === blob.sha256)) {
		const source: Source = { kind: 'blob', sha256: blob.sha256, servers: unique([...blob.servers, ...extra, ...fallback]) };
		if (blob.ext) source.ext = blob.ext;
		return { source };
	}
	return { source: { kind: 'url', url: url.href, ...pin }, name: fileName(url) };
}
