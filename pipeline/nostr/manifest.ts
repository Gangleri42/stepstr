// Manifests. A site's (NIP-5A) lists every file by absolute path and sha256, plus the aggregate hash over those pairs.
// A napplet's (NIP-5D as of 2026-10-05) names its one artifact, /index.html, by its sha256, carries its description as
// the content, and declares what it does and needs in tags. Snapshots copy a manifest under an unchangeable kind.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import type { Event, EventTemplate } from 'nostr-tools/core';
import { KIND, mimeOf } from './config.ts';
import { isSiteId, SITE_ID_RULE } from './nsite.ts';

/** A file of the site. `file` is the local copy; a carried-over file has none, and its size may be unknown (0). */
export type FileEntry = { path: string; sha256: string; bytes: number; type: string; file?: string };

export const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

/** The napplet's unsigned manifest, written by the build next to index.html (pipeline/napplet-manifest.ts). */
export const NAPPLET_TEMPLATE = '.nip5d-manifest.json';

const hasExtension = (path: string) => /^[^.].*\.[A-Za-z0-9]+$/.test(posix.basename(path));

/** Every file below `root` as an absolute site path. Files without an extension are not allowed by NIP-5A. */
export function collectFiles(root: string, exclude: string[] = []): FileEntry[] {
	const entries: FileEntry[] = [];
	const walk = (dir: string, prefix: string) => {
		for (const name of readdirSync(dir).sort()) {
			const file = `${dir}/${name}`;
			const path = `${prefix}/${name}`;
			if (statSync(file).isDirectory()) walk(file, path);
			else if (!exclude.includes(path)) entries.push({ path, file, ...hashFile(file), type: mimeOf(path) });
		}
	};
	walk(root, '');
	const bare = entries.filter((e) => !hasExtension(e.path)).map((e) => e.path);
	if (bare.length) throw new Error(`NIP-5A paths need a filename extension; exclude or rename: ${bare.join(', ')}`);
	return entries;
}

function hashFile(file: string) {
	const data = readFileSync(file);
	return { sha256: sha256(data), bytes: data.byteLength };
}

/** sha256 over the sorted lines "<sha256> <path>\n" (NIP-5A). */
export function aggregate(entries: { path: string; sha256: string }[]) {
	return sha256(
		entries
			.map((e) => `${e.sha256} ${e.path}\n`)
			.sort()
			.join('')
	);
}

const pathTags = (entries: FileEntry[]) => [...entries].sort((a, b) => (a.path < b.path ? -1 : 1)).map((e) => ['path', e.path, e.sha256]);
const now = () => Math.floor(Date.now() / 1000);

export type ManifestOptions = {
	id: string;
	entries: FileEntry[];
	servers: string[];
	title: string;
	description: string;
	source?: string;
	created_at?: number;
};

export function siteTemplate(o: ManifestOptions): EventTemplate {
	if (!isSiteId(o.id)) throw new Error(`d tag "${o.id}" must be ${SITE_ID_RULE}`);
	const tags: string[][] = [
		['d', o.id],
		...pathTags(o.entries),
		['x', aggregate(o.entries), 'aggregate'],
		...o.servers.map((s) => ['server', s]),
		['title', o.title],
		['description', o.description]
	];
	if (o.source) tags.push(['source', o.source]);
	return { kind: KIND.site, created_at: o.created_at ?? now(), content: '', tags };
}

export type NappletOptions = {
	id: string;
	/** The sha256 of /index.html. */
	artifact: string;
	servers: string[];
	title: string;
	description: string;
	source?: string;
	archetypes: string[];
	/** Each intent: its identity, then the names of the parameters it advertises. */
	intents: string[][];
	/** Shell domains, bare: the ones it cannot work without, and the ones it uses when they are there. */
	requires: string[];
	optional: string[];
	created_at?: number;
};

