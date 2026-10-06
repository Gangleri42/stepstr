// A napplet's recently viewed files, in the shell's storage (NAP-STORAGE), inside the 512 KB a shell grants a napplet:
// the list under one key, a few kilobytes, and the pictures under another, as many as there is room for, newest first.
// A view change rewrites the list alone, and pictures never crowd out the list. Models are not kept; a napplet reopens
// a file by fetching and converting it again.
import type { NappletApi } from '$lib/host/napplet-runtime';
import type { RecentEntry, RecentStore } from './types';
import { asEntries, withEntry } from './types';

const LIST = 'recent';
const PICTURES = 'recent-pictures';
/** Characters the pictures may take: the shell's quota, less room for the list. */
const PICTURE_BUDGET = 400_000;

type ShellStorage = NonNullable<NappletApi['storage']>;
type Pictures = Record<string, string>;

/** A shell that refuses a write for want of room: Paja and the dev shell both say "quota". */
const isQuota = (err: unknown) => err instanceof Error && /quota/i.test(err.message);

export function nappletRecent(storage: ShellStorage): RecentStore {
	/** The value stored under a key; throws when the shell does not answer, so no change writes over what it could not read. */
	const get = async (key: string): Promise<unknown> => {
		const text = await storage.getItem(key);
		try {
			return text === null ? null : JSON.parse(text);
		} catch {
			// Written by something else, or broken: as good as nothing, and the next change writes over it.
			return null;
		}
	};
	const readList = async () => asEntries(await get(LIST));
	const readPictures = async () => {
		const value = await get(PICTURES);
		const pictures: Pictures = {};
		if (value && typeof value === 'object' && !Array.isArray(value)) {
			for (const [key, picture] of Object.entries(value)) if (typeof picture === 'string' && picture.startsWith('data:image/')) pictures[key] = picture;
		}
		return pictures;
	};

	/** The list, without its pictures. When the shell has no room for it, the pictures make room. */
	const storeList = async (list: RecentEntry[]) => {
		const text = JSON.stringify(list.map(({ thumbnail: _, kept: __, ...entry }) => entry));
		try {
			await storage.setItem(LIST, text);
		} catch (err) {
			if (!isQuota(err)) throw err;
			await storage.removeItem(PICTURES);
			await storage.setItem(LIST, text);
		}
	};
	/**
	 * The pictures of the entries in the list, newest first, as many as fit. A shell with less room than most gets fewer,
	 * and more again once the room is back.
	 */
	const storePictures = async (list: RecentEntry[], pictures: Pictures) => {
		let budget = PICTURE_BUDGET;
		for (;;) {
			const kept: Pictures = {};
			let size = 2;
			for (const { key } of list) {
				const picture = pictures[key];
				if (!picture || size + key.length + picture.length + 6 > budget) continue;
				kept[key] = picture;
				size += key.length + picture.length + 6;
			}
			const text = JSON.stringify(kept);
			try {
				await (text === '{}' ? storage.removeItem(PICTURES) : storage.setItem(PICTURES, text));
				return;
			} catch (err) {
				if (!isQuota(err) || text === '{}') throw err;
				budget = Math.floor(text.length * 0.75);
			}
		}
	};
	/** Rewrites the pictures for this list, with this entry's new one. A picture whose entry is gone goes with it. */
	const prune = async (list: RecentEntry[], entry?: RecentEntry) => {
		const pictures = await readPictures();
		if (entry?.thumbnail) pictures[entry.key] = entry.thumbnail;
		await storePictures(list, pictures);
	};

	// Each change reads what it changes and writes it back: one at a time, so none is lost.
	let queue: Promise<unknown> = Promise.resolve();
	const change = (work: () => Promise<void>) => {
		const run = queue.then(work);
		queue = run.catch(() => undefined);
		return run.catch(() => undefined);
	};

	return {
		async list() {
			await queue;
			const [list, pictures] = await Promise.all([readList().catch(() => []), readPictures().catch((): Pictures => ({}))]);
			return list.map((entry) => ({ ...entry, thumbnail: pictures[entry.key] ?? null }));
		},
		remember: (entry) =>
			change(async () => {
				const list = withEntry(await readList(), entry);
				await storeList(list);
				await prune(list, entry);
			}),
		update: (key, route) =>
			change(async () => {
				const list = await readList();
				const i = list.findIndex((e) => e.key === key);
				if (i >= 0 && list[i].route !== route) await storeList(list.map((e, j) => (j === i ? { ...e, route } : e)));
			}),
		forget: (key) =>
			change(async () => {
				const list = (await readList()).filter((e) => e.key !== key);
				await storeList(list);
				await prune(list);
			}),
		clear: () =>
			change(async () => {
				await storage.removeItem(LIST);
				await storage.removeItem(PICTURES);
			}),
		async entry(key) {
			await queue;
			return (await readList().catch(() => [])).find((e) => e.key === key) ?? null;
		}
	};
}
