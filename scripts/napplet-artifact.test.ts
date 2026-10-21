// The napplet artefact must be one self-contained page: a shell injects it as srcdoc into an opaque-origin frame, where
// nothing can be loaded by URL and no ambient network or storage exists. The converter is a Blossom blob of its own,
// fetched through the shell by the hash the page names, on first use. The manifest (NIP-5D as of 2026-10-05) names the
// page by its sha256. Runs against dist-napplet, made by `npm run build:napplet`.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { CONVERTER_FILE } from '../pipeline/converter-file.ts';
import { readConfig } from '../pipeline/nostr/config.ts';
import { NAPPLET_TEMPLATE } from '../pipeline/nostr/manifest.ts';
import { SITE } from '../pipeline/site.ts';
import { ARCHETYPE, CONVENTION, INTENT_PARAMS, OPTIONAL, REQUIRES } from '../src/lib/state/archetype.ts';
import { CONVERTER, lacking } from '../test/prerequisites.ts';

const dir = SITE.napplet;
const built = !lacking({ what: 'the napplet build', path: `${dir}/index.html`, how: 'build it with `npm run build:napplet`' });
// The converter the napplet build takes: CONVERTER_WASM, else converter/dist/converter.wasm.
const converter = { ...CONVERTER, path: process.env.CONVERTER_WASM ?? 'converter/dist/converter.wasm' };
const comparable = built && !lacking(converter);
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

describe.skipIf(!built)('napplet artefact', () => {
	const html = built ? readFileSync(`${dir}/index.html`) : Buffer.alloc(0);
	const text = html.toString('utf8');
	const manifest: { kind?: number; content?: string; tags: string[][] } = built ? JSON.parse(readFileSync(`${dir}/${NAPPLET_TEMPLATE}`, 'utf8')) : { tags: [] };
	const tags = (name: string) => manifest.tags.filter((t) => t[0] === name);

	it('is one page, with the converter beside it', () => {
		expect(readdirSync(dir).sort()).toEqual([NAPPLET_TEMPLATE, CONVERTER_FILE, 'index.html']);
		// A shell loads the page as one srcdoc string; the converter is not in it.
		expect(html.byteLength).toBeLessThan(2_000_000);
		expect(text).not.toMatch(/H4sI[A-Za-z0-9+/]{10000}/);
	});

	it('names the converter it was built with, and fetches it only through the shell', () => {
		const file = readFileSync(`${dir}/${CONVERTER_FILE}`);
		// Plain ASCII, which every shell passes on: base64 of the gzipped wasm.
		expect(file.toString('latin1')).toMatch(/^[A-Za-z0-9+/]+=*$/);
		const wasm = gunzipSync(Buffer.from(file.toString('latin1'), 'base64'));
		expect([...wasm.subarray(0, 4)]).toEqual([0, 0x61, 0x73, 0x6d]);
		if (comparable) expect(sha256(wasm)).toBe(sha256(readFileSync(converter.path)));
		// The page asks the shell for it by hash; the About section names the build.
		expect(text).toContain(`blossom:sha256:${sha256(file)}`);
		expect(text).toContain(sha256(wasm));
	});

	// The markup alone: script and style bodies are dropped, their opening tags kept.
	const markup = text
		.replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, '$1</script>')
		.replace(/(<style\b[^>]*>)[\s\S]*?<\/style>/gi, '$1</style>');

	it('references nothing by URL', () => {
		expect(markup).not.toMatch(/<script[^>]*\ssrc=/i);
		expect(markup).not.toMatch(/<link[^>]*rel=["'](stylesheet|modulepreload)/i);
		expect(markup).not.toMatch(/(src|href)=["']https?:/i);
		expect(markup).not.toMatch(/<base\b/i);
	});

	it('touches no ambient capability', () => {
		expect(text).not.toMatch(/\bimport\s*\(/);
		expect(text).not.toMatch(/\bfetch\s*\(/);
		expect(text).not.toMatch(/XMLHttpRequest\(|WebSocket\(/);
		expect(text).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|serviceWorker/);
		expect(text).not.toMatch(/window\s*\.\s*nostr/);
		// The CSP allows WebAssembly, but no string evaluation and no workers.
		expect(text).not.toMatch(/\bnew\s+Function\s*\(|\beval\s*\(|\bnew\s+(?:Shared)?Worker\s*\(/);
	});

	it('declares in its head what the manifest says', () => {
		const config = readConfig(SITE.config);
		expect(markup).toContain(`<meta name="napplet-id" content="${config.id}"`);
		expect(markup).toContain(`<meta name="napplet-requires" content="${REQUIRES.join(' ')}"`);
		expect(manifest.kind).toBe(35129);
		expect(manifest.content).toBe(config.description);
		expect(tags('d')).toEqual([['d', config.id]]);
		expect(tags('z')).toEqual([['z', ARCHETYPE]]);
		expect(tags('i')).toEqual([['i', CONVENTION, ...INTENT_PARAMS]]);
		expect(tags('R').map((t) => t[1])).toEqual(REQUIRES);
		expect(tags('O').map((t) => t[1])).toEqual(OPTIONAL);
		expect(tags('server').map((t) => t[1])).toEqual(config.servers);
	});

	it('is the one page the manifest names, by its hash', () => {
		expect(tags('x')).toEqual([['x', sha256(html)]]);
		expect(tags('path')).toEqual([]);
	});
});
