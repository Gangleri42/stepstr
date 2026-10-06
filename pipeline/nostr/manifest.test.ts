import { describe, expect, it } from 'vitest';
import type { Event } from 'nostr-tools/core';
import { aggregate, nappletDeclarations, nappletOptions, nappletTemplate, siteTemplate, snapshotTemplate, validate, verifiedPairs, type FileEntry, type NappletOptions } from './manifest.ts';

const A = 'a'.repeat(64), B = 'b'.repeat(64);
const entries: FileEntry[] = [
	{ path: '/index.html', sha256: A, bytes: 10, type: 'text/html' },
	{ path: '/a.css', sha256: B, bytes: 5, type: 'text/css' }
];
const base = { id: 'stepstr', entries, servers: ['https://blossom.example.com'], title: 'T', description: 'D', created_at: 1_790_000_000 };
const C = 'c'.repeat(64);
const napplet: NappletOptions = {
	id: 'stepstr',
	artifact: C,
	servers: ['https://blossom.example.com'],
	title: 'stepstr',
	description: 'Opens STEP files',
	source: 'nostr://x',
	archetypes: ['3d-model'],
	intents: [['napplet:3d-model/open', 'url', 'sha256']],
	requires: ['inc', 'resource'],
	optional: ['theme'],
	created_at: 1_790_000_000
};

