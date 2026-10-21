// Opening a STEP file from the conversion its site published, built here as a site's builder does (pipeline/convert.ts)
// from the Seed test file.
import { IDBFactory } from 'fake-indexeddb';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { convert, publishable, WASM, type Published } from '../../../pipeline/convert';
import { fixtureBytes, fixtureFile, FIXTURES } from '../../../test/fixtures';
import { CONVERTER, lacking } from '../../../test/prerequisites';
import type { Catalogue } from '$lib/catalogue/catalogue';
import { fixtureCatalogue } from '$lib/catalogue/fixture';
import type { Converter } from '$lib/convert/types';
import type { Host, Transport } from '$lib/host/host';
import { TransportError } from '$lib/host/host';
import { MEASURE_VERSION } from '$lib/measure/format';
import { indexedDbRecent } from '$lib/recent/indexeddb';
import type { RecentStore } from '$lib/recent/types';
import { sha256Hex } from '$lib/source/sha256';
import type { FileSource } from '$lib/state/hash';
import { opener, UNPUBLISHED, type Stage } from './open';
import { openPublished } from './published';

vi.mock('$lib/about', () => ({ ABOUT: { source: null, converter: 'converter', conversion: 'this-conversion' } }));
vi.mock('$lib/convert/jit', () => ({ jitOff: () => false }));

const seed = FIXTURES['seed-v15'];
const STEP_URL = seed.urls[0];
const source: FileSource = { kind: 'url', url: STEP_URL, sha256: seed.sha256 };

/** The fixture catalogue, its Lamp at the latest version pointing at the test file and the files published for it. */
function catalogueFor(published: Published, conversion = 'this-conversion'): Catalogue {
	const catalogue = fixtureCatalogue();
	const version = catalogue.models.lamp.versions[0];
	version.step = { sha256: seed.sha256, size: seed.size, url: STEP_URL };
	version.files = { glb: published.summary.glb, measure: published.summary.measure };
	return { ...catalogue, conversion };
}

/** A host whose Blossom servers hold these files by hash, and whose STEP download and converter only record calls. */
function hostFor(catalogue: Catalogue, files: Uint8Array[], recent?: RecentStore) {
	const transport = {
		blob: vi.fn<Transport['blob']>(async (sha256, _servers, onProgress) => {
			const bytes = files.find((file) => sha256Hex(file) === sha256);
			if (!bytes) throw new TransportError('not-found', 'no server has it');
			onProgress?.(0.5);
			onProgress?.(1);
			return { bytes, url: null };
		}),
		url: vi.fn<Transport['url']>(async () => fixtureBytes('seed-v15')!)
	};
	const converter = { prepare: vi.fn(), convert: vi.fn<Converter['convert']>(async () => ({ ...converted, ms: {} })) };
	const host = { transport, converter, servers: [], catalogue, recent } as unknown as Host;
	return { host, transport, converter };
}

let published: Published;
let converted: Awaited<ReturnType<typeof convert>>;

async function open(host: Host) {
	const stages: Stage[] = [];
	const opened = await opener()(host, source, null, (stage) => stages.push(stage), new AbortController().signal);
	return { opened, stages };
}

