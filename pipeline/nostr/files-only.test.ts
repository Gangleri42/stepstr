// A files-only publish of a site's catalogue files, against the stubbed servers the spread tests use, with the files
// on disk as the site's builder leaves them, and the record of verified copies it leaves for the next publish.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Event, EventTemplate } from 'nostr-tools/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadFiles } from './files-only.ts';
import { file, NOW, world } from './stub-servers.ts';
import { readRecord, verifiedBefore } from './verified.ts';

const OWN = 'https://own.example.com';
const A = 'https://a.example.com';
const B = 'https://b.example.com';

const dirs: string[] = [];
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

/** A catalogue's files, written to a directory under their sha256 as catalogue-files.ts reads them. */
function catalogueFiles() {
	const dir = mkdtempSync(join(tmpdir(), 'files-only-'));
	dirs.push(dir);
	const entries = [file('lamp/aaaaaaa/model.glb', 'model/gltf-binary', 'glTF and more'), file('lamp/aaaaaaa/measure.json.gz', 'application/gzip', 'measured')];
	for (const entry of entries) {
		entry.file = join(dir, entry.sha256);
		writeFileSync(entry.file, entry.data);
	}
	return entries;
}

/** Where the site keeps its record of verified copies, in the files' directory (sitePaths puts it under the site's .cache). */
const recordIn = (entries: { file?: string }[]) => join(entries[0].file!, '..', '.cache/verified-copies.json');

/** The most requests each server had open at once. */
function counting() {
	const inner = globalThis.fetch;
	const open = new Map<string, number>();
	const most = new Map<string, number>();
	vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
		const { origin } = new URL(input);
		open.set(origin, (open.get(origin) ?? 0) + 1);
		most.set(origin, Math.max(most.get(origin) ?? 0, open.get(origin)!));
		try {
			await new Promise((resolve) => setTimeout(resolve, 1));
			return await inner(input, init);
		} finally {
			open.set(origin, open.get(origin)! - 1);
		}
	});
	return most;
}

/** A signer that records what it signed. A batch's authorisation comes back five minutes old, as it is by the time a
 * later file of a long run uses it; one for a single file comes back as signed. */
function signer() {
	const signed: EventTemplate[] = [];
	const sign = async (template: EventTemplate) => {
		signed.push(template);
		const batch = template.tags.filter((tag) => tag[0] === 'x').length > 1;
		return { ...template, created_at: batch ? template.created_at - 300 : template.created_at, id: 'i', pubkey: 'p', sig: 's' } as Event;
	};
	return { signed, sign };
}

