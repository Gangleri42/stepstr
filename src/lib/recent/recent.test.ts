import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import type { MeasureData } from '$lib/measure/format';
import { indexedDbRecent } from './indexeddb';
import { nappletRecent } from './napplet';
import type { KeptModel, RecentEntry, RecentStore } from './types';
import { RECENT_LIMIT } from './types';

const entry = (n: number, extra: Partial<RecentEntry> = {}): RecentEntry => ({
	key: `sha256:${String(n).padStart(64, '0')}`,
	route: `#/b/${String(n).padStart(64, '0')}`,
	name: `part-${n}.step`,
	sha256: String(n).padStart(64, '0'),
	size: 1000 + n,
	parts: 3,
	viewedAt: 1_000_000 + n,
	local: false,
	thumbnail: null,
	...extra
});
const model = (bytes: number): KeptModel => ({
	glb: new Uint8Array(bytes),
	measure: { v: 1, units: 'mm', glb: 'x', solids: [] } as MeasureData,
	doc: 'part',
	unit: 'mm',
	solids: 1,
	triangles: 12,
	warnings: [],
	download: null
});

describe('the web store', () => {
	const keptModel = (store: RecentStore, n: number, conversion: string) => store.model!(entry(n).key, entry(n).sha256, conversion).then((kept) => kept?.model ?? null);
	it('lists newest first and keeps a model for this conversion only', async () => {
		const store = indexedDbRecent(new IDBFactory());
		await store.remember(entry(1), { conversion: 'c1', model: model(100) });
		await store.remember(entry(2));
		expect((await store.list()).map((e) => e.name)).toEqual(['part-2.step', 'part-1.step']);
		expect((await store.list())[1].kept).toBe(true);
		expect((await keptModel(store, 1, 'c1'))?.glb.byteLength).toBe(100);
		expect((await keptModel(store, 1, 'c1'))?.measure).toEqual(model(1).measure);
		expect((await store.model!(entry(1).key, entry(1).sha256, 'c1'))?.entry).toMatchObject({ name: 'part-1.step', size: 1001, thumbnail: null });
		expect(await keptModel(store, 1, 'c2')).toBeNull();
		// A newer conversion's model replaces the older one.
		await store.remember(entry(1, { viewedAt: 2_000_000 }), { conversion: 'c2', model: model(80) });
		expect(await keptModel(store, 1, 'c1')).toBeNull();
		expect((await keptModel(store, 1, 'c2'))?.glb.byteLength).toBe(80);
	});

	it('keeps the bytes of a file from this device, and forgets them with it', async () => {
		const store = indexedDbRecent(new IDBFactory());
		const bytes = new TextEncoder().encode('ISO-10303-21;');
		await store.remember(entry(3, { local: true }), { conversion: 'c1', model: model(10), bytes });
		expect(await store.file!(entry(3).sha256)).toEqual(bytes);
		await store.forget(entry(3).key);
		expect(await store.list()).toEqual([]);
		expect(await store.file!(entry(3).sha256)).toBeNull();
		expect(await keptModel(store, 3, 'c1')).toBeNull();
	});

	it(`holds ${RECENT_LIMIT} entries, and models within its budget, newest first`, async () => {
		// A model here takes 100 bytes of GLB and 42 of measurements.
		const store = indexedDbRecent(new IDBFactory(), 300);
		for (let n = 1; n <= RECENT_LIMIT + 2; n++) await store.remember(entry(n), { conversion: 'c1', model: model(100) });
		const list = await store.list();
		expect(list).toHaveLength(RECENT_LIMIT);
		expect(list[0].name).toBe(`part-${RECENT_LIMIT + 2}.step`);
		// Two models fit the budget; older entries stay as links.
		expect(list.map((e) => e.kept)).toEqual(list.map((_, i) => i < 2));
		expect(await keptModel(store, 1, 'c1')).toBeNull();
	});

	it('reopens in the view it was left in, and clears', async () => {
		const store = indexedDbRecent(new IDBFactory());
		await store.remember(entry(4));
		await store.update(entry(4).key, '#/b/4?cut=x:1');
		expect((await store.list())[0].route).toBe('#/b/4?cut=x:1');
		await store.clear();
		expect(await store.list()).toEqual([]);
	});

	it('lists nothing, and fails nothing, where the browser keeps nothing', async () => {
		const store = indexedDbRecent(null);
		await store.remember(entry(5));
		expect(await store.list()).toEqual([]);
		expect(await store.entry(entry(5).key)).toBeNull();
		expect(await keptModel(store, 5, 'c1')).toBeNull();
	});

	it('gives an entry as kept, and keeps its picture when a later visit brings none', async () => {
		const store = indexedDbRecent(new IDBFactory());
		const picture = 'data:image/webp;base64,AAAA';
		await store.remember(entry(7, { thumbnail: picture, local: true }));
		await store.remember(entry(7, { viewedAt: 2_000_000, local: true }));
		expect(await store.entry(entry(7).key)).toMatchObject({ name: 'part-7.step', size: 1007, local: true, thumbnail: null });
		expect((await store.list())[0].thumbnail).toBe(picture);
		expect(await store.entry(entry(8).key)).toBeNull();
	});

	it('lists a file whose model the browser has no room for', async () => {
		const store = indexedDbRecent(new IDBFactory());
		const put = IDBObjectStore.prototype.put;
		const full = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
			if (this.name === 'models') throw new DOMException('no room', 'QuotaExceededError');
			return put.call(this, value, key);
		});
		try {
			await store.remember(entry(6), { conversion: 'c1', model: model(100) });
		} finally {
			full.mockRestore();
		}
		const list = await store.list();
		expect(list.map((e) => [e.name, e.kept])).toEqual([['part-6.step', false]]);
		expect(await keptModel(store, 6, 'c1')).toBeNull();
	});

	it('keeps nothing that was asked for before a clear, even when the write is retried', async () => {
		const store = indexedDbRecent(new IDBFactory());
		const put = IDBObjectStore.prototype.put;
		const full = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
			if (this.name === 'models') throw new DOMException('no room', 'QuotaExceededError');
			return put.call(this, value, key);
		});
		try {
			await Promise.all([store.remember(entry(9), { conversion: 'c1', model: model(10) }), store.clear()]);
		} finally {
			full.mockRestore();
		}
		expect(await store.list()).toEqual([]);
	});
});

