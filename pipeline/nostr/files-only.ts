// A publish of a site's catalogue files alone: each file the catalogue names spread over the Blossom servers as a full
// publish spreads it (spread.ts: preflight, the site's own server first, mirrors or uploads, a fresh authorisation for
// a server that wants one, every new copy downloaded and hashed), and nothing more: no site files, no napplet, no relay
// or server lists, no manifests, no snapshots. The copies it verified go in the site's private record (verified.ts). A
// site's builder runs it to have the files on the servers before the catalogue that names them goes out.
import { readFileSync } from 'node:fs';
import type { Event, EventTemplate } from 'nostr-tools/core';
import { head } from './blossom.ts';
import type { FileEntry } from './manifest.ts';
import { batchedAuth, spread, type Spread } from './spread.ts';
import { writeRecord } from './verified.ts';

export type FilesOnlyOptions = {
	/** The servers, the site's own first. */
	servers: string[];
	entries: FileEntry[];
	minPublic: number;
	log(line: string): void;
} & (
	| { dryRun: true }
	| {
			dryRun?: false;
			/** "<server> <sha256>" for each copy an earlier publish downloaded and hashed (verified.ts). */
			verifiedBefore: Set<string>;
			/** The record of the copies verified, which this run adds its own to (verified.ts). */
			record: string;
			sign(template: EventTemplate): Promise<Event>;
			/** What the upload authorisations say they are for. */
			content: string;
	  }
);

/**
 * The files each server lacks, found by an unauthenticated HEAD, so a dry run signs and writes nothing. The servers are
 * asked at once and each about one file after another, as spread.ts asks them: a catalogue of hundreds of files on
 * twenty servers would otherwise open thousands of requests at once.
 */
export async function lacking(servers: string[], entries: FileEntry[]): Promise<Map<string, FileEntry[]>> {
	const missing = await Promise.all(
		servers.map(async (server) => {
			const lacks: FileEntry[] = [];
			for (const entry of entries) if ((await head(server, entry.sha256)).status !== 200) lacks.push(entry);
			return lacks;
		})
	);
	return new Map(servers.map((server, i) => [server, missing[i]]));
}

/** Spreads the files, or in a dry run says which servers lack which of them. Gives the spread, or null for a dry run. */
export async function uploadFiles(options: FilesOnlyOptions & { dryRun: true }): Promise<null>;
export async function uploadFiles(options: FilesOnlyOptions & { dryRun?: false }): Promise<Spread>;
export async function uploadFiles(options: FilesOnlyOptions): Promise<Spread | null> {
	const { servers, entries, minPublic, log } = options;
	if (options.dryRun) {
		log('dry run: presence on each server (unauthenticated HEAD); the types a server refuses show only in a real run');
		for (const [server, missing] of await lacking(servers, entries)) {
			const placing = missing.length ? `; would place ${missing.map((e) => e.path).join(', ')}` : '';
			log(`  ${server}: ${entries.length - missing.length}/${entries.length} files already there${placing}`);
		}
		return null;
	}
	const out = await spread({
		servers,
		entries,
		verifiedBefore: options.verifiedBefore,
		minPublic,
		bytesOf: async (entry) => (entry.file ? readFileSync(entry.file) : null),
		auth: batchedAuth(entries, options.sign, options.content),
		log
	});
	// No manifest lists these copies until the catalogue goes out, so the next run, files-only or full, finds them here.
	writeRecord(options.record, out, servers, entries);
	return out;
}
