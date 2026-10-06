import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { Host, Transport } from '$lib/host/host';
import { TransportError } from '$lib/host/host';
import { explainLoadError, loadSource } from './load';
import { addLocalFile } from './local';
import type { NostrEventLike } from './nostr-files';
import { sha256Hex } from './sha256';

const utf8 = (text: string) => new TextEncoder().encode(text);
const STEP = utf8('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n');
const SHA = sha256Hex(STEP);

type Files = { urls?: Record<string, Uint8Array>; blobs?: Record<string, string[]>; events?: Record<string, NostrEventLike>; limit?: number; refusing?: string[] };

/** A host whose transport serves fixed URLs and blobs, and records what was asked. */
function fakeHost(files: Files) {
	const asked: string[] = [];
	const transport: Transport = {
		async blob(sha256, servers, _progress, signal) {
			signal?.throwIfAborted();
			asked.push(`blob ${sha256.slice(0, 8)} ${servers.join(' ')}`);
			const holder = servers.find((s) => (files.blobs?.[sha256] ?? []).includes(s));
			const refusing = servers.find((s) => files.refusing?.includes(s));
			if (!holder && refusing) throw new TransportError('unreachable', `${refusing} does not let other sites read this file`);
			if (!holder) throw new TransportError('not-found', 'no server has it');
			return { bytes: STEP, url: `${holder}/${sha256}` };
		},
		async url(url, _progress, signal) {
			signal?.throwIfAborted();
			asked.push(`url ${url}`);
			const bytes = files.urls?.[url];
			if (!bytes) throw new TransportError('not-found', '404');
			return bytes;
		},
		async event(pointer) {
			asked.push(`event ${pointer.slice(0, 8)}`);
			return files.events?.[pointer] ?? null;
		},
		async servers() {
			asked.push('servers');
			return ['https://listed.example'];
		},
		...(files.limit ? { limit: async () => files.limit } : {})
	};
	const host = { transport, servers: ['https://default.example'] } as Host;
	return { host, asked };
}

