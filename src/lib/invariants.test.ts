// The rules stepstr keeps whatever a server, a relay, a shell or a link does. Each rule is stated once and checked
// against the real modules, with the untrusted party replaced by one that misbehaves. (That the napplet itself never
// touches the network, storage or eval is checked on the built file, in scripts/napplet-artifact.test.ts.)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nip19 from 'nostr-tools/nip19';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureCatalogue } from '$lib/catalogue/fixture';
import { companionFile, resolveModel, type CatalogueSource } from '$lib/catalogue/versions';
import { converterFetcher } from '$lib/convert/converter-source';
import type { Host, Transport } from '$lib/host/host';
import { TransportError } from '$lib/host/host';
import { nappletTransport } from '$lib/host/napplet-transport';
import { webTransport } from '$lib/host/web-transport';
import { listedStep, openPublished } from '$lib/open/published';
import { loadSource } from '$lib/source/load';
import type { NostrEventLike } from '$lib/source/nostr-files';
import { sha256Hex } from '$lib/source/sha256';
import { decode } from '$lib/state/hash';
import { routeFromPayload } from '$lib/state/route';

const utf8 = (text: string) => new TextEncoder().encode(text);
const STEP = utf8('ISO-10303-21;\n/* the file the link names */\nEND-ISO-10303-21;\n');
const OTHER = utf8('ISO-10303-21;\n/* some other file */\nEND-ISO-10303-21;\n');
const PIN = sha256Hex(STEP);

const hostWith = (transport: Transport) => ({ transport, servers: ['https://default.example'] }) as Host;
const response = (bytes: Uint8Array) => new Response(bytes.slice().buffer as ArrayBuffer, { status: 200 });