describe.skipIf(lacking({ ...CONVERTER, path: WASM }, fixtureFile('seed-v15')))('a published conversion', () => {
	beforeAll(async () => {
		converted = await convert(fixtureBytes('seed-v15')!, seed.file);
		published = await publishable(fixtureBytes('seed-v15')!, converted);
	}, 300_000);

	it('opens with neither the STEP file nor the converter', async () => {
		const { host, transport, converter } = hostFor(catalogueFor(published), [published.glb, published.measure]);
		const { opened, stages } = await open(host);
		expect(opened.model.glb).toEqual(published.glb);
		// As JSON, which has no negative zero.
		expect(JSON.stringify(opened.model.measure)).toBe(JSON.stringify({ ...converted.measure, glb: published.summary.glb.sha256 }));
		expect(opened.model).toMatchObject({ unit: 'mm', solids: converted.measure.solids.length, warnings: [] });
		expect(opened.model.measure.v).toBe(MEASURE_VERSION);
		expect(opened.file).toEqual({ name: 'Seed-v15.step', sha256: seed.sha256, size: seed.size, download: STEP_URL });
		expect(opened.kept).toBe(false);
		expect(transport.blob.mock.calls.map(([sha256, servers]) => [sha256, servers])).toEqual([
			[published.summary.glb.sha256, ['https://blossom.example.com', 'https://cdn.example.com']],
			[published.summary.measure.sha256, ['https://blossom.example.com', 'https://cdn.example.com']]
		]);
		expect(transport.url).not.toHaveBeenCalled();
		expect(converter.prepare).not.toHaveBeenCalled();
		expect(converter.convert).not.toHaveBeenCalled();
		// Both files count toward one bar, by their sizes.
		expect(stages[0]).toEqual({ label: 'Downloading Lamp', fraction: null });
		expect(stages.at(-1)).toEqual({ label: 'Downloading Lamp', fraction: 1 });
	});

	it('converts the STEP file when a file does not match its hash, and says so', async () => {
		const catalogue = catalogueFor(published);
		const { host, transport, converter } = hostFor(catalogue, [published.glb, published.measure]);
		// A transport that does not check hashes, and a server that sends the other file under this one's name.
		transport.blob.mockImplementation(async () => ({ bytes: published.measure, url: null }));
		const { opened, stages } = await open(host);
		expect(transport.url).toHaveBeenCalledOnce();
		expect(converter.convert).toHaveBeenCalledOnce();
		expect(opened.model.glb).toEqual(converted.glb);
		expect(stages.filter((stage) => stage.label === 'Downloading Lamp' && stage.note === UNPUBLISHED)).not.toEqual([]);
	});

	it('converts the STEP file when no server has the files', async () => {
		const { host, transport, converter } = hostFor(catalogueFor(published), []);
		await open(host);
		expect(transport.url).toHaveBeenCalledOnce();
		expect(converter.convert).toHaveBeenCalledOnce();
	});

	it('is not taken from a catalogue made with another conversion', async () => {
		const { host, transport, converter } = hostFor(catalogueFor(published, 'another-conversion'), [published.glb, published.measure]);
		const { stages } = await open(host);
		expect(transport.blob).not.toHaveBeenCalled();
		expect(converter.convert).toHaveBeenCalledOnce();
		expect(stages.some((stage) => stage.note)).toBe(false);
	});

	it("downloads the STEP file against the size the catalogue knows, when it converts", async () => {
		const { host, transport } = hostFor(catalogueFor(published, 'another-conversion'), []);
		await open(host);
		expect(transport.url.mock.calls[0][3]).toBe(seed.size);
	});

	it('is kept on this device afterwards, so it opens again without a download', async () => {
		const recent = indexedDbRecent(new IDBFactory());
		const { host, transport } = hostFor(catalogueFor(published), [published.glb, published.measure], recent);
		const { opened } = await open(host);
		// As the app keeps what it opened.
		const entry = { key: `sha256:${seed.sha256}`, route: '#/lamp@aaaaaaa', name: opened.file.name, sha256: seed.sha256, size: seed.size, parts: 1, viewedAt: 1, local: false, thumbnail: null };
		await recent.remember(entry, { conversion: 'this-conversion', model: { ...opened.model, download: opened.file.download } });
		transport.blob.mockClear();
		const again = await open(host);
		expect(again.opened).toMatchObject({ kept: true, file: { sha256: seed.sha256, download: STEP_URL } });
		expect(again.opened.model.glb).toEqual(published.glb);
		expect(again.opened.model.measure).toEqual(opened.model.measure);
		expect(transport.blob).not.toHaveBeenCalled();
	});
});

describe('the two files of a published conversion', () => {
	/** A transport whose downloads wait until their signal aborts, except those `fails` names, which fail at once. */
	function waiting(fails: string[] = []) {
		const signals: AbortSignal[] = [];
		const blob = vi.fn<Transport['blob']>((sha256, _servers, _progress, signal) => {
			signals.push(signal!);
			if (fails.includes(sha256)) return Promise.reject(new TransportError('not-found', 'no server has it'));
			if (signal!.aborted) return Promise.reject(signal!.reason);
			return new Promise((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason)));
		});
		return { host: { transport: { blob } } as unknown as Host, signals };
	}
	const catalogue = fixtureCatalogue();
	const { files } = catalogue.models.lamp.versions[0];

	it("both stop when the caller's signal aborts, in a browser without AbortSignal.any too", async () => {
		const any = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
		Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true });
		try {
			const { host, signals } = waiting();
			const caller = new AbortController();
			const opening = openPublished(host, catalogue, files, () => {}, caller.signal);
			caller.abort(new DOMException('replaced', 'AbortError'));
			await expect(opening).rejects.toThrow('replaced');
			expect(signals).toHaveLength(2);
			expect(signals.every((signal) => signal.aborted)).toBe(true);
		} finally {
			if (any) Object.defineProperty(AbortSignal, 'any', any);
		}
	});

	it('both stop when one of them fails, and neither waits when the caller aborted before', async () => {
		const { host, signals } = waiting([files.glb.sha256]);
		await expect(openPublished(host, catalogue, files, () => {}, new AbortController().signal)).rejects.toThrow('no server has it');
		expect(signals.every((signal) => signal.aborted)).toBe(true);
		const gone = waiting();
		await expect(openPublished(gone.host, catalogue, files, () => {}, AbortSignal.abort(new DOMException('gone', 'AbortError')))).rejects.toThrow('gone');
	});
});
