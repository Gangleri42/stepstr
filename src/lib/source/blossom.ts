// Blossom names a file by its sha256 (BUD-01); a blossom: URI adds server hints (BUD-10); napplet shells take the
// canonical blossom:sha256:<hex> (NAP-RESOURCE).
export const HEX64 = /^[0-9a-f]{64}$/;

export type BlossomRef = { sha256: string; ext: string; servers: string[]; author?: string; size?: number };

export const extOf = (path: string) => (/\.([a-z0-9]{1,8})$/i.exec(path)?.[1] ?? '').toLowerCase();

const origin = (server: string) => server.replace(/\/+$/, '');

/** https://<server>/<sha256>.<ext>, the BUD-01 address of a blob. */
export function blobUrl(server: string, sha256: string, ext?: string) {
	return `${origin(server)}/${sha256}${ext ? `.${ext}` : ''}`;
}

/**
 * A BUD-10 URI (blossom:<sha256>.<ext>?xs=<server>&…&as=<author>&sz=<bytes>) or the canonical blossom:sha256:<hex>, or
 * null.
 */
export function parseBlossomUri(uri: string): BlossomRef | null {
	const canonical = /^blossom:sha256:([0-9a-f]{64})$/i.exec(uri.trim());
	if (canonical) return { sha256: canonical[1].toLowerCase(), ext: '', servers: [] };
	const match = /^blossom:([0-9a-f]{64})(?:\.([a-z0-9]+))?(?:\?(.*))?$/i.exec(uri.trim());
	if (!match) return null;
	const params = new URLSearchParams(match[3] ?? '');
	const size = Number(params.get('sz'));
	const author = params.get('as')?.toLowerCase();
	return {
		sha256: match[1].toLowerCase(),
		ext: (match[2] ?? '').toLowerCase(),
		servers: params.getAll('xs').map((s) => origin(/^https?:\/\//.test(s) ? s : `https://${s}`)),
		author: author && HEX64.test(author) ? author : undefined,
		size: Number.isSafeInteger(size) && size > 0 ? size : undefined
	};
}

/** The blob an https URL names in BUD-01 form (…/<sha256>[.ext]), with its server, or null. */
export function blobOfUrl(url: URL): BlossomRef | null {
	const match = /\/([0-9a-f]{64})(?:\.([a-z0-9]{1,8}))?$/i.exec(url.pathname);
	if (url.protocol !== 'https:' || !match || url.search) return null;
	return { sha256: match[1].toLowerCase(), ext: (match[2] ?? '').toLowerCase(), servers: [url.origin] };
}
