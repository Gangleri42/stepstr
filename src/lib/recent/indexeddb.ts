// The web build's recently viewed files, in this browser's IndexedDB: the list with its pictures, the models the
// converter made, so a file reopens without being downloaded or converted again, and the bytes of files from this
// device. Kept models and files share a budget; past it the oldest go first, and their entries stay, as links.
import type { MeasureData } from '$lib/measure/format';
import type { KeptCompanion, KeptModel, RecentEntry, RecentStore } from './types';
import { asEntry, RECENT_LIMIT } from './types';

const NAME = 'stepstr';
const VERSION = 1;
/** Bytes of kept models and files, at most. */
const KEPT_BUDGET = 400e6;
/** How long opening the database may take before it counts as failed: some browsers leave an open hanging. */
const OPEN_MS = 5000;

/** An entry as stored, with the bytes kept for it. */
type Row = Omit<RecentEntry, 'kept'> & { kept: number };
/** A model as kept, its measurements as JSON text so the budget can count their size. */
type Stored = { model: Omit<KeptModel, 'measure'>; measure: string };
/**
 * A kept model, and the companion shown with it last. The companion came after version 1 of the database: a row
 * without one reads as before, so no upgrade is needed.
 */
type ModelRow = Stored & { id: string; sha256: string; conversion: string; with?: Stored & { sha256: string } };
type FileRow = { sha256: string; bytes: Uint8Array };
type Stores = { recent: IDBObjectStore; models: IDBObjectStore; files: IDBObjectStore };
/** What `remember` keeps of a model, in the form it is stored in. */
type Kept = { conversion: string; model: Stored; bytes?: Uint8Array; with?: Stored & { sha256: string } };

const request = <T>(r: IDBRequest<T>) =>
	new Promise<T>((resolve, reject) => {
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
	});
const finished = (t: IDBTransaction) =>
	new Promise<void>((resolve, reject) => {
		t.oncomplete = () => resolve();
		t.onerror = t.onabort = () => reject(t.error ?? new Error('the transaction was aborted'));
	});
const asRow = (value: unknown): Row | null => {
	const entry = asEntry(value);
	const kept = (value as { kept?: unknown } | null)?.kept;
	return entry ? { ...entry, kept: typeof kept === 'number' && kept > 0 ? kept : 0 } : null;
};
const entryOf = ({ kept, ...entry }: Row): RecentEntry => ({ ...entry, kept: kept > 0 });
const stored = ({ measure, ...model }: KeptModel): Stored => ({ model, measure: JSON.stringify(measure) });
const keptOf = (row: Stored): KeptModel => ({ ...row.model, measure: JSON.parse(row.measure) as MeasureData });
/** What a companion read back is, or nothing when the row's is not one. */
const companionOf = (row: ModelRow['with']): KeptCompanion | undefined =>
	row && typeof row.sha256 === 'string' && typeof row.measure === 'string' ? { sha256: row.sha256, model: keptOf(row) } : undefined;

/** The bytes this site may fill with kept models: the budget, or half of what the browser grants when that is less. */
async function room(budget: number) {
	try {
		const quota = (await globalThis.navigator?.storage?.estimate?.())?.quota;
		return quota ? Math.min(budget, quota / 2) : budget;
	} catch {
		return budget;
	}
}

