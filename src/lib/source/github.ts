// GitHub serves a repository file's bytes to browser apps only from raw.githubusercontent.com, and Git LFS content from
// media.githubusercontent.com, both readable from any origin. Page links are rewritten there; links that cannot work
// in a browser say why.
export type GitHubLink = { url: string } | { error: string } | null;

/** The raw address of a github.com file link, an explanation for a link that cannot work, or null if not GitHub. */
export function githubRaw(url: URL): GitHubLink {
	if (url.hostname === 'raw.githubusercontent.com') return { url: url.href };
	if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null;
	const [owner, repo, kind, ...rest] = url.pathname.split('/').filter(Boolean);
	if (!owner || !repo) return { error: 'That GitHub link does not point at a file.' };
	if (kind === 'blob' || kind === 'raw') {
		if (rest.length < 2) return { error: 'That GitHub link does not point at a file.' };
		return { url: `https://raw.githubusercontent.com/${owner}/${repo}/${rest.join('/')}` };
	}
	if (kind === 'tree') return { error: 'That is a folder on GitHub; link to the STEP file itself.' };
	if (kind === 'releases') {
		return { error: 'GitHub release downloads cannot be read by browser apps. Link to the file in the repository, or put it on a Blossom server.' };
	}
	return { error: 'That GitHub link does not point at a file.' };
}

/** A Git LFS pointer: the file's real bytes live elsewhere, named by this sha256. */
export function lfsPointer(bytes: Uint8Array): { oid: string; size: number } | null {
	if (bytes.length > 512) return null;
	const text = new TextDecoder().decode(bytes);
	const match = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n?$/.exec(text);
	return match ? { oid: match[1], size: Number(match[2]) } : null;
}

/** Where GitHub serves the LFS content behind a raw.githubusercontent.com address. */
export function lfsMediaUrl(raw: string): string | null {
	const url = new URL(raw);
	return url.hostname === 'raw.githubusercontent.com' ? `https://media.githubusercontent.com/media${url.pathname}` : null;
}