export function nappletTemplate(o: NappletOptions): EventTemplate {
	if (!isSiteId(o.id)) throw new Error(`d tag "${o.id}" must be ${SITE_ID_RULE}`);
	const tags: string[][] = [
		['d', o.id],
		['x', o.artifact],
		...o.archetypes.map((z) => ['z', z]),
		...o.intents.map((i) => ['i', ...i]),
		...o.requires.map((r) => ['R', r]),
		...o.optional.map((r) => ['O', r]),
		...o.servers.map((s) => ['server', s]),
		['title', o.title]
	];
	if (o.source) tags.push(['source', o.source]);
	return { kind: KIND.napplet, created_at: o.created_at ?? now(), content: o.description, tags };
}

/** A napplet template's declarations as options again: the build writes the template, the publisher signs it. */
export function nappletOptions(t: { content: string; tags: string[][] }): NappletOptions {
	return {
		id: tagValue(t, 'd') ?? '',
		artifact: tagValue(t, 'x') ?? '',
		servers: tagValues(t, 'server'),
		title: tagValue(t, 'title') ?? '',
		description: t.content,
		source: tagValue(t, 'source'),
		archetypes: tagValues(t, 'z'),
		intents: t.tags.filter((tag) => tag[0] === 'i').map((tag) => tag.slice(1)),
		requires: tagValues(t, 'R'),
		optional: tagValues(t, 'O')
	};
}

const unescapeHtml = (text: string) => text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * What a napplet's page declares about itself (NIP-5D, HTML Metadata for Publishing): its <title>, the description and
 * the napplet-* meta elements. Archetypes, intents and servers repeat; the domain lists are separated by whitespace.
 */
export function nappletDeclarations(html: string): Omit<NappletOptions, 'artifact' | 'created_at'> {
	// Script and style bodies can hold any text; only the markup declares.
	const markup = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
	const metas = [...markup.matchAll(/<meta\s+name="([^"]+)"\s+content="([^"]*)"\s*\/?>/gi)].map(([, name, content]) => [name.toLowerCase(), unescapeHtml(content).trim()]);
	const all = (name: string) => metas.filter(([n]) => n === name).map(([, content]) => content);
	const words = (name: string) => all(name).flatMap((content) => content.split(/\s+/).filter(Boolean));
	const title = /<title>([^<]*)<\/title>/i.exec(markup)?.[1];
	return {
		id: all('napplet-id')[0] ?? '',
		servers: all('napplet-server'),
		title: title ? unescapeHtml(title).trim() : '',
		description: all('description')[0] ?? '',
		source: all('napplet-source')[0],
		archetypes: all('napplet-archetype'),
		intents: all('napplet-intent').map((content) => content.split(/\s+/).filter(Boolean)),
		requires: words('napplet-requires'),
		optional: words('napplet-optional')
	};
}

/**
 * A signed manifest again under its unchangeable kind. A site's snapshot keeps the paths and points back with an `a`
 * tag; a napplet's keeps its declarations and names the napplet its line comes from with `A`.
 */
export function snapshotTemplate(source: Event, relayHint: string, created_at = now()): EventTemplate {
	const d = tagValue(source, 'd');
	if (!d) throw new Error('the source manifest has no d tag');
	const address = `${source.kind}:${source.pubkey}:${d}`;
	const kept = source.tags.filter((t) => t[0] !== 'd' && t[0] !== 'a' && t[0] !== 'A');
	if (source.kind === KIND.site) return { kind: KIND.siteSnapshot, created_at, content: '', tags: [['a', address, relayHint], ...kept] };
	if (source.kind === KIND.napplet) return { kind: KIND.nappletSnapshot, created_at, content: source.content, tags: [['A', address], ...kept] };
	throw new Error(`no snapshot kind for kind ${source.kind}`);
}

const isNapplet = (kind: number) => kind === KIND.napplet || kind === KIND.nappletSnapshot;

/** Checks a manifest before it is signed, and again after it is fetched back: NIP-5A for a site, NIP-5D for a napplet. */
export function validate(event: EventTemplate | Event, options: { snapshot?: boolean } = {}) {
	const problems = isNapplet(event.kind) ? nappletProblems(event, options) : siteProblems(event, options);
	if (problems.length) throw new Error(`manifest is invalid: ${problems.join('; ')}`);
	return true;
}