describe('the napplet store', () => {
	/** A shell's storage, with its quota for all of a napplet's keys and values, as the dev shell and Paja count it. */
	const shell = (quota = 512 * 1024) => {
		const items = new Map<string, string>();
		return {
			items,
			getItem: async (key: string) => items.get(key) ?? null,
			setItem: async (key: string, value: string) => {
				const used = [...items].reduce((n, [k, v]) => n + (k === key ? 0 : k.length + v.length), 0);
				if (used + key.length + value.length > quota) throw new Error('quota-exceeded');
				items.set(key, value);
			},
			removeItem: async (key: string) => void items.delete(key)
		};
	};
	const picture = (size: number) => `data:image/webp;base64,${'A'.repeat(size)}`;

	it('keeps the list in the shell, a change at a time', async () => {
		const storage = shell();
		const store = nappletRecent(storage);
		await Promise.all([store.remember(entry(1)), store.remember(entry(2)), store.update(entry(1).key, '#/b/1?ortho=1')]);
		const list = await store.list();
		expect(list.map((e) => e.name)).toEqual(['part-2.step', 'part-1.step']);
		expect(list[1].route).toBe('#/b/1?ortho=1');
		expect(store.model).toBeUndefined();
		await store.forget(entry(2).key);
		expect((await store.list()).map((e) => e.name)).toEqual(['part-1.step']);
	});

	it('drops the oldest pictures first to stay within the quota', async () => {
		const store = nappletRecent(shell());
		for (let n = 1; n <= 10; n++) await store.remember(entry(n, { thumbnail: picture(60_000), viewedAt: n }));
		const list = await store.list();
		expect(list).toHaveLength(10);
		expect(list[0].thumbnail).toBe(picture(60_000));
		expect(list.at(-1)!.thumbnail).toBeNull();
		expect(JSON.stringify(list).length).toBeLessThan(400_000);
	});

	it('keeps the whole list, and fewer pictures, in a shell with less room', async () => {
		const store = nappletRecent(shell(150_000));
		for (let n = 1; n <= 8; n++) await store.remember(entry(n, { thumbnail: picture(40_000), viewedAt: n }));
		const list = await store.list();
		expect(list).toHaveLength(8);
		expect(list[0].thumbnail).toBe(picture(40_000));
		expect(list.filter((e) => e.thumbnail).length).toBeGreaterThan(1);
		expect(list.filter((e) => e.thumbnail).length).toBeLessThan(4);
	});

	it('makes room for the list with the pictures, and keeps pictures again once there is room', async () => {
		const storage = shell(100_000);
		const store = nappletRecent(storage);
		await store.remember(entry(1, { thumbnail: picture(99_000) }));
		expect((await store.list())[0].thumbnail).toBe(picture(99_000));
		// A longer list no longer fits beside the picture: the list goes in, the picture goes.
		await store.remember(entry(2, { name: `${'x'.repeat(1000)}.step` }));
		expect((await store.list()).map((e) => e.thumbnail)).toEqual([null, null]);
		await store.remember(entry(3, { thumbnail: picture(10_000) }));
		expect((await store.list())[0].thumbnail).toBe(picture(10_000));
	});

	it('writes nothing over a list it could not read', async () => {
		const storage = shell();
		const store = nappletRecent(storage);
		await store.remember(entry(1));
		await store.remember(entry(2));
		const getItem = storage.getItem;
		storage.getItem = async () => {
			throw new Error('State request timed out');
		};
		await store.remember(entry(3));
		await store.forget(entry(1).key);
		expect(await store.entry(entry(2).key)).toBeNull();
		storage.getItem = getItem;
		expect((await store.list()).map((e) => e.name)).toEqual(['part-2.step', 'part-1.step']);
	});

	it('rewrites only the list when a view changes, and keeps a picture a later visit does not bring', async () => {
		const storage = shell();
		const store = nappletRecent(storage);
		await store.remember(entry(1, { thumbnail: picture(50_000) }));
		const written: string[] = [];
		const setItem = storage.setItem;
		storage.setItem = async (key, value) => {
			written.push(key);
			return setItem(key, value);
		};
		await store.update(entry(1).key, '#/b/1?ortho=1');
		expect(written).toEqual(['recent']);
		expect((await store.list())[0].route).toBe('#/b/1?ortho=1');
		await store.remember(entry(1, { viewedAt: 2_000_000 }));
		const [kept] = await store.list();
		expect(kept.viewedAt).toBe(2_000_000);
		expect(kept.thumbnail).toBe(picture(50_000));
		expect(await store.entry(entry(1).key)).toMatchObject({ name: 'part-1.step', thumbnail: null });
	});

	it('forgets an entry with its picture', async () => {
		const storage = shell();
		const store = nappletRecent(storage);
		await store.remember(entry(1, { thumbnail: picture(10) }));
		await store.remember(entry(2, { thumbnail: picture(20) }));
		await store.forget(entry(1).key);
		expect(storage.items.get('recent-pictures')).not.toContain(entry(1).key);
		await store.clear();
		expect([...storage.items.keys()]).toEqual([]);
	});

	it('ignores what is not an entry, and a key it has seen', async () => {
		const storage = shell();
		storage.items.set('recent', JSON.stringify([{ key: 1 }, entry(1), 'text', entry(2), entry(1, { name: 'again.step' }), { ...entry(3), sha256: '../x' }]));
		storage.items.set('recent-pictures', JSON.stringify({ [entry(1).key]: 'javascript:alert(1)', [entry(2).key]: picture(4) }));
		const list = await nappletRecent(storage).list();
		expect(list.map((e) => e.name)).toEqual(['part-1.step', 'part-2.step']);
		expect(list.map((e) => e.thumbnail)).toEqual([null, picture(4)]);
	});
});