describe('a files-only publish', () => {
	it('in a dry run says which files each server lacks, and signs and writes nothing', async () => {
		const [glb, measure] = catalogueFiles();
		const servers = world({ [OWN]: { blobs: new Map([[glb.sha256, glb.data]]) }, [A]: {} });
		const lines: string[] = [];
		expect(await uploadFiles({ dryRun: true, servers: [OWN, A], entries: [glb, measure], minPublic: 1, log: (line) => lines.push(line) })).toBeNull();
		expect(lines).toContain(`  ${OWN}: 1/2 files already there; would place /lamp/aaaaaaa/measure.json.gz`);
		expect(lines).toContain(`  ${A}: 0/2 files already there; would place /lamp/aaaaaaa/model.glb, /lamp/aaaaaaa/measure.json.gz`);
		for (const server of [OWN, A]) expect(servers[server].calls.every((call) => /^HEAD \/[0-9a-f]{64}$/.test(call))).toBe(true);
		expect(servers[OWN].blobs.size).toBe(1);
		expect(servers[A].blobs.size).toBe(0);
		expect(existsSync(recordIn([glb]))).toBe(false);
	});

	it('in a dry run asks the servers at once, and each about one file after another', async () => {
		const entries = Array.from({ length: 6 }, (_, i) => file(`lamp/${i}/model.glb`, 'model/gltf-binary', `model ${i}`));
		const servers = world({ [OWN]: {}, [A]: {}, [B]: {} });
		const most = counting();
		await uploadFiles({ dryRun: true, servers: [OWN, A, B], entries, minPublic: 1, log: () => {} });
		for (const server of [OWN, A, B]) expect(servers[server].calls).toHaveLength(6);
		expect(most).toEqual(new Map([OWN, A, B].map((server) => [server, 1])));
	});

	it("spreads them as a publish does: the site's own server first, mirrors, uploads and fresh authorisations, each copy verified", async () => {
		vi.useFakeTimers({ now: NOW * 1000, toFake: ['Date'] });
		const entries = catalogueFiles();
		const servers = world({ [OWN]: {}, [A]: { strict: true }, [B]: { noMirror: true } });
		const { signed, sign } = signer();
		const record = recordIn(entries);
		const out = await uploadFiles({ servers: [OWN, A, B], entries, minPublic: 2, verifiedBefore: new Set<string>(), record, sign, content: 'Publish Lamps', log: () => {} });
		for (const entry of entries) expect(out.holders.get(entry.sha256)).toEqual([OWN, A, B]);
		expect(servers[OWN].calls).toContain('PUT /upload');
		expect(servers[A].calls).toContain('PUT /mirror');
		expect(servers[B].calls).toEqual(expect.arrayContaining(['PUT /mirror', 'PUT /upload']));
		for (const server of [OWN, A, B]) expect(servers[server].calls.filter((c) => c.startsWith('GET /'))).toHaveLength(2);
		// One authorisation for the batch, then one for each transfer to the server that refused it.
		expect(signed[0].tags).toEqual([['t', 'upload'], ['expiration', String(NOW + 600)], ...entries.map((e) => ['x', e.sha256])]);
		expect(signed.slice(1).every((t) => t.tags.filter((tag) => tag[0] === 'x').length === 1 && t.content === 'Publish Lamps')).toBe(true);
		// Every copy it verified is in the site's record.
		expect(readRecord(record).sort()).toEqual([OWN, A, B].flatMap((server) => entries.map((e) => `${server} ${e.sha256}`)).sort());
	});

	it('leaves a record from which the next run, files-only or full, downloads nothing again', async () => {
		const entries = catalogueFiles();
		const servers = world({ [OWN]: {}, [A]: {} });
		const record = recordIn(entries);
		const run = () => uploadFiles({ servers: [OWN, A], entries, minPublic: 1, verifiedBefore: verifiedBefore({ manifests: [], record: readRecord(record) }), record, ...signer(), content: 'Publish Lamps', log: () => {} });
		await run();
		for (const server of [OWN, A]) servers[server].calls.length = 0;
		const again = await run();
		for (const entry of entries) expect(again.holders.get(entry.sha256)).toEqual([OWN, A]);
		for (const server of [OWN, A]) expect(servers[server].calls.filter((c) => c.startsWith('GET /'))).toEqual([]);
		expect(readRecord(record)).toHaveLength(4);
	});

	it('drops from the record a copy that fails its check, and keeps the copies of other runs', async () => {
		const entries = catalogueFiles();
		const [glb] = entries;
		const other = `${B} ${'f'.repeat(64)}`;
		const record = recordIn(entries);
		// A has the model at its size and with other bytes; an earlier run recorded its copy, and another file on B.
		world({ [OWN]: {}, [A]: { blobs: new Map([[glb.sha256, new Uint8Array(glb.bytes)]]) } });
		mkdirSync(join(record, '..'), { recursive: true });
		writeFileSync(record, JSON.stringify({ version: 1, copies: [[A, glb.sha256], [B, 'f'.repeat(64)]] }));
		const before = verifiedBefore({ manifests: [], record: readRecord(record) });
		expect(before).toEqual(new Set([`${A} ${glb.sha256}`, other]));
		// Asked without the record, the run downloads A's copy, which fails its check.
		const out = await uploadFiles({ servers: [OWN, A], entries, minPublic: 0, verifiedBefore: new Set<string>(), record, ...signer(), content: 'Publish Lamps', log: () => {} });
		expect(out.holders.get(glb.sha256)).toEqual([OWN]);
		expect(readRecord(record)).not.toContain(`${A} ${glb.sha256}`);
		expect(readRecord(record)).toContain(other);
		expect(readRecord(record)).toContain(`${OWN} ${glb.sha256}`);
	});
});
