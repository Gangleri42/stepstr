// Spreading files over Blossom servers, against servers stubbed at fetch: each holds blobs by sha256 and can refuse a
// type, refuse an authorisation signed a while ago, or lack the mirror endpoint.
import { createHash } from 'node:crypto';
import type { Event } from 'nostr-tools/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from './manifest.ts';
import { holdingAll, siteServers, spread, SpreadError, type SpreadOptions } from './spread.ts';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const NOW = 1_800_000_000;

type Server = {
	blobs: Map<string, Uint8Array>;
	/** Types it refuses at preflight. */
	refuses?: string[];
	/** It refuses an authorisation signed more than two minutes before the request. */
	strict?: boolean;
	/** It has no mirror endpoint. */
	noMirror?: boolean;
	/** What was asked of it: "<method> <path>". */
	calls: string[];
};

function file(name: string, type: string, text: string): FileEntry & { data: Uint8Array } {
	const data = new TextEncoder().encode(text);
	return { path: `/${name}`, sha256: sha256(data), bytes: data.length, type, file: name, data };
}
const page = file('index.html', 'text/html', '<!doctype html>');
const model = file('lamp.glb', 'model/gltf-binary', 'glTF and more');
const measure = file('lamp.measure.json.gz', 'application/gzip', 'measured');

/** Servers stubbed at fetch, by origin. */
function world(spec: Record<string, Partial<Server>>) {
	const servers = Object.fromEntries(Object.entries(spec).map(([origin, s]) => [origin, { blobs: new Map(), calls: [], ...s } as Server]));
	vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
		const url = new URL(input);
		const server = servers[url.origin];
		const method = init.method ?? 'GET';
		if (!server) throw new TypeError('fetch failed');
		server.calls.push(`${method} ${url.pathname}`);
		const headers = new Headers(init.headers);
		const authorisation = headers.get('authorization');
		const event = authorisation ? (JSON.parse(Buffer.from(authorisation.slice(6), 'base64url').toString()) as Event) : null;
		const refuse = (status: number, reason: string) => new Response(null, { status, headers: { 'x-reason': reason } });
		if (event && server.strict && NOW - event.created_at > 120) return refuse(401, 'authorisation too old');
		const hash = /^\/([0-9a-f]{64})/.exec(url.pathname)?.[1];
		if (hash) {
			const blob = server.blobs.get(hash);
			if (!blob) return new Response(null, { status: 404 });
			return new Response(method === 'HEAD' ? null : (blob.slice().buffer as ArrayBuffer), { headers: { 'content-length': String(blob.length) } });
		}
		if (url.pathname === '/upload' && method === 'HEAD') {
			return server.refuses?.includes(headers.get('x-content-type') ?? '') ? refuse(415, 'type not allowed') : new Response(null, { status: 200 });
		}
		if (url.pathname === '/upload' && method === 'PUT') {
			const body = new Uint8Array(init.body as Uint8Array);
			server.blobs.set(sha256(body), body);
			return new Response('{}', { status: 201 });
		}
		if (url.pathname === '/mirror' && method === 'PUT') {
			if (server.noMirror) return new Response(null, { status: 404 });
			const from = new URL(JSON.parse(init.body as string).url);
			const blob = servers[from.origin]?.blobs.get(from.pathname.slice(1).split('.')[0]);
			if (!blob) return refuse(502, 'could not fetch it');
			server.blobs.set(sha256(blob), blob);
			return new Response('{}', { status: 201 });
		}
		return new Response(null, { status: 404 });
	});
	return servers;
}

/** Authorisations as the publisher signs them: the batched ones a few minutes old by the time they are used. */
function authorisations() {
	const signed = { batched: 0, fresh: [] as string[] };
	const event = (created_at: number, hash: string) => ({ kind: 24242, created_at, content: 'Publish', tags: [['t', 'upload'], ['x', hash]], id: 'i', pubkey: 'p', sig: 's' }) as Event;
	return {
		signed,
		auth: {
			batched: async (entry: FileEntry) => (signed.batched++, event(NOW - 300, entry.sha256)),
			fresh: async (entry: FileEntry) => (signed.fresh.push(entry.sha256), event(NOW, entry.sha256))
		}
	};
}

function options(servers: string[], entries: ReturnType<typeof file>[], extra: Partial<SpreadOptions> = {}): SpreadOptions {
	const { auth } = authorisations();
	const data = new Map(entries.map((e) => [e.sha256, e.data]));
	return { servers, entries, verifiedBefore: new Set(), minPublic: 1, bytesOf: async (e) => data.get(e.sha256) ?? null, auth, ...extra };
}

