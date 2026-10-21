import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Converted, ConvertProgress, Converter } from '$lib/convert/types';
import type { Host, Progress, Transport } from '$lib/host/host';
import { TransportError } from '$lib/host/host';
import { MEASURE_VERSION } from '$lib/measure/format';
import type { KeptModel, RecentEntry, RecentStore } from '$lib/recent/types';
import { explainLoadError } from '$lib/source/load';
import { localFile } from '$lib/source/local';
import { sha256Hex } from '$lib/source/sha256';
import type { FileSource } from '$lib/state/hash';
import { NO_JIT, opener, QUICK_LOOKUP, SLOW_LOOKUP, type Stage } from './open';

// Kept models are matched to the conversion that made them; the build's own id depends on the converter being there.
vi.mock('$lib/about', () => ({ ABOUT: { source: null, converter: 'converter', conversion: 'this-conversion' } }));
// Whether the browser has a JIT is each test's to say, not this machine's.
const jit = vi.hoisted(() => ({ off: false as boolean | null }));
vi.mock('$lib/convert/jit', () => ({ jitOff: () => jit.off }));

const utf8 = (text: string) => new TextEncoder().encode(text);
const step = (label: string) => utf8(`ISO-10303-21;\n/* ${label} */\nEND-ISO-10303-21;\n`);
const at = (name: string) => `https://files.example/${name}`;
const linkTo = (name: string, sha256?: string): FileSource => ({ kind: 'url', url: at(name), ...(sha256 ? { sha256 } : {}) });

const modelOf = (bytes: Uint8Array): Converted => ({
	glb: bytes,
	measure: { v: MEASURE_VERSION, units: 'mm', glb: sha256Hex(bytes), solids: [] },
	doc: 'part',
	unit: 'mm',
	solids: 1,
	triangles: 12,
	warnings: [],
	ms: {}
});

/** The store's entry and model for a file kept on this device. */
const keptFor = (sha256: string): { model: KeptModel; entry: RecentEntry } => ({
	model: { ...modelOf(step('kept')), download: at('kept.step') },
	entry: { key: `sha256:${sha256}`, route: `#/b/${sha256}`, name: 'kept.step', sha256, size: 4321, parts: 3, viewedAt: 1, local: false, thumbnail: null }
});

/** Stands in until the test lets it finish, or until the signal aborts it; then it rejects with the signal's reason. */
function held<T>(signal: AbortSignal | undefined, onAbort = () => {}) {
	let finish!: (value: T) => void;
	const promise = new Promise<T>((resolve, reject) => {
		finish = resolve;
		signal?.addEventListener('abort', () => {
			onAbort();
			reject(signal.reason);
		});
	});
	return { promise, finish };
}

type Fakes = { url?: Transport['url']; convert?: Converter['convert']; recent?: Partial<RecentStore> };

/** A host whose transport serves each file's name as its bytes, and whose converter turns bytes into a model at once. */
function fakeHost(fakes: Fakes = {}) {
	const transport = {
		blob: vi.fn<Transport['blob']>(async () => {
			throw new TransportError('not-found', 'no server has it');
		}),
		url: vi.fn<Transport['url']>(fakes.url ?? (async (url) => step(url)))
	};
	const converter = {
		prepare: vi.fn(),
		convert: vi.fn<Converter['convert']>(fakes.convert ?? (async (bytes, _name, onProgress) => (onProgress({ phase: 'start' }), modelOf(bytes))))
	};
	const host = { transport, converter, servers: [], recent: fakes.recent } as unknown as Host;
	return { host, transport, converter };
}

/** A load as the app starts it, and the stages it reported. */
function start(open: ReturnType<typeof opener>, host: Host, source: FileSource, name: string | null = null) {
	const controller = new AbortController();
	const stages: Stage[] = [];
	const opened = open(host, source, name, (stage) => stages.push(stage), controller.signal);
	return { opened, stages, controller, labels: () => stages.map((s) => s.label) };
}

afterEach(() => {
	vi.useRealTimers();
	jit.off = false;
});