describe('nsite manifest', () => {
	it('aggregates sorted "<sha256> <path>" lines', () => {
		expect(aggregate(entries)).toBe('b5b0bfeec21afd5be39206e47f20e4e5177073c0e6e83c36418809110073967c');
		expect(aggregate([...entries].reverse())).toBe(aggregate(entries));
	});

	it('builds a valid site manifest', () => {
		const t = siteTemplate({ ...base, source: 'nostr://x' });
		expect(t.kind).toBe(35128);
		expect(t.tags.slice(0, 4)).toEqual([['d', 'stepstr'], ['path', '/a.css', B], ['path', '/index.html', A], ['x', aggregate(entries), 'aggregate']]);
		expect(t.tags).toContainEqual(['server', 'https://blossom.example.com']);
		expect(validate(t)).toBe(true);
	});

	it('builds a napplet manifest the NIP-5D way: one artifact, the description as content, declarations as tags', () => {
		const t = nappletTemplate(napplet);
		expect(t.kind).toBe(35129);
		expect(t.content).toBe('Opens STEP files');
		expect(t.tags).toEqual([
			['d', 'stepstr'],
			['x', C],
			['z', '3d-model'],
			['i', 'napplet:3d-model/open', 'url', 'sha256'],
			['R', 'inc'],
			['R', 'resource'],
			['O', 'theme'],
			['server', 'https://blossom.example.com'],
			['title', 'stepstr'],
			['source', 'nostr://x']
		]);
		expect(validate(t)).toBe(true);
		expect(nappletOptions(t)).toEqual({ ...napplet, created_at: undefined });
	});

	it('reads what a napplet page declares in its head, and nothing from its scripts', () => {
		const html = `<!doctype html><html><head><title> stepstr </title>
			<meta name="description" content="Opens &quot;STEP&quot; files" />
			<meta name="napplet-id" content="stepstr" />
			<meta name="napplet-archetype" content="3d-model" />
			<meta name="napplet-intent" content="napplet:3d-model/open url  sha256" />
			<meta name="napplet-requires" content="inc resource" />
			<meta name="napplet-optional" content="theme" />
			<meta name="napplet-source" content="nostr://x" />
			<meta name="napplet-server" content="https://one.example.com" />
			<meta name="napplet-server" content="https://two.example.com" />
			<script type="module">const s = '<meta name="napplet-requires" content="relay" />';</script></head><body></body></html>`;
		expect(nappletDeclarations(html)).toEqual({
			id: 'stepstr',
			servers: ['https://one.example.com', 'https://two.example.com'],
			title: 'stepstr',
			description: 'Opens "STEP" files',
			source: 'nostr://x',
			archetypes: ['3d-model'],
			intents: [['napplet:3d-model/open', 'url', 'sha256']],
			requires: ['inc', 'resource'],
			optional: ['theme']
		});
	});

	it('refuses napplet manifests NIP-5D does not allow', () => {
		const t = nappletTemplate(napplet);
		const without = (name: string) => t.tags.filter((tag) => tag[0] !== name);
		expect(() => validate({ ...t, tags: [...t.tags, ['path', '/index.html', C]] })).toThrow(/path/);
		expect(() => validate({ ...t, tags: [...t.tags, ['x', A]] })).toThrow(/one x tag/);
		expect(() => validate({ ...t, tags: without('x') })).toThrow(/one x tag/);
		expect(() => validate({ ...t, content: ' ' })).toThrow(/content/);
		expect(() => validate({ ...t, tags: [...t.tags, ['description', 'D']] })).toThrow(/content, not a tag/);
		expect(() => validate({ ...t, tags: [...t.tags, ['i', 'napplet:3d-model/open?url=x']] })).toThrow(/queryless/);
		expect(() => validate({ ...t, tags: [...t.tags, ['R', 'NAP-RELAY']] })).toThrow(/bare NAP domain/);
	});

	it('rejects bad ids and paths', () => {
		expect(() => siteTemplate({ ...base, id: 'a-site-id-too-long' })).toThrow(/d tag/);
		expect(() => siteTemplate({ ...base, id: 'bad-' })).toThrow(/d tag/);
		expect(() => validate({ ...siteTemplate(base), tags: [['d', 'x'], ['path', '/CNAME', A], ['x', aggregate([{ path: '/CNAME', sha256: A }]), 'aggregate']] })).toThrow(/extension/);
		expect(() => validate({ ...siteTemplate(base), tags: [['d', 'x'], ['path', '/i.html', A], ['x', B, 'aggregate']] })).toThrow(/aggregate/);
	});

	it('derives a snapshot that points back at its source', () => {
		const source = { ...siteTemplate(base), id: 'e'.repeat(64), pubkey: 'p'.repeat(64), sig: '' } as unknown as Event;
		const snapshot = snapshotTemplate(source, 'wss://relay.example.com', 1_790_000_001);
		expect(snapshot.kind).toBe(5128);
		expect(snapshot.tags[0]).toEqual(['a', `35128:${'p'.repeat(64)}:stepstr`, 'wss://relay.example.com']);
		expect(snapshot.tags.filter((t) => t[0] === 'd')).toHaveLength(0);
		expect(snapshot.tags.filter((t) => t[0] === 'path')).toHaveLength(2);
		expect(validate(snapshot, { snapshot: true })).toBe(true);
		expect(() => validate(snapshot)).toThrow(/d tag/);
	});

	it("derives a napplet snapshot that keeps the declarations and names the napplet's line", () => {
		const source = { ...nappletTemplate(napplet), id: 'e'.repeat(64), pubkey: 'p'.repeat(64), sig: '' } as unknown as Event;
		const snapshot = snapshotTemplate(source, 'wss://relay.example.com', 1_790_000_001);
		expect(snapshot.kind).toBe(5129);
		expect(snapshot.content).toBe('Opens STEP files');
		expect(snapshot.tags[0]).toEqual(['A', `35129:${'p'.repeat(64)}:stepstr`]);
		expect(snapshot.tags.filter((t) => t[0] === 'd')).toHaveLength(0);
		expect(snapshot.tags).toContainEqual(['x', C]);
		expect(validate(snapshot, { snapshot: true })).toBe(true);
	});

	it('pairs every blob a manifest names with every server it names as verified', () => {
		const site = siteTemplate({ ...base, servers: ['https://one.example.com', 'https://two.example.com'] });
		const app = nappletTemplate({ ...napplet, servers: ['https://one.example.com'] });
		expect([...verifiedPairs([site, app, null])].sort()).toEqual([
			`https://one.example.com ${A}`,
			`https://one.example.com ${B}`,
			`https://one.example.com ${C}`,
			`https://two.example.com ${A}`,
			`https://two.example.com ${B}`
		]);
		// A server a manifest does not name has verified nothing of it, and without manifests nothing was verified.
		expect(verifiedPairs([app]).has(`https://two.example.com ${C}`)).toBe(false);
		expect(verifiedPairs([null, null]).size).toBe(0);
	});
});