/** A NIP-5D shell as the napplet sees it: window.napplet with the given domains. */
const shell = (napplet: object) => vi.stubGlobal('napplet', napplet);
const idOf = (event: unknown) => (event as { id?: string } | null)?.id;

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('a link pinned to a sha256 opens those bytes or nothing', () => {
	it('from Blossom servers on the web: a server that sends other bytes is passed over', async () => {
		const served: Record<string, Uint8Array> = { 'https://liar.example': OTHER, 'https://good.example': STEP };
		vi.stubGlobal('fetch', async (url: string) => response(served[new URL(url).origin] ?? OTHER));
		const loaded = await loadSource({ kind: 'blob', sha256: PIN, servers: ['https://liar.example', 'https://good.example'] }, null, hostWith(webTransport()), () => {});
		expect(sha256Hex(loaded.bytes)).toBe(PIN);

		vi.stubGlobal('fetch', async () => response(OTHER));
		await expect(loadSource({ kind: 'blob', sha256: PIN, servers: ['https://liar.example'] }, null, hostWith(webTransport()), () => {})).rejects.toMatchObject({ reason: 'mismatch' });
	});

	it('from Blossom through a shell: a shell that answers with other bytes is not believed', async () => {
		shell({ resource: { bytes: async () => new Blob([OTHER]) } });
		await expect(loadSource({ kind: 'blob', sha256: PIN, servers: ['https://a.example'] }, null, hostWith(nappletTransport()), () => {})).rejects.toMatchObject({
			reason: 'mismatch'
		});
		// The canonical request lies, a server's own address does not.
		shell({ resource: { bytes: async (url: string) => new Blob([url.startsWith('blossom:') ? OTHER : STEP]) } });
		const loaded = await loadSource({ kind: 'blob', sha256: PIN, servers: ['https://a.example'] }, null, hostWith(nappletTransport()), () => {});
		expect(sha256Hex(loaded.bytes)).toBe(PIN);
	});

	it('from a URL, including one that answers with a Git LFS pointer to other content', async () => {
		const link = 'https://files.example/part.step';
		vi.stubGlobal('fetch', async () => response(OTHER));
		await expect(loadSource({ kind: 'url', url: link, sha256: PIN }, null, hostWith(webTransport()), () => {})).rejects.toMatchObject({ reason: 'mismatch' });

		const raw = 'https://raw.githubusercontent.com/o/r/main/part.step';
		const pointer = utf8(`version https://git-lfs.github.com/spec/v1\noid sha256:${sha256Hex(OTHER)}\nsize ${OTHER.length}\n`);
		vi.stubGlobal('fetch', async (url: string) => response(url === raw ? pointer : OTHER));
		await expect(loadSource({ kind: 'url', url: raw, sha256: PIN }, null, hostWith(webTransport()), () => {})).rejects.toMatchObject({ reason: 'mismatch' });
	});

	it('through a Nostr event, however the event changes', async () => {
		const events: Record<string, NostrEventLike> = {};
		const transport: Transport = {
			blob: async () => ({ bytes: OTHER, url: null }),
			url: async () => OTHER,
			event: async (pointer) => events[pointer] ?? null
		};
		// The event now names another file by hash.
		events.naddr1moved = { kind: 1063, pubkey: 'p'.repeat(64), content: '', tags: [['url', 'https://files.example/part.step'], ['m', 'model/step'], ['x', sha256Hex(OTHER)]] };
		await expect(loadSource({ kind: 'nostr', pointer: 'naddr1moved', sha256: PIN }, null, hostWith(transport), () => {})).rejects.toMatchObject({ reason: 'mismatch' });
		// It names a file by URL only, and the URL now serves other bytes.
		events.naddr1url = { kind: 1, pubkey: 'p'.repeat(64), content: '', tags: [['imeta', 'url https://files.example/part.step', 'm model/step']] };
		await expect(loadSource({ kind: 'nostr', pointer: 'naddr1url', sha256: PIN }, null, hostWith(transport), () => {})).rejects.toMatchObject({ reason: 'mismatch' });
	});

	it("from a site's catalogue: a version opens the STEP file the catalogue names, by its hash", async () => {
		const catalogue = fixtureCatalogue();
		catalogue.models.stand.versions[1].step.sha256 = PIN;
		const named = (route: string) => resolveModel(catalogue, decode(route, catalogue).source as CatalogueSource)!;
		const { file } = named('#/stand@1111111');
		expect(file).toEqual({ kind: 'url', url: catalogue.models.stand.versions[1].step.url, sha256: PIN });
		vi.stubGlobal('fetch', async () => response(OTHER));
		await expect(loadSource(file, null, hostWith(webTransport()), () => {})).rejects.toMatchObject({ reason: 'mismatch' });
		vi.stubGlobal('fetch', async () => response(STEP));
		expect(sha256Hex((await loadSource(file, null, hostWith(webTransport()), () => {})).bytes)).toBe(PIN);
		// A version the catalogue does not list opens other bytes than the link named, so it is named as missing.
		expect(named('#/stand@fffffff?m=a.f1')).toMatchObject({ version: { id: 'ccc4444' }, missing: 'fffffff' });
	});

	it("and a site's published conversion only as the files the catalogue names", async () => {
		const catalogue = fixtureCatalogue();
		const files = { glb: { sha256: PIN, size: STEP.length }, measure: { sha256: sha256Hex(OTHER), size: OTHER.length } };
		// A transport that checks nothing, and servers that send other bytes under these names.
		const lying: Transport = { blob: async () => ({ bytes: OTHER, url: null }), url: async () => OTHER };
		await expect(openPublished(hostWith(lying), catalogue, files, () => {}, new AbortController().signal)).rejects.toMatchObject({ reason: 'mismatch' });
	});

	it("and a companion's files as its published files or its zipped STEP file, each by the hash the catalogue names", async () => {
		const catalogue = fixtureCatalogue();
		const track = catalogue.models.clock.companions!;
		track.revisions[0].step.sha256 = PIN;
		const { companion } = resolveModel(catalogue, decode('#/clock', catalogue).source as CatalogueSource)!;
		expect(companion).toMatchObject({ kind: 'revision', revision: { id: 'eeeeeee' } });
		const lying: Transport = { blob: async () => ({ bytes: OTHER, url: null }), url: async () => OTHER };
		const listed = listedStep(catalogue, PIN)!;
		expect(listed.files).toBe(track.revisions[0].files);
		await expect(openPublished(hostWith(lying), catalogue, listed.files, () => {}, new AbortController().signal)).rejects.toMatchObject({ reason: 'mismatch' });
		await expect(loadSource(companionFile(catalogue, track.revisions[0]), null, hostWith(lying), () => {})).rejects.toMatchObject({ reason: 'mismatch' });
	});

	it('and an unpinned link is pinned to the bytes it fetched', async () => {
		vi.stubGlobal('fetch', async () => response(STEP));
		const loaded = await loadSource({ kind: 'url', url: 'https://files.example/part.step' }, null, hostWith(webTransport()), () => {});
		expect(loaded.sha256).toBe(PIN);
	});
});

