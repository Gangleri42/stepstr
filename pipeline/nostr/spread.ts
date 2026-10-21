// Spreading a publish's files over Blossom servers. Each server is asked first which file types it takes (BUD-06
// preflight, one probe per type: the largest file of it). Each file then goes to the site's own server, the first in
// the list, and from there to every other server that takes its type, which mirrors it (BUD-04) or else gets it
// uploaded. Last, every copy that no earlier publish verified, that was placed in this run or that a server reports at
// another size is downloaded and hashed. A server that refuses a type, or one file, goes without it and is reported;
// the run fails only when the site's own server lacks a file or a file reaches fewer public servers than asked for.
//
// Uploads are authorised by kind 24242 events. One covers a batch of files on every server, so a run signs a handful.
// A server that refuses it gets one signed just before each transfer from then on. In October 2026 nostr.download and
// nsite.run refused one signed more than about two minutes before the transfer, and cdn.klepak.net one it had seen.
import type { Event, EventTemplate } from 'nostr-tools/core';
import { blobUrl, extOf, head, mirror, preflight, upload, verify, type Result } from './blossom.ts';
import { KIND } from './config.ts';
import type { FileEntry } from './manifest.ts';

export type Authorise = {
	/** An authorisation that covers this file and the others of its batch, signed once for all of them. */
	batched(entry: FileEntry): Promise<Event>;
	/** One for this file alone, signed now. */
	fresh(entry: FileEntry): Promise<Event>;
};

export type SpreadOptions = {
	/** The servers, the site's own first. */
	servers: string[];
	entries: FileEntry[];
	/** "<server> <sha256>" for each copy an earlier publish downloaded and hashed. */
	verifiedBefore: Set<string>;
	/** Servers besides the site's own that every file must reach. */
	minPublic: number;
	/** A file's bytes, for an upload: the local file, or a copy from the site's own server for one carried over. */
	bytesOf(entry: FileEntry): Promise<Uint8Array | null>;
	auth: Authorise;
	log?(line: string): void;
};

export type Spread = {
	/** The servers that hold each file, by sha256, verified, in the order they were given. */
	holders: Map<string, string[]>;
	/** Files without a local copy (carried from an earlier deploy) that the site's own server no longer has. */
	lost: FileEntry[];
	/** The types each server refused. */
	refused: Map<string, string[]>;
};

const BATCH = 20;
const EXPIRY = 600;

/**
 * The authorisations a publish signs for `entries`. One covers a batch of 20 hashes on every server, so a run signs a
 * handful of tokens, not hundreds. The token is scoped by the file hashes and a short expiry only. BUD-11's optional
 * `server` tags are read differently by the servers out there (hzrd149's blossom-server wants the bare domain,
 * blssm.us and nsite.run reject anything but a URL), and a hash-scoped token replayed elsewhere can only place the
 * same public bytes. A batch's token is signed again a minute before it expires, and the servers of one file, served
 * at once, all wait for the same pending signature; a server that wants a token minted just before the transfer gets
 * one of its own each time (`fresh`).
 */
export function batchedAuth(entries: FileEntry[], sign: (template: EventTemplate) => Promise<Event>, content: string, now = () => Math.floor(Date.now() / 1000)): Authorise {
	const batches = new Map<string, FileEntry[]>();
	for (let i = 0; i < entries.length; i += BATCH) {
		const batch = entries.slice(i, i + BATCH);
		for (const entry of batch) batches.set(entry.sha256, batch);
	}
	const authorisation = (hashes: string[], lifetime = EXPIRY) => {
		const signed = now();
		return sign({ kind: KIND.blobAuth, created_at: signed, content, tags: [['t', 'upload'], ['expiration', String(signed + lifetime)], ...hashes.map((sha256) => ['x', sha256])] });
	};
	const pending = new Map<FileEntry[], { signed: number; auth: Promise<Event> }>();
	return {
		batched(entry) {
			const batch = batches.get(entry.sha256)!;
			const cached = pending.get(batch);
			if (cached && now() - cached.signed < EXPIRY - 60) return cached.auth;
			const signed = now();
			const auth = authorisation(batch.map((e) => e.sha256));
			pending.set(batch, { signed, auth });
			return auth;
		},
		fresh: (entry) => authorisation([entry.sha256], 300)
	};
}