export function indexedDbRecent(factory: IDBFactory | null = globalThis.indexedDB ?? null, budget = KEPT_BUDGET): RecentStore {
	let db: Promise<IDBDatabase> | null = null;
	/** The database, opened once; a failed or stalled open is tried again on the next call. */
	const open = () => {
		if (db) return db;
		const opening = new Promise<IDBDatabase>((resolve, reject) => {
			if (!factory) return reject(new Error('this browser keeps nothing here'));
			const r = factory.open(NAME, VERSION);
			let late = false;
			const timer = setTimeout(() => {
				late = true;
				reject(new Error('the database did not open'));
			}, OPEN_MS);
			r.onupgradeneeded = () => {
				const d = r.result;
				d.createObjectStore('recent', { keyPath: 'key' });
				d.createObjectStore('models', { keyPath: 'id' }).createIndex('sha256', 'sha256');
				d.createObjectStore('files', { keyPath: 'sha256' });
			};
			r.onsuccess = () => {
				clearTimeout(timer);
				const d = r.result;
				if (late) return d.close();
				// A newer version of the page, in another tab, asks for the database: it gets it, and this one opens it again.
				d.onversionchange = () => {
					d.close();
					db = null;
				};
				resolve(d);
			};
			r.onerror = () => {
				clearTimeout(timer);
				reject(r.error);
			};
		});
		db = opening;
		opening.catch(() => {
			if (db === opening) db = null;
		});
		return opening;
	};
	/** Runs changes one at a time, in the order they were asked for: no two interleave their reads and writes. */
	let queue: Promise<unknown> = Promise.resolve();
	const serial = <T>(change: () => Promise<T>) => {
		const run = queue.then(change);
		queue = run.catch(() => undefined);
		return run;
	};
	/** One read-write pass over all three stores. A pass that fails leaves the stores as they were. */
	const pass = async <T>(work: (stores: Stores) => Promise<T>) => {
		const tx = (await open()).transaction(['recent', 'models', 'files'], 'readwrite');
		try {
			const result = await work({ recent: tx.objectStore('recent'), models: tx.objectStore('models'), files: tx.objectStore('files') });
			await finished(tx);
			return result;
		} catch (err) {
			try {
				tx.abort();
			} catch {
				// The transaction has ended already.
			}
			throw err;
		}
	};
	const write = <T>(work: (stores: Stores) => Promise<T>) => serial(() => pass(work));
	const dropKept = async (models: IDBObjectStore, files: IDBObjectStore, sha256: string) => {
		for (const id of await request(models.index('sha256').getAllKeys(sha256))) models.delete(id);
		files.delete(sha256);
	};
	/** At most RECENT_LIMIT entries, and the newest entries' models and files within the room there is. */
	const trim = ({ recent, models, files }: Stores, rows: Row[], room: number) => {
		let used = 0;
		const drops: Promise<void>[] = [];
		rows.sort((a, b) => b.viewedAt - a.viewedAt).forEach((row, i) => {
			if (i >= RECENT_LIMIT) {
				recent.delete(row.key);
				drops.push(dropKept(models, files, row.sha256));
			} else if (row.kept && used + row.kept > room) {
				recent.put({ ...row, kept: 0 });
				drops.push(dropKept(models, files, row.sha256));
			} else used += row.kept;
		});
		return Promise.all(drops);
	};
	/** Puts the entry in, with its model and companion when given. */
	const record = (entry: RecentEntry, kept: Kept | null, room: number) =>
		pass(async (stores) => {
			const { recent, models, files } = stores;
			const before = asRow(await request(recent.get(entry.key)));
			let bytes = before?.kept ?? 0;
			if (kept) {
				// A model of these bytes by another conversion is of no more use.
				for (const id of await request(models.index('sha256').getAllKeys(entry.sha256))) models.delete(id);
				const { model, with: companion } = kept;
				const row: ModelRow = { id: `${entry.sha256} ${kept.conversion}`, sha256: entry.sha256, conversion: kept.conversion, ...model };
				models.put(companion ? { ...row, with: companion } : row);
				if (kept.bytes) files.put({ sha256: entry.sha256, bytes: kept.bytes } satisfies FileRow);
				// A file kept before stays, and counts.
				const file = kept.bytes?.byteLength ?? ((await request(files.count(entry.sha256))) ? entry.size : 0);
				const size = (one: Stored) => one.model.glb.byteLength + one.measure.length;
				bytes = size(model) + (companion ? size(companion) : 0) + file;
			}
			recent.put({ ...entry, thumbnail: entry.thumbnail ?? before?.thumbnail ?? null, kept: bytes } satisfies Row);
			const rows = (await request(recent.getAll())).map(asRow).filter((r): r is Row => !!r);
			await trim(stores, rows, room);
		});

	return {
		async list() {
			try {
				const tx = (await open()).transaction('recent');
				const rows = (await request(tx.objectStore('recent').getAll())).map(asRow).filter((r): r is Row => !!r);
				return rows.sort((a, b) => b.viewedAt - a.viewedAt).map(entryOf);
			} catch {
				return [];
			}
		},
		remember(entry, given) {
			const kept: Kept | null = given
				? {
						conversion: given.conversion,
						model: stored(given.model),
						...(given.bytes ? { bytes: given.bytes } : {}),
						...(given.with ? { with: { sha256: given.with.sha256, ...stored(given.with.model) } } : {})
					}
				: null;
			// Queued at once, so a later removal cannot overtake it, and retried in the same turn.
			return serial(async () => {
				// Worked out before the pass: a transaction ends when it waits on anything but its own requests.
				const space = await room(budget);
				try {
					await record(entry, kept, space);
				} catch {
					// Most likely the browser's own quota, smaller than the budget: the entry goes in without its model.
					if (kept) await record(entry, null, space);
				}
			}).catch(() => undefined);
		},
		async update(key, route) {
			await write(async ({ recent }) => {
				const row = asRow(await request(recent.get(key)));
				if (row && row.route !== route) recent.put({ ...row, route });
			}).catch(() => undefined);
		},
		async forget(key) {
			await write(async ({ recent, models, files }) => {
				const row = asRow(await request(recent.get(key)));
				recent.delete(key);
				if (row) await dropKept(models, files, row.sha256);
			}).catch(() => undefined);
		},
		async clear() {
			await write(async ({ recent, models, files }) => {
				recent.clear();
				models.clear();
				files.clear();
			}).catch(() => undefined);
		},
		async entry(key) {
			try {
				const tx = (await open()).transaction('recent');
				const row = asRow(await request(tx.objectStore('recent').get(key)));
				return row ? { ...entryOf(row), thumbnail: null } : null;
			} catch {
				return null;
			}
		},
		async model(key, sha256, conversion) {
			try {
				const tx = (await open()).transaction(['recent', 'models']);
				const [value, row] = await Promise.all([
					request(tx.objectStore('recent').get(key)),
					request<ModelRow | undefined>(tx.objectStore('models').get(`${sha256} ${conversion}`))
				]);
				const entry = asRow(value);
				if (!entry || !row || typeof row.measure !== 'string') return null;
				const companion = companionOf(row.with);
				return { model: keptOf(row), entry: { ...entryOf(entry), thumbnail: null }, ...(companion ? { with: companion } : {}) };
			} catch {
				return null;
			}
		},
		async file(sha256) {
			try {
				const tx = (await open()).transaction('files');
				const row = await request<FileRow | undefined>(tx.objectStore('files').get(sha256));
				return row?.bytes ?? null;
			} catch {
				return null;
			}
		}
	};
}