describe('loading a source', () => {
	it('opens a file from this device without any network', async () => {
		// Bytes of its own: files from the device are found by hash, before any server.
		const sha256 = addLocalFile('bracket.step', utf8('ISO-10303-21;\n/* from this device */\nEND-ISO-10303-21;\n'));
		const { host, asked } = fakeHost({});
		const loaded = await loadSource({ kind: 'blob', sha256, servers: [] }, null, host, () => {});
		expect(loaded).toMatchObject({ name: 'bracket.step', sha256, download: null });
		expect(asked).toEqual([]);
	});

	it('asks the link\'s servers, then the author\'s, then the defaults', async () => {
		const { host, asked } = fakeHost({ blobs: { [SHA]: ['https://listed.example'] } });
		const loaded = await loadSource({ kind: 'blob', sha256: SHA, servers: ['https://a.example'], author: 'p'.repeat(64) }, 'x.step', host, () => {});
		expect(asked).toEqual([`blob ${SHA.slice(0, 8)} https://a.example`, 'servers', `blob ${SHA.slice(0, 8)} https://listed.example https://default.example`]);
		// The download points where the file was found.
		expect(loaded.download).toBe(`https://listed.example/${SHA}`);
	});

	it('reports why the link\'s own server failed rather than the others\' "not found"', async () => {
		const { host } = fakeHost({ refusing: ['https://a.example'] });
		await expect(loadSource({ kind: 'blob', sha256: SHA, servers: ['https://a.example'], author: 'p'.repeat(64) }, 'x.step', host, () => {})).rejects.toMatchObject({
			reason: 'unreachable',
			message: expect.stringContaining('a.example')
		});
	});

	it('does not look up the author\'s servers when the link\'s own have the file', async () => {
		const { host, asked } = fakeHost({ blobs: { [SHA]: ['https://a.example'] } });
		await loadSource({ kind: 'blob', sha256: SHA, servers: ['https://a.example'], author: 'p'.repeat(64) }, 'x.step', host, () => {});
		expect(asked).toEqual([`blob ${SHA.slice(0, 8)} https://a.example`]);
	});

	it('refuses up front a file larger than the host fetches, and says its size', async () => {
		const { host, asked } = fakeHost({ blobs: { [SHA]: ['https://a.example'] }, limit: 10 * 1024 * 1024 });
		const loading = loadSource({ kind: 'blob', sha256: SHA, servers: ['https://a.example'], size: 20e6 }, 'x.step', host, () => {});
		await expect(loading).rejects.toMatchObject({ reason: 'too-large', size: 20e6 });
		expect(asked).toEqual([]);
		expect(explainLoadError(await loading.catch((err) => err)).message).toMatch(/20\.0 MB/);
	});

	it('stops when cancelled', async () => {
		const { host, asked } = fakeHost({ blobs: { [SHA]: ['https://listed.example'] } });
		const controller = new AbortController();
		controller.abort();
		await expect(loadSource({ kind: 'blob', sha256: SHA, servers: ['https://a.example'], author: 'p'.repeat(64) }, null, host, () => {}, controller.signal)).rejects.toMatchObject({
			name: 'AbortError'
		});
		expect(asked).toEqual([]);
	});

	it('unzips and names a file from a URL', async () => {
		const zip = zipSync({ 'cad/Bracket.stp': STEP });
		const { host } = fakeHost({ urls: { 'https://files.example/parts.zip': zip } });
		const loaded = await loadSource({ kind: 'url', url: 'https://files.example/parts.zip' }, null, host, () => {});
		expect(loaded).toMatchObject({ name: 'Bracket.stp', sha256: sha256Hex(zip), size: zip.length });
		expect(loaded.bytes).toEqual(STEP);
	});

	it('follows a Git LFS pointer to GitHub\'s media host', async () => {
		const pointer = utf8(`version https://git-lfs.github.com/spec/v1\noid sha256:${SHA}\nsize ${STEP.length}\n`);
		const raw = 'https://raw.githubusercontent.com/o/r/main/a.step';
		const { host, asked } = fakeHost({ urls: { [raw]: pointer, 'https://media.githubusercontent.com/media/o/r/main/a.step': STEP } });
		const loaded = await loadSource({ kind: 'url', url: raw }, null, host, () => {});
		expect(loaded.sha256).toBe(SHA);
		expect(asked).toEqual([`url ${raw}`, 'url https://media.githubusercontent.com/media/o/r/main/a.step']);
	});

	it('names a file whose URL has a broken escape as it is', async () => {
		const { host } = fakeHost({ urls: { 'https://files.example/a%ZZ.step': STEP } });
		expect((await loadSource({ kind: 'url', url: 'https://files.example/a%ZZ.step' }, null, host, () => {})).name).toBe('a%ZZ.step');
	});

	it('refuses bytes that do not match the pinned hash', async () => {
		const { host } = fakeHost({ urls: { 'https://files.example/a.step': STEP } });
		await expect(loadSource({ kind: 'url', url: 'https://files.example/a.step', sha256: 'f'.repeat(64) }, null, host, () => {})).rejects.toMatchObject({ reason: 'mismatch' });
	});

	it('opens the STEP file a Nostr event points at, by hash first and by URL after', async () => {
		const event = { kind: 1063, pubkey: 'p'.repeat(64), content: '', tags: [['url', 'https://files.example/part.step'], ['m', 'model/step'], ['x', SHA]] };
		const { host, asked } = fakeHost({ urls: { 'https://files.example/part.step': STEP }, events: { nevent1test: event } });
		const loaded = await loadSource({ kind: 'nostr', pointer: 'nevent1test' }, null, host, () => {});
		expect(loaded).toMatchObject({ name: 'part.step', sha256: SHA, download: 'https://files.example/part.step' });
		expect(asked).toEqual(['event nevent1t', 'servers', `blob ${SHA.slice(0, 8)} https://listed.example https://default.example`, 'url https://files.example/part.step']);
	});

	it('keeps a pinned link to the file it names when the event points elsewhere now', async () => {
		const other = 'e'.repeat(64);
		const event = { kind: 1063, pubkey: 'p'.repeat(64), content: '', tags: [['url', 'https://files.example/part.step'], ['m', 'model/step'], ['x', other]] };
		const { host, asked } = fakeHost({ urls: { 'https://files.example/part.step': STEP }, events: { naddr1test: event } });
		await expect(loadSource({ kind: 'nostr', pointer: 'naddr1test', sha256: SHA }, null, host, () => {})).rejects.toMatchObject({ reason: 'mismatch' });
		expect(asked).toEqual(['event naddr1te']);
	});

	it('opens a pinned file the event names only by URL, by the pinned hash', async () => {
		const event = { kind: 1, pubkey: 'p'.repeat(64), content: 'the part', tags: [['imeta', 'url https://files.example/part.step', 'm model/step']] };
		const { host, asked } = fakeHost({ urls: { 'https://files.example/part.step': STEP }, blobs: { [SHA]: ['https://default.example'] }, events: { nevent1test: event } });
		const loaded = await loadSource({ kind: 'nostr', pointer: 'nevent1test', sha256: SHA }, null, host, () => {});
		expect(loaded).toMatchObject({ sha256: SHA, name: 'part.step', download: `https://default.example/${SHA}` });
		expect(asked).toEqual(['event nevent1t', 'servers', `blob ${SHA.slice(0, 8)} https://listed.example https://default.example`]);

		// Through its URL, the bytes must still be the pinned ones.
		const moved = fakeHost({ urls: { 'https://files.example/part.step': utf8('ISO-10303-21;\n/* edited */\nEND-ISO-10303-21;\n') }, events: { nevent1test: event } });
		await expect(loadSource({ kind: 'nostr', pointer: 'nevent1test', sha256: SHA }, null, moved.host, () => {})).rejects.toMatchObject({ reason: 'mismatch' });
	});

	it('says when an event carries no STEP file', async () => {
		const event = { kind: 1, pubkey: 'p'.repeat(64), content: 'hello', tags: [] };
		const { host } = fakeHost({ events: { nevent1test: event } });
		await expect(loadSource({ kind: 'nostr', pointer: 'nevent1test' }, null, host, () => {})).rejects.toThrow(/does not point at a STEP file/);
	});
});

describe('load errors', () => {
	it('suggests a way out when a shell refuses the file', () => {
		expect(explainLoadError(new TransportError('too-large', 'too-large', 20e6))).toEqual({ message: expect.stringMatching(/20\.0 MB/), hint: 'local' });
		expect(explainLoadError(new TransportError('unsupported-type', 'decode-failed')).hint).toBe('local');
		expect(explainLoadError(new TransportError('not-found', 'no server has it.')).message).toBe('No server has it.');
		expect(explainLoadError(new Error('boom')).message).toBe('Boom.');
		expect(explainLoadError(new TransportError('not-found', 'raw.githubusercontent.com does not have this file')).message).toBe(
			'raw.githubusercontent.com does not have this file.'
		);
	});
});