/** Why a spread cannot give the site what it needs. */
export class SpreadError extends Error {}

const pair = (server: string, entry: { sha256: string }) => `${server} ${entry.sha256}`;
/**
 * An authorised call a server may have refused for its authorisation rather than the file. Some say so with a 400,
 * each in its own words: in October 2026 nostr.download answered "Created timestamp is out of range", cdn.klepak.net
 * "Auth event already used" and files.sovbit.host "Invalid base64 in Authorization header". A 400 can be about the
 * file too, so the fresh authorisation it earns costs one signature and marks the server only when it works.
 */
const unauthorised = (r: Result) => r.status === 400 || r.status === 401 || r.status === 403;

export async function spread(options: SpreadOptions): Promise<Spread> {
	const { servers, entries, minPublic, auth } = options;
	const log = options.log ?? (() => {});
	const own = servers[0];
	const strict = new Set<string>();

	/** An authorised call: with the batch's authorisation, and once more with a fresh one when the server refuses it. */
	async function authorised(server: string, entry: FileEntry, send: (auth: Event) => Promise<Result>): Promise<Result> {
		if (strict.has(server)) return send(await auth.fresh(entry));
		const first = await send(await auth.batched(entry));
		if (first.ok || !unauthorised(first)) return first;
		const again = await send(await auth.fresh(entry));
		if (again.ok && !strict.has(server)) {
			strict.add(server);
			log(`  ${server} refused the batch's authorisation; it gets one signed just before each transfer`);
		}
		return again;
	}

	// ---- which types each server takes
	const types = [...new Set(entries.map((e) => e.type))];
	const probes = types.map((type) => entries.filter((e) => e.type === type).sort((a, b) => b.bytes - a.bytes)[0]);
	const refused = new Map<string, string[]>();
	await Promise.all(
		servers.map(async (server) => {
			const refusals: string[] = [];
			let unknown = false;
			for (const probe of probes) {
				// A server that holds the probe takes its type. Asked anyway, some answer with a 400 (24242.io and
				// nostr.media: "already got that file", October 2026).
				if ((await head(server, probe.sha256)).status === 200) continue;
				const r = await authorised(server, probe, (event) => preflight(server, probe, event));
				if (r.ok) {
					unknown ||= r.reason === 'no preflight endpoint';
					continue;
				}
				refusals.push(`${probe.type} (${r.status} ${r.reason})`);
				refused.set(server, [...(refused.get(server) ?? []), probe.type]);
			}
			const state = refusals.length === probes.length ? 'skip' : refusals.length ? 'some' : 'ok  ';
			const said = refusals.length ? `: refuses ${refusals.join('; ')}` : unknown ? ' (no preflight endpoint; the upload decides)' : '';
			log(`  ${state} ${server}${said}`);
		})
	);
	const takes = (server: string, type: string) => !refused.get(server)?.includes(type);
	const ownRefuses = types.filter((type) => !takes(own, type));
	if (ownRefuses.length) throw new SpreadError(`${own}, the site's own server, refuses ${ownRefuses.join(', ')}; fix it before publishing`);
	for (const type of types) {
		const count = servers.slice(1).filter((server) => takes(server, type)).length;
		if (count < minPublic) throw new SpreadError(`only ${count} public servers take ${type}, ${minPublic} needed (--min-public to change)`);
	}

	// ---- each file to the site's own server, then to the others at once
	const recheck = new Set<string>();
	const placed = new Map<string, Set<string>>();
	const down = new Set<string>();
	const lost: FileEntry[] = [];
	const place = async (server: string, entry: FileEntry): Promise<Result> => {
		const found = await head(server, entry.sha256);
		if (found.status === 200) {
			if (entry.bytes && found.size !== null && found.size !== entry.bytes) recheck.add(pair(server, entry));
			return { ok: true, status: 200, reason: 'present' };
		}
		recheck.add(pair(server, entry));
		if (server !== own) {
			const mirrored = await authorised(server, entry, (event) => mirror(server, blobUrl(own, entry.sha256, extOf(entry.path)), event));
			if (mirrored.ok) return mirrored;
		}
		const bytes = await options.bytesOf(entry);
		if (!bytes) return { ok: false, status: 0, reason: "neither here nor on the site's own server" };
		return authorised(server, entry, (event) => upload(server, entry, bytes, event));
	};
	for (const entry of entries) {
		const mine = await place(own, entry);
		if (!mine.ok) {
			if (!entry.file) {
				lost.push(entry);
				continue;
			}
			throw new SpreadError(`${own} did not take ${entry.path}: ${mine.status} ${mine.reason}`);
		}
		const holding = new Set([own]);
		// The others mirror from the site's own server, so they come after it, all at once.
		const others = servers.slice(1).filter((server) => takes(server, entry.type) && !down.has(server));
		const results = await Promise.all(others.map((server) => place(server, entry)));
		results.forEach((r, i) => {
			if (r.ok) return void holding.add(others[i]);
			log(`  ${others[i]} did not take ${entry.path}: ${r.status} ${r.reason}`);
			// A server that does not answer at all is left alone for the rest of the run.
			if (r.status === 0) down.add(others[i]);
		});
		placed.set(entry.sha256, holding);
		log(`  ${entry.path} (${(entry.bytes / 1e3).toFixed(0)} kB) on ${holding.size} servers`);
	}

	// ---- every copy downloaded and hashed once, the servers at once
	const kept = entries.filter((entry) => !lost.includes(entry));
	await Promise.all(
		servers.map(async (server) => {
			const held = kept.filter((entry) => placed.get(entry.sha256)?.has(server));
			const unverified = held.filter((entry) => !options.verifiedBefore.has(pair(server, entry)) || recheck.has(pair(server, entry)));
			const bad: string[] = [];
			for (const entry of unverified) {
				const r = await verify(server, entry);
				if (r.ok) continue;
				bad.push(`${entry.path}: ${r.status} ${r.reason}`);
				placed.get(entry.sha256)!.delete(server);
			}
			if (!held.length) return;
			const counts = `${held.length - bad.length} files, ${unverified.length} downloaded, ${held.length - unverified.length} verified before`;
			log(`  ${bad.length ? 'FAIL' : 'ok  '} ${server}: ${counts}${bad.length ? `; ${bad.slice(0, 3).join('; ')}${bad.length > 3 ? '; …' : ''}` : ''}`);
		})
	);
	const missing = kept.filter((entry) => !placed.get(entry.sha256)?.has(own));
	if (missing.length) throw new SpreadError(`${own} does not serve ${missing.map((e) => e.path).join(', ')}, which it accepted`);
	const short = kept.filter((entry) => placed.get(entry.sha256)!.size - 1 < minPublic);
	if (short.length) {
		const listed = short.slice(0, 5).map((e) => `${e.path} (${placed.get(e.sha256)!.size - 1})`);
		throw new SpreadError(`${short.length} files reach fewer than ${minPublic} public servers: ${listed.join(', ')}${short.length > 5 ? ', …' : ''}`);
	}
	const holders = new Map(kept.map((entry) => [entry.sha256, servers.filter((server) => placed.get(entry.sha256)!.has(server))]));
	return { holders, lost, refused };
}

/** The servers, in order, that hold every one of these files. */
export const holdingAll = (spread: Spread, servers: string[], entries: { sha256: string }[]) =>
	servers.filter((server) => entries.every((entry) => spread.holders.get(entry.sha256)?.includes(server)));

/**
 * The servers a site manifest lists: those that hold every site file and every catalogue file of a type they take. The
 * next publish trusts each listed server's copies of the catalogue's files by their size, so a server whose copy failed
 * its check is left out; one that refuses a type holds none of it and is asked again.
 */
export const siteServers = (spread: Spread, servers: string[], site: { sha256: string }[], catalogue: { sha256: string; type: string }[]) =>
	holdingAll(spread, servers, site).filter((server) => holdingAll(spread, [server], catalogue.filter((entry) => !spread.refused.get(server)?.includes(entry.type))).length);
