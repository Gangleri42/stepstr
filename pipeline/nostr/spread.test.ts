// Spreading files over Blossom servers, against servers stubbed at fetch (stub-servers.ts), and the authorisations a
// publish signs for it.
import type { Event, EventTemplate } from 'nostr-tools/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileEntry } from './manifest.ts';
import { batchedAuth, holdingAll, siteServers, spread, SpreadError, type SpreadOptions } from './spread.ts';
import { file, NOW, world } from './stub-servers.ts';

const page = file('index.html', 'text/html', '<!doctype html>');
const model = file('lamp.glb', 'model/gltf-binary', 'glTF and more');
const measure = file('lamp.measure.json.gz', 'application/gzip', 'measured');

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

	it('does the same for a server that takes each authorisation once and says so with a 400', async () => {
		const servers = world({ [OWN]: {}, [A]: { once: true }, [B]: {} });
		let id = 0;
		const auth = batchedAuth([page, model], async (template) => ({ ...template, id: String(++id), pubkey: 'p', sig: 's' }) as Event, 'Publish', () => NOW);
		const lines: string[] = [];
		const out = await spread({ ...options([OWN, A, B], [page, model]), auth, log: (line) => lines.push(line) });
		expect(out.holders.get(page.sha256)).toEqual([OWN, A, B]);
		expect(out.holders.get(model.sha256)).toEqual([OWN, A, B]);
		expect(out.refused).toEqual(new Map());
		expect(servers[A].blobs.size).toBe(2);
		expect(lines).toContain(`  ${A} refused the batch's authorisation; it gets one signed just before each transfer`);
	});

	it('takes a type from a server that holds its probe, without asking it', async () => {
		const small = file('lamp-small.glb', 'model/gltf-binary', 'glTF');
		const servers = world({ [OWN]: {}, [A]: { refusesHeld: true, blobs: new Map([[model.sha256, model.data]]) } });
		const out = await spread(options([OWN, A], [model, small]));
		expect(out.refused).toEqual(new Map());
		expect(out.holders.get(small.sha256)).toEqual([OWN, A]);
		expect(servers[A].calls).not.toContain('HEAD /upload');
	});

	it('keeps a 400 about the file as the refusal once a fresh authorisation gets one too', async () => {
		const { auth, signed } = authorisations();
		vi.stubGlobal('fetch', async () => new Response(null, { status: 400, headers: { 'x-reason': 'unsupported content type: model/gltf-binary' } }));
		const lines: string[] = [];
		await expect(spread({ ...options([OWN, A], [model]), auth, log: (line) => lines.push(line) })).rejects.toThrow(/refuses model\/gltf-binary;/);
		expect(signed.fresh).toEqual([model.sha256, model.sha256]);
		expect(lines).toContain(`  skip ${A}: refuses model/gltf-binary (400 unsupported content type: model/gltf-binary)`);
		expect(lines.some((line) => line.includes('signed just before'))).toBe(false);
	});

	it('downloads a copy an earlier publish verified only when the server reports another size', async () => {
		const servers = world({ [OWN]: { blobs: new Map([[page.sha256, page.data]]) }, [A]: { blobs: new Map([[page.sha256, new Uint8Array(3)]]) } });
		await expect(spread(options([OWN, A], [page], { verifiedBefore: new Set([`${OWN} ${page.sha256}`, `${A} ${page.sha256}`]) }))).rejects.toThrow(
			'1 files reach fewer than 1 public servers: /index.html (0)'
		);
		expect(servers[OWN].calls).toEqual([`HEAD /${page.sha256}`, `HEAD /${page.sha256}`]);
		expect(servers[A].calls).toContain(`GET /${page.sha256}`);
	});

	it('verifies each copy by its bare hash, which a server that knows no extension for it still serves', async () => {
		const servers = world({ [OWN]: {}, [A]: { bareOnly: true } });
		const out = await spread(options([OWN, A], [page, model]));
		expect(out.holders.get(page.sha256)).toEqual([OWN, A]);
		expect(out.holders.get(model.sha256)).toEqual([OWN, A]);
		expect(servers[A].calls).toEqual(expect.arrayContaining([`GET /${page.sha256}`, `GET /${model.sha256}`]));
	});

	it("lists in the site manifest only servers whose catalogue copies passed their check, besides those refusing a type", async () => {
		// A holds a copy of the model of the right size and the wrong bytes; B refuses models.
		const servers = world({ [OWN]: {}, [A]: { blobs: new Map([[model.sha256, new Uint8Array(model.bytes)]]) }, [B]: { refuses: ['model/gltf-binary'] } });
		const out = await spread(options([OWN, A, B], [page, model, measure], { minPublic: 0 }));
		expect(servers[A].calls).toContain(`GET /${model.sha256}`);
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

describe('the authorisations a publish signs', () => {
	const entries = Array.from({ length: 45 }, (_, i) => file(`part${i}.glb`, 'model/gltf-binary', `part ${i}`));
	const signing = () => {
		const signed: EventTemplate[] = [];
		const sign = async (template: EventTemplate) => (signed.push(template), { ...template, id: 'i', pubkey: 'p', sig: 's' } as Event);
		return { signed, sign };
	};

	it('cover a batch of 20 files once, until a minute before they expire', async () => {
		let now = NOW;
		const { signed, sign } = signing();
		const auth = batchedAuth(entries, sign, 'Publish Lamps', () => now);
		await Promise.all(entries.map((entry) => auth.batched(entry)));
		expect(signed.map((t) => t.tags.filter((tag) => tag[0] === 'x').length)).toEqual([20, 20, 5]);
		expect(signed[0]).toEqual({ kind: 24242, created_at: NOW, content: 'Publish Lamps', tags: [['t', 'upload'], ['expiration', String(NOW + 600)], ...entries.slice(0, 20).map((e) => ['x', e.sha256])] });
		now += 539;
		await auth.batched(entries[0]);
		expect(signed).toHaveLength(3);
		now += 1;
		expect((await auth.batched(entries[19])).created_at).toBe(NOW + 540);
		expect(signed).toHaveLength(4);
	});

	it('and one for a single file, signed when it is asked for, for five minutes', async () => {
		const { signed, sign } = signing();
		const auth = batchedAuth(entries, sign, 'Publish Lamps', () => NOW);
		await auth.fresh(entries[30]);
		expect(signed).toEqual([{ kind: 24242, created_at: NOW, content: 'Publish Lamps', tags: [['t', 'upload'], ['expiration', String(NOW + 300)], ['x', entries[30].sha256]] }]);
	});
});