function siteProblems(event: EventTemplate | Event, options: { snapshot?: boolean }) {
	const of = (name: string) => event.tags.filter((t) => t[0] === name);
	const problems: string[] = [];
	const paths = of('path');
	if (!paths.length) problems.push('no path tags');
	for (const [, path, hash] of paths) {
		if (!path?.startsWith('/') || !hasExtension(path)) problems.push(`path "${path}" is not absolute with an extension`);
		if (!/^[0-9a-f]{64}$/.test(hash ?? '')) problems.push(`path "${path}" has no sha256`);
	}
	if (new Set(paths.map((t) => t[1])).size !== paths.length) problems.push('duplicate paths');
	const x = of('x');
	if (x.length !== 1) problems.push(`expected one x tag, found ${x.length}`);
	else if (x[0][1] !== aggregate(paths.map((t) => ({ path: t[1], sha256: t[2] })))) problems.push('x tag does not match the aggregate of the path tags');
	const a = of('a');
	if (options.snapshot) {
		if (of('d').length) problems.push('a snapshot must not have a d tag');
		if (a.length !== 1) problems.push(`a snapshot needs exactly one a tag, found ${a.length}`);
		if (event.kind !== KIND.siteSnapshot) problems.push(`kind ${event.kind} is not the site snapshot kind`);
	} else {
		const d = of('d');
		if (d.length !== 1 || !isSiteId(d[0][1] ?? '')) problems.push('d tag missing or invalid');
	}
	return problems;
}

function nappletProblems(event: EventTemplate | Event, options: { snapshot?: boolean }) {
	const of = (name: string) => event.tags.filter((t) => t[0] === name);
	const problems: string[] = [];
	const x = of('x');
	if (x.length !== 1 || !/^[0-9a-f]{64}$/.test(x[0][1] ?? '')) problems.push(`expected one x tag holding the sha256 of /index.html, found ${x.length}`);
	if (of('path').length) problems.push('a napplet has no path tags: its one artifact is named by x');
	if (of('description').length) problems.push('the description is the content, not a tag');
	if (!event.content.trim()) problems.push('the content must describe the napplet');
	for (const name of ['R', 'O']) {
		for (const [, domain] of of(name)) if (!/^[a-z][a-z0-9-]*$/.test(domain ?? '')) problems.push(`${name} tag "${domain}" is not a bare NAP domain`);
	}
	for (const [, intent] of of('i')) if (!intent || intent.includes('?')) problems.push(`intent "${intent}" must be a queryless identity`);
	const d = of('d');
	if (options.snapshot) {
		if (event.kind !== KIND.nappletSnapshot) problems.push(`kind ${event.kind} is not the napplet snapshot kind`);
		if (d.length) problems.push('a snapshot must not have a d tag');
		if (of('A').length > 1 || of('a').length > 1) problems.push('a snapshot has at most one A and one a tag');
	} else if (d.length !== 1 || !isSiteId(d[0][1] ?? '')) problems.push('d tag missing or invalid');
	return problems;
}

export const tagValue = (event: { tags: string[][] }, name: string) => event.tags.find((t) => t[0] === name)?.[1];
export const tagValues = (event: { tags: string[][] }, name: string) => event.tags.filter((t) => t[0] === name).map((t) => t[1]);

/** The blobs a manifest names: a site's files by path, a napplet's artifact by its x tag. */
export function blobsOf(manifest: { kind: number; tags: string[][] }) {
	return isNapplet(manifest.kind) ? tagValues(manifest, 'x') : manifest.tags.filter((t) => t[0] === 'path').map((t) => t[2]);
}

/**
 * "<server> <sha256>" for each blob a published manifest names, on each server it names. A manifest goes out only
 * after its blobs were downloaded and hashed on those servers, so a publish need not download these again.
 */
export function verifiedPairs(manifests: ({ kind: number; tags: string[][] } | null)[]) {
	const pairs = new Set<string>();
	for (const manifest of manifests) {
		if (!manifest) continue;
		const servers = tagValues(manifest, 'server');
		for (const sha256 of blobsOf(manifest)) for (const server of servers) pairs.add(`${server} ${sha256}`);
	}
	return pairs;
}
