import { describe, expect, it } from 'vitest';
import { decode } from '$lib/state/hash';
import { routeFromInput } from './input';
import { resolveLink } from './links';

const A = 'a'.repeat(64);
const fallback = ['https://fallback.example'];

describe('links', () => {
	it('turns a GitHub page link into its raw address', () => {
		expect(resolveLink('https://github.com/Gangleri42/sh-hardware/blob/main/seed/Seed-v15.step')).toEqual({
			source: { kind: 'url', url: 'https://raw.githubusercontent.com/Gangleri42/sh-hardware/main/seed/Seed-v15.step' },
			name: 'Seed-v15.step'
		});
		expect(resolveLink('https://github.com/o/r/raw/feature/x/a%20b.stp?raw=true')).toMatchObject({
			source: { url: 'https://raw.githubusercontent.com/o/r/feature/x/a%20b.stp' },
			name: 'a b.stp'
		});
	});

	it('explains GitHub links a browser app cannot read', () => {
		expect(resolveLink('https://github.com/o/r/tree/main/cad')).toEqual({ error: expect.stringMatching(/folder/) });
		expect(resolveLink('https://github.com/o/r/releases/download/v1/a.step')).toEqual({ error: expect.stringMatching(/release/) });
	});

	it('reads Blossom in all its spellings', () => {
		expect(resolveLink(`https://cdn.example/${A}.step`, { fallback })).toEqual({ source: { kind: 'blob', sha256: A, ext: 'step', servers: ['https://cdn.example', 'https://fallback.example'] } });
		expect(resolveLink(`blossom:sha256:${A}`, { servers: ['https://a.example'], fallback })).toEqual({ source: { kind: 'blob', sha256: A, servers: ['https://a.example', 'https://fallback.example'] } });
		expect(resolveLink(`blossom:${A}.step?xs=b.example&sz=10`)).toEqual({ source: { kind: 'blob', sha256: A, ext: 'step', servers: ['https://b.example'], size: 10 } });
		expect(resolveLink(A.toUpperCase(), { fallback })).toEqual({ source: { kind: 'blob', sha256: A, servers: fallback } });
	});

	it('keeps a URL whose bytes do not match its Blossom-looking name as a URL', () => {
		expect(resolveLink(`https://cdn.example/${A}.step`, { sha256: 'b'.repeat(64) })).toMatchObject({ source: { kind: 'url' } });
	});

	it('points at Nostr events, not profiles', () => {
		expect(resolveLink('nostr:note1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsxxxxxx')).toMatchObject({ source: { kind: 'nostr' } });
		expect(resolveLink('npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsxxxxxx')).toEqual({ error: expect.stringMatching(/profile/) });
	});

	it('refuses what a browser app must not open', () => {
		expect(resolveLink('http://example.com/a.step')).toEqual({ error: expect.stringMatching(/https/) });
		expect(resolveLink('https://user:pw@example.com/a.step')).toEqual({ error: expect.any(String) });
		expect(resolveLink('javascript:alert(1)')).toBeNull();
		expect(resolveLink('just some words')).toBeNull();
	});
});

describe('pasted input', () => {
	it('opens a stepstr link as it is', () => {
		expect(routeFromInput(`https://stepstr.example/#/b/${A}?cut=x:1`)).toEqual({ route: `#/b/${A}?cut=x:1` });
	});

	it('opens a convention URI', () => {
		const result = routeFromInput(`napplet:3d-model/open?url=${encodeURIComponent(`blossom:sha256:${A}`)}&name=part.step`, fallback);
		expect('route' in result && decode(result.route)).toMatchObject({ source: { kind: 'blob', sha256: A, servers: fallback }, name: 'part.step' });
	});

	it('names a URL source after its file', () => {
		const result = routeFromInput('https://example.com/cad/Bracket%20v2.step');
		expect('route' in result && decode(result.route)).toMatchObject({ source: { kind: 'url' }, name: 'Bracket v2.step' });
	});

	it('says what is wrong', () => {
		expect(routeFromInput('   ')).toEqual({ error: expect.any(String) });
		expect(routeFromInput('hello')).toEqual({ error: expect.stringMatching(/link/) });
		expect(routeFromInput('napplet:3d-model/open')).toEqual({ error: expect.any(String) });
	});
});