describe('only the Nostr event asked for counts', () => {
	const key = generateSecretKey();
	const author = getPublicKey(key);
	const intruder = generateSecretKey();
	const file = [['url', 'https://files.example/part.step'], ['m', 'model/step'], ['x', PIN]];
	const sign = (kind: number, created_at: number, tags: string[][], secret = key) => finalizeEvent({ kind, created_at, tags, content: '' }, secret);

	it('by id: a shell that answers with another signed event, or a changed one, is not believed', async () => {
		const wanted = sign(1063, 100, file);
		const other = sign(1063, 100, [...file, ['alt', 'another file']]);
		const outbox = (answer: object) => ({ getEvent: async () => ({ result: { event: answer } }), query: async () => ({ events: [] }) });
		const pointer = nip19.neventEncode({ id: wanted.id, author });

		shell({ outbox: outbox(other) });
		expect(await nappletTransport().event!(pointer)).toBeNull();
		shell({ outbox: outbox({ ...wanted, tags: [['url', 'https://evil.example/part.step'], ['m', 'model/step']] }) });
		expect(await nappletTransport().event!(pointer)).toBeNull();
		shell({ outbox: outbox(wanted) });
		expect(idOf(await nappletTransport().event!(pointer))).toBe(wanted.id);
	});

	it('by address: the newest version by that author, not a newer one by someone else', async () => {
		const older = sign(30063, 100, [['d', 'part'], ...file]);
		const newer = sign(30063, 200, [['d', 'part'], ...file]);
		const foreign = sign(30063, 300, [['d', 'part'], ...file], intruder);
		const otherD = sign(30063, 400, [['d', 'another'], ...file]);
		shell({
			outbox: {
				getEvent: async () => ({}),
				query: async () => ({ events: [older, foreign, otherD, newer].map((event) => ({ event })) })
			}
		});
		const found = await nappletTransport().event!(nip19.naddrEncode({ kind: 30063, pubkey: author, identifier: 'part' }));
		expect(idOf(found)).toBe(newer.id);
	});

	it("a server list counts only when it is the author's", async () => {
		const list = sign(10063, 100, [['server', 'https://evil.example']], intruder);
		shell({ outbox: { getEvent: async () => ({}), query: async () => ({ events: [{ event: list }] }) } });
		expect(await nappletTransport().servers!(author)).toEqual([]);
	});
});

