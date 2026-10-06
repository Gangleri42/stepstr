// Recently viewed files: what the Open panel lists, and what a store keeps of each so it reopens quickly. A store lives
// on this device only. On the web it keeps the converted model too, and the bytes of files from this device; in a
// napplet the shell's storage holds the list alone.
import type { Converted } from '$lib/convert/types';

export type RecentEntry = {
	/** The source's key (sourceKey): sha256:<hex> for a file pinned to its bytes. */
	key: string;
	/** The route that reopens it, in the view it was left in. */
	route: string;
	name: string;
	/** sha256 of the file as fetched. */
	sha256: string;
	/** Bytes, as fetched. */
	size: number;
	parts: number;
	/** When it was last opened, ms since 1970. */
	viewedAt: number;
	/** It came from this device: no link fetches it again. */
	local: boolean;
	/** A small picture of the model, as a data: URL. */
	thumbnail: string | null;
	/** Set by a store's list: the model or the file is kept on this device, so the entry opens without a download. */
	kept?: boolean;
};

/** A converted file as kept: enough to show it again without the STEP file or the converter. */
export type KeptModel = Omit<Converted, 'ms'> & { download: string | null };

export interface RecentStore {
	/** Newest first. */
	list(): Promise<RecentEntry[]>;
	/**
	 * Records a file as viewed now. An entry without a picture keeps the one it had. With room for them, the store keeps
	 * the model the build's conversion `conversion` (ABOUT.conversion) made of it, and the bytes of a file from this
	 * device. Never fails: a store that cannot write records nothing.
	 */
	remember(entry: RecentEntry, kept?: { conversion: string; model: KeptModel; bytes?: Uint8Array }): Promise<void>;
	/** The view an entry reopens with. */
	update(key: string, route: string): Promise<void>;
	forget(key: string): Promise<void>;
	clear(): Promise<void>;
	/** The entry with this key as kept, without its picture; null when there is none or the store does not answer. */
	entry(key: string): Promise<RecentEntry | null>;
	/**
	 * The model this conversion made of the file with this key and sha256, with the file's entry (without its picture),
	 * read together; null when either is not kept.
	 */
	model?(key: string, sha256: string, conversion: string): Promise<{ model: KeptModel; entry: RecentEntry } | null>;
	/** The bytes of a file from this device, when kept. */
	file?(sha256: string): Promise<Uint8Array | null>;
}

/** Entries a list holds at most. */
export const RECENT_LIMIT = 12;

/** The entries of a stored list, each key once (the first), and none that is not an entry. */
export function asEntries(value: unknown): RecentEntry[] {
	if (!Array.isArray(value)) return [];
	const keys = new Set<string>();
	return value.map(asEntry).filter((e): e is RecentEntry => !!e && !keys.has(e.key) && !!keys.add(e.key));
}

/** The list with this entry first, each key once, at most `limit` long. */
export function withEntry(list: RecentEntry[], entry: RecentEntry, limit = RECENT_LIMIT): RecentEntry[] {
	return [entry, ...list.filter((e) => e.key !== entry.key)].slice(0, limit);
}

/** A stored entry as read back, or null when it is not one. A store's contents are not trusted. */
export function asEntry(value: unknown): RecentEntry | null {
	if (!value || typeof value !== 'object') return null;
	const e = value as Record<string, unknown>;
	const text = (v: unknown): v is string => typeof v === 'string';
	const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
	if (!text(e.key) || !text(e.route) || !text(e.name) || !count(e.size) || !count(e.parts) || !count(e.viewedAt)) return null;
	if (!text(e.sha256) || !/^[0-9a-f]{64}$/.test(e.sha256)) return null;
	const thumbnail = text(e.thumbnail) && e.thumbnail.startsWith('data:image/') ? e.thumbnail : null;
	return {
		key: e.key,
		route: e.route,
		name: e.name,
		sha256: e.sha256,
		size: e.size,
		parts: e.parts,
		viewedAt: e.viewedAt,
		local: e.local === true,
		thumbnail
	};
}
