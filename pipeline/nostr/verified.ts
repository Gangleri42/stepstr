// What a publish counts as verified before: copies of a file that an earlier run downloaded and hashed, which it trusts
// again when a server still has them at their size (spread.ts). The relays hold most of that record, since each
// manifest lists the servers that hold every file it names, and the site manifest's servers also every catalogue file
// of a type they take. A files-only run publishes no manifest, so the copies it verified go in a file beside the site
// (SitePaths.verified), kept out of git and out of every publish.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseCatalogue } from '../../src/lib/catalogue/catalogue.ts';
import { catalogueEntries } from './catalogue-files.ts';
import { tagValues, verifiedPairs } from './manifest.ts';
import type { Spread } from './spread.ts';

type Manifest = { kind: number; tags: string[][] };

export type Earlier = {
	/** The site and napplet manifests on the relays: each server they list holds every file they name. */
	manifests: (Manifest | null)[];
	/** The converter the published napplet page names, which no manifest lists, verified with it on its servers. */
	converter?: { sha256: string; napplet: Manifest } | null;
	/** The catalogue the published site manifest lists, as its bytes: its files were verified on that manifest's servers. */
	catalogue?: { site: Manifest; bytes: Uint8Array } | null;
	/** The pairs of the record a files-only run keeps (readRecord). */
	record?: Iterable<string>;
};

/** "<server> <sha256>" for each copy an earlier publish downloaded and hashed. */
export function verifiedBefore({ manifests, converter, catalogue, record = [] }: Earlier): Set<string> {
	const pairs = verifiedPairs(manifests);
	if (converter) for (const server of tagValues(converter.napplet, 'server')) pairs.add(`${server} ${converter.sha256}`);
	if (catalogue) {
		try {
			const before = catalogueEntries(parseCatalogue(JSON.parse(new TextDecoder().decode(catalogue.bytes))), '', false);
			for (const server of tagValues(catalogue.site, 'server')) for (const entry of before) pairs.add(`${server} ${entry.sha256}`);
		} catch {
			// A catalogue that cannot be read lists nothing: every copy is downloaded again.
		}
	}
	for (const pair of record) pairs.add(pair);
	return pairs;
}

type VerifiedRecord = { version: 1; copies: [server: string, sha256: string][] };

/** The pairs in a files-only run's record; none when there is no record or it cannot be read. */
export function readRecord(file: string): string[] {
	if (!existsSync(file)) return [];
	try {
		const record = JSON.parse(readFileSync(file, 'utf8')) as VerifiedRecord;
		if (record.version !== 1 || !Array.isArray(record.copies)) return [];
		return record.copies.filter((c) => Array.isArray(c) && typeof c[0] === 'string' && /^[0-9a-f]{64}$/.test(c[1])).map(([server, sha256]) => `${server} ${sha256}`);
	} catch {
		return [];
	}
}

/**
 * Writes what a spread verified into the record: each copy it holds, and of the copies it was asked about on these
 * servers, none that it no longer holds, so a copy that failed its check is downloaded again next time.
 */
export function writeRecord(file: string, spread: Spread, servers: string[], entries: { sha256: string }[]) {
	const asked = new Set(servers.flatMap((server) => entries.map((entry) => `${server} ${entry.sha256}`)));
	const pairs = new Set(readRecord(file).filter((pair) => !asked.has(pair)));
	for (const [sha256, holders] of spread.holders) for (const server of holders) pairs.add(`${server} ${sha256}`);
	const copies = [...pairs].sort().map((pair) => pair.split(' ') as [string, string]);
	mkdirSync(dirname(file), { recursive: true });
	// Written whole and then moved, so a run that stops halfway leaves the old record.
	writeFileSync(`${file}.tmp`, `${JSON.stringify({ version: 1, copies } satisfies VerifiedRecord)}\n`);
	renameSync(`${file}.tmp`, file);
}