describe('a napplet reaches the network only through its shell', () => {
	it('fails without the shell capability rather than fetching by itself', async () => {
		const fetch = vi.fn();
		vi.stubGlobal('fetch', fetch);
		shell({});
		await expect(nappletTransport().url('https://files.example/part.step')).rejects.toMatchObject({ reason: 'unsupported' });
		await expect(nappletTransport().blob(PIN, ['https://a.example'])).rejects.toBeInstanceOf(TransportError);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('runs only the converter it was built with', async () => {
		const text = 'H4sIAAAAAAAAA-the-converter';
		const built = { sha256: sha256Hex(utf8(text)), source: 'https://dev.example/converter.txt' };
		const serving = (bytes: Uint8Array): Transport => ({ blob: async () => ({ bytes, url: null }), url: async () => bytes });
		await expect(converterFetcher(serving(utf8('H4sIAAAAAAAAA-something-else')), built, [])()).rejects.toMatchObject({ reason: 'mismatch' });
		expect(await converterFetcher(serving(utf8(text)), built, [])()).toBe(text);
	});
});

describe('an intent opens only https, Blossom and Nostr sources', () => {
	it.each(['javascript:alert(1)', 'http://files.example/part.step', 'file:///etc/passwd', 'data:model/step,ISO-10303-21;', 'ftp://files.example/part.step'])(
		'refuses %s',
		(url) => {
			expect(routeFromPayload({ url })).toBeNull();
		}
	);

	it('opens a catalogue model only on a site whose catalogue lists it', () => {
		const catalogue = fixtureCatalogue();
		expect(routeFromPayload({ model: 'stand', version: '1111111' }, [], catalogue)).toBe('#/stand@1111111');
		expect(routeFromPayload({ model: 'stand', version: '1111111' })).toBeNull();
		expect(routeFromPayload({ model: 'anvil' }, [], catalogue)).toBeNull();
		expect(routeFromPayload({ url: 'http://files.example/part.step' }, [], catalogue)).toBeNull();
	});

	it('opens https, blossom: and nostr: links', () => {
		expect(routeFromPayload({ url: 'https://files.example/part.step' })).toMatch(/^#\/u\?src=/);
		expect(routeFromPayload({ url: `blossom:sha256:${PIN}` })).toBe(`#/b/${PIN}`);
		const pointer = nip19.neventEncode({ id: 'a'.repeat(64) });
		expect(routeFromPayload({ url: `nostr:${pointer}` })).toBe(`#/n/${pointer}`);
	});
});

describe('measured items travel only with a route pinned to exact bytes', () => {
	it('drops them from a route that names no hash', () => {
		expect(decode('#/u?src=https%3A%2F%2Ffiles.example%2Fpart.step&m=a.f1').measure).toEqual([]);
		expect(decode(`#/u?src=https%3A%2F%2Ffiles.example%2Fpart.step&x=${PIN}&m=a.f1`).measure).toHaveLength(1);
	});
});

describe('the shared core stays free of the app around it', () => {
	// The viewer, the measurements, the conversion pipeline and three panels are shared with other viewers, which bring
	// their own sources, hosts, recent files and conversion. Followed through every import, $lib and relative alike.
	const lib = fileURLToPath(new URL('.', import.meta.url));
	const core = ['viewer', 'measure', 'pipeline', 'ui/PartTree.svelte', 'ui/SectionPanel.svelte', 'ui/MeasurePanel.svelte'];
	const app = ['source', 'host', 'recent', 'convert'];
	const SPECIFIER = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]/g;

	const filesUnder = (path: string): string[] =>
		statSync(path).isDirectory() ? readdirSync(path).flatMap((name) => filesUnder(join(path, name))) : [path];
	const resolve = (from: string, specifier: string) => {
		const base = specifier.startsWith('$lib/') ? join(lib, specifier.slice(5)) : specifier.startsWith('.') ? join(dirname(from), specifier) : null;
		if (!base) return null;
		const found = ['', '.ts', '.svelte.ts', '.js', '/index.ts'].map((ending) => base + ending).find((path) => existsSync(path) && statSync(path).isFile());
		if (!found) throw new Error(`${relative(lib, from)}: cannot resolve ${specifier}`);
		return found;
	};

	it('reaches nothing of the sources, hosts, recent files or conversion', () => {
		const reached = new Set(core.flatMap((path) => filesUnder(join(lib, path))));
		const outside: string[] = [];
		// A Set visits what is added while it is walked, so this follows imports to the end.
		for (const file of reached) {
			for (const match of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
				const target = resolve(file, match[1] ?? match[2] ?? match[3]);
				if (!target || reached.has(target)) continue;
				reached.add(target);
				const area = relative(lib, target).split('/')[0];
				if (app.includes(area)) outside.push(`${relative(lib, file)} imports ${relative(lib, target)}`);
			}
		}
		expect(outside).toEqual([]);
		// The walk got past the core: the route types come in through $lib.
		expect(reached.has(join(lib, 'state/hash.ts'))).toBe(true);
	});
});