const OWN = 'https://own.example.com';
const A = 'https://a.example.com';
const B = 'https://b.example.com';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('spreading files over Blossom servers', () => {
	it("mirrors from the site's own server, and uploads where a server does not mirror", async () => {
		const servers = world({ [OWN]: {}, [A]: {}, [B]: { noMirror: true } });
		const out = await spread(options([OWN, A, B], [page, model]));
		expect(out.holders.get(model.sha256)).toEqual([OWN, A, B]);
		expect(servers[OWN].calls).toContain('PUT /upload');
		expect(servers[A].calls).toContain('PUT /mirror');
		expect(servers[A].calls).not.toContain('PUT /upload');
		expect(servers[B].calls).toEqual(expect.arrayContaining(['PUT /mirror', 'PUT /upload']));
		// Each copy placed in this run is downloaded once and hashed.
		for (const server of [OWN, A, B]) expect(servers[server].calls.filter((c) => c.startsWith('GET /'))).toHaveLength(2);
	});

	it('leaves out a type a server refuses, and says so, while the server takes the rest', async () => {
		const servers = world({ [OWN]: {}, [A]: { refuses: ['model/gltf-binary'] }, [B]: {} });
		const lines: string[] = [];
		const out = await spread(options([OWN, A, B], [page, model, measure], { log: (line) => lines.push(line) }));
		expect(out.holders.get(model.sha256)).toEqual([OWN, B]);
		expect(out.holders.get(measure.sha256)).toEqual([OWN, A, B]);
		expect(out.refused).toEqual(new Map([[A, ['model/gltf-binary']]]));
		expect(servers[A].blobs.has(model.sha256)).toBe(false);
		expect(lines).toContainEqual(expect.stringMatching(/some https:\/\/a\.example\.com: refuses model\/gltf-binary \(415 type not allowed\)/));
		expect(holdingAll(out, [OWN, A, B], [page, measure])).toEqual([OWN, A, B]);
		expect(holdingAll(out, [OWN, A, B], [page, model])).toEqual([OWN, B]);
	});

	it('signs a fresh authorisation for a server that refuses one signed earlier, and from then on for it alone', async () => {
		const servers = world({ [OWN]: {}, [A]: { strict: true }, [B]: {} });
		const { auth, signed } = authorisations();
		const out = await spread({ ...options([OWN, A, B], [page, model]), auth });
		expect(out.holders.get(page.sha256)).toEqual([OWN, A, B]);
		expect(out.holders.get(model.sha256)).toEqual([OWN, A, B]);
		expect(servers[A].blobs.size).toBe(2);
		// Two preflights and two mirrors on the strict server, each with an authorisation signed for it; the first
		// preflight was tried with the batch's first, in both encodings of the header.
		expect(signed.fresh).toEqual([page.sha256, model.sha256, page.sha256, model.sha256]);
		expect(servers[A].calls.filter((c) => c === 'HEAD /upload')).toHaveLength(4);
		expect(servers[B].calls.filter((c) => c === 'HEAD /upload')).toHaveLength(2);
	});

	it('downloads a copy an earlier publish verified only when the server reports another size', async () => {
		const servers = world({ [OWN]: { blobs: new Map([[page.sha256, page.data]]) }, [A]: { blobs: new Map([[page.sha256, new Uint8Array(3)]]) } });
		await expect(spread(options([OWN, A], [page], { verifiedBefore: new Set([`${OWN} ${page.sha256}`, `${A} ${page.sha256}`]) }))).rejects.toThrow(
			'1 files reach fewer than 1 public servers: /index.html (0)'
		);
		expect(servers[OWN].calls).toEqual(['HEAD /upload', `HEAD /${page.sha256}`]);
		expect(servers[A].calls).toContain(`GET /${page.sha256}.html`);
	});

	it("lists in the site manifest only servers whose catalogue copies passed their check, besides those refusing a type", async () => {
		// A holds a copy of the model of the right size and the wrong bytes; B refuses models.
		const servers = world({ [OWN]: {}, [A]: { blobs: new Map([[model.sha256, new Uint8Array(model.bytes)]]) }, [B]: { refuses: ['model/gltf-binary'] } });
		const out = await spread(options([OWN, A, B], [page, model, measure], { minPublic: 0 }));
		expect(servers[A].calls).toContain(`GET /${model.sha256}.glb`);
		expect(out.holders.get(model.sha256)).toEqual([OWN]);
		expect(holdingAll(out, [OWN, A, B], [page])).toEqual([OWN, A, B]);
		expect(siteServers(out, [OWN, A, B], [page], [model, measure])).toEqual([OWN, B]);
		expect(siteServers(out, [OWN, A, B], [page, measure], [])).toEqual([OWN, A, B]);
	});

	it('fails when a file would reach fewer public servers than asked for, or the own server refuses a type', async () => {
		world({ [OWN]: {}, [A]: { refuses: ['model/gltf-binary'] }, [B]: { refuses: ['model/gltf-binary', 'text/html'] } });
		await expect(spread(options([OWN, A, B], [page, model]))).rejects.toThrow(new SpreadError('only 0 public servers take model/gltf-binary, 1 needed (--min-public to change)'));
		await expect(spread(options([OWN, A, B], [page], { minPublic: 2 }))).rejects.toThrow('only 1 public servers take text/html, 2 needed');
		expect((await spread(options([OWN, A, B], [page]))).holders.get(page.sha256)).toEqual([OWN, A]);
		world({ [OWN]: { refuses: ['text/html'] }, [A]: {} });
		await expect(spread(options([OWN, A], [page]))).rejects.toThrow("https://own.example.com, the site's own server, refuses text/html");
	});
});