describe('opening a file', () => {
	it('downloads, converts and says so in stages', async () => {
		const { host } = fakeHost({
			url: async (url, onProgress) => (onProgress?.(0.5), step(url)),
			convert: async (bytes, _name, onProgress) => {
				for (const progress of [{ phase: 'start' }, { phase: 'read', fraction: 0.3 }, { phase: 'mesh', done: 1, total: 4 }] satisfies ConvertProgress[]) onProgress(progress);
				return modelOf(bytes);
			}
		});
		const load = start(opener(), host, linkTo('part.step'), 'part.step');
		const opened = await load.opened;
		expect(load.stages).toEqual([
			{ label: 'Downloading part.step', fraction: null },
			{ label: 'Downloading part.step', fraction: 0.5 },
			{ label: 'Starting the converter', fraction: null },
			{ label: 'Starting the converter', fraction: null },
			{ label: 'Reading the STEP file', fraction: 0.3 },
			{ label: 'Meshing part 2 of 4', fraction: 0.25 }
		]);
		const bytes = step(at('part.step'));
		expect(opened).toEqual({
			model: modelOf(bytes),
			file: { name: 'part.step', sha256: sha256Hex(bytes), size: bytes.length, download: at('part.step') },
			kept: false,
			seen: null
		});
	});

	it('gives every stage of a conversion a heads-up when the browser has no JIT', async () => {
		jit.off = true;
		const { host } = fakeHost({
			convert: async (bytes, _name, onProgress) => (onProgress({ phase: 'read', fraction: 0.3 }), modelOf(bytes))
		});
		const load = start(opener(), host, linkTo('part.step'), 'part.step');
		await load.opened;
		expect(load.stages).toEqual([
			{ label: 'Downloading part.step', fraction: null },
			{ label: 'Starting the converter', fraction: null, note: NO_JIT },
			{ label: 'Reading the STEP file', fraction: 0.3, note: NO_JIT }
		]);
	});

	it('says nothing about a JIT it cannot measure', async () => {
		jit.off = null;
		const load = start(opener(), fakeHost().host, linkTo('part.step'));
		await load.opened;
		expect(load.stages.some((stage) => stage.note)).toBe(false);
	});

	it('stops when cancelled during the download, and reports nothing after', async () => {
		let progress: Progress | undefined;
		const { host, converter } = fakeHost({
			url: (_url, onProgress, signal) => ((progress = onProgress), held<Uint8Array>(signal, () => onProgress?.(0.9)).promise)
		});
		const load = start(opener(), host, linkTo('part.step'), 'part.step');
		await vi.waitFor(() => expect(progress).toBeDefined());
		progress!(0.4);
		load.controller.abort();
		await expect(load.opened).rejects.toMatchObject({ name: 'AbortError' });
		expect(load.stages).toEqual([
			{ label: 'Downloading part.step', fraction: null },
			{ label: 'Downloading part.step', fraction: 0.4 }
		]);
		expect(converter.convert).not.toHaveBeenCalled();
	});

	it('stops when cancelled during the conversion, and reports nothing after', async () => {
		const { host, converter } = fakeHost({
			convert: (_bytes, _name, onProgress, signal) => {
				onProgress({ phase: 'read', fraction: 0.2 });
				return held<Converted>(signal, () => onProgress({ phase: 'mesh', done: 1, total: 2 })).promise;
			}
		});
		const load = start(opener(), host, linkTo('part.step'));
		await vi.waitFor(() => expect(converter.convert).toHaveBeenCalled());
		load.controller.abort();
		await expect(load.opened).rejects.toMatchObject({ name: 'AbortError' });
		expect(load.labels()).toEqual(['Downloading the file', 'Starting the converter', 'Reading the STEP file']);
	});

	it('shows a kept model without downloading or converting', async () => {
		const sha256 = sha256Hex(step('kept'));
		const kept = keptFor(sha256);
		const model = vi.fn<NonNullable<RecentStore['model']>>(async () => kept);
		const { host, transport, converter } = fakeHost({ recent: { entry: async () => null, model } });
		const load = start(opener(), host, linkTo('part.step', sha256));
		expect(await load.opened).toEqual({
			model: kept.model,
			file: { name: 'kept.step', sha256, size: 4321, download: at('kept.step') },
			kept: true,
			seen: kept.entry
		});
		expect(model).toHaveBeenCalledWith(`sha256:${sha256}`, sha256, 'this-conversion');
		expect(transport.url).not.toHaveBeenCalled();
		expect(converter.prepare).not.toHaveBeenCalled();
		expect(converter.convert).not.toHaveBeenCalled();
		expect(load.stages).toEqual([]);
	});

	it('goes on without a store that answers too slowly', async () => {
		vi.useFakeTimers();
		const bytes = step(at('part.step'));
		const sha256 = sha256Hex(bytes);
		const never = () => new Promise<never>(() => {});
		const { host, transport } = fakeHost({ recent: { entry: never, model: never } });
		const load = start(opener(), host, linkTo('part.step', sha256));
		await vi.advanceTimersByTimeAsync(QUICK_LOOKUP);
		// The entry gave up; the model, which can be large, has longer.
		expect(transport.url).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(SLOW_LOOKUP - QUICK_LOOKUP);
		expect(await load.opened).toMatchObject({ kept: false, seen: null, file: { sha256 } });
		expect(transport.url).toHaveBeenCalledOnce();
	});

	it('opens a file from this device from the bytes the store kept', async () => {
		const bytes = step('from this device');
		const sha256 = sha256Hex(bytes);
		const { host, transport } = fakeHost({ recent: { entry: async () => null, file: async () => bytes } });
		const load = start(opener(), host, { kind: 'blob', sha256, servers: [] }, 'bracket.step');
		expect(await load.opened).toMatchObject({ kept: false, file: { name: 'bracket.step', sha256, download: null } });
		expect(localFile(sha256)?.name).toBe('bracket.step');
		expect(transport.blob).not.toHaveBeenCalled();
		expect(load.labels()).toEqual(['Starting the converter', 'Starting the converter']);
	});

	it('fails a download with the reason the person is shown', async () => {
		const refused = new TransportError('too-large', 'over the limit', 30e6);
		const { host, converter } = fakeHost({
			url: async () => {
				throw refused;
			}
		});
		const failure = await start(opener(), host, linkTo('part.step')).opened.catch((err: unknown) => err);
		expect(failure).toBe(refused);
		expect(explainLoadError(failure)).toEqual({ message: 'This host fetches files only up to a limit, and this one is larger (30.0 MB).', hint: 'local' });
		expect(converter.convert).not.toHaveBeenCalled();
	});

	it('lets a second open stop the first, as the app does by aborting it', async () => {
		// A transport that cannot stop a transfer, as a shell may: the first file still arrives, late.
		const downloads: ((bytes: Uint8Array) => void)[] = [];
		const { host, converter } = fakeHost({ url: () => new Promise((resolve) => downloads.push(resolve)) });
		const open = opener();
		const first = start(open, host, linkTo('first.step'), 'first.step');
		await vi.waitFor(() => expect(downloads).toHaveLength(1));
		first.controller.abort();
		const second = start(open, host, linkTo('second.step'), 'second.step');
		await vi.waitFor(() => expect(downloads).toHaveLength(2));
		downloads[0](step('first'));
		await expect(first.opened).rejects.toMatchObject({ name: 'AbortError' });
		downloads[1](step('second'));
		expect(await second.opened).toMatchObject({ file: { name: 'second.step' } });
		expect(first.labels()).toEqual(['Downloading first.step']);
		expect(converter.convert.mock.calls.map(([, name]) => name)).toEqual(['second.step']);
	});

	it('gives a file converted a moment ago again without converting it', async () => {
		const { host, converter } = fakeHost();
		const open = opener();
		const before = await start(open, host, linkTo('part.step')).opened;
		const again = start(open, host, linkTo('part.step'));
		expect((await again.opened).model).toBe(before.model);
		expect(converter.convert).toHaveBeenCalledOnce();
		expect(again.labels()).toEqual(['Downloading the file']);
	});

	it('keeps the last three conversions of the session', async () => {
		const { host, converter } = fakeHost();
		const open = opener();
		for (const name of ['a.step', 'b.step', 'c.step', 'd.step', 'b.step', 'a.step']) await start(open, host, linkTo(name)).opened;
		// a was the oldest when d came in; b was still kept.
		expect(converter.convert.mock.calls.map(([, name]) => name)).toEqual(['a.step', 'b.step', 'c.step', 'd.step', 'a.step']);
	});
});
