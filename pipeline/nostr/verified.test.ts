// What a publish counts as verified before: the manifests on the relays, the converter their napplet page names, the
// published catalogue's files, and the record a files-only run keeps beside the site.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureCatalogue, hash } from '../../src/lib/catalogue/fixture.ts';
import { KIND } from './config.ts';
import type { Spread } from './spread.ts';
import { readRecord, verifiedBefore, writeRecord } from './verified.ts';

const OWN = 'https://own.example.com';
const A = 'https://a.example.com';
const B = 'https://b.example.com';

const site = { kind: KIND.site, tags: [['d', 'lamps'], ['path', '/index.html', hash('page')], ['path', '/catalogue.json', hash('catalogue')], ['server', OWN], ['server', A]] };
const napplet = { kind: KIND.napplet, tags: [['d', 'lamps'], ['x', hash('napplet page')], ['server', OWN], ['server', B]] };
const catalogueBytes = new TextEncoder().encode(JSON.stringify(fixtureCatalogue()));
const lampGlb = fixtureCatalogue().models.lamp.versions[0].files.glb.sha256;
const insertStep = fixtureCatalogue().models.clock.companions!.revisions[0].step.sha256;

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});
function recordFile() {
	const dir = mkdtempSync(join(tmpdir(), 'verified-'));
	dirs.push(dir);
	return join(dir, '.cache/verified-copies.json');
}

describe('what a publish counts as verified before', () => {
	it("is each manifest's files on its servers, the converter on the napplet's and the catalogue's files on the site's", () => {
		const pairs = verifiedBefore({ manifests: [site, napplet], converter: { sha256: hash('converter'), napplet }, catalogue: { site, bytes: catalogueBytes } });
		expect(pairs).toContain(`${A} ${hash('page')}`);
		expect(pairs).toContain(`${B} ${hash('napplet page')}`);
		expect(pairs).not.toContain(`${B} ${hash('page')}`);
		expect(pairs).toContain(`${B} ${hash('converter')}`);
		expect(pairs).not.toContain(`${A} ${hash('converter')}`);
		for (const server of [OWN, A]) expect(pairs).toContain(`${server} ${lampGlb}`);
		expect(pairs).toContain(`${A} ${insertStep}`);
		expect(pairs).not.toContain(`${B} ${lampGlb}`);
	});

	it('adds the record of a files-only run, which no manifest lists yet', () => {
		const pairs = verifiedBefore({ manifests: [site], record: [`${B} ${lampGlb}`] });
		expect(pairs).toEqual(new Set([`${OWN} ${hash('page')}`, `${A} ${hash('page')}`, `${OWN} ${hash('catalogue')}`, `${A} ${hash('catalogue')}`, `${B} ${lampGlb}`]));
	});

	it('takes nothing from a catalogue that cannot be read, or from no manifest at all', () => {
		expect(verifiedBefore({ manifests: [], catalogue: { site, bytes: new TextEncoder().encode('{"version": 2}') } })).toEqual(new Set());
		expect(verifiedBefore({ manifests: [null, null], converter: null, catalogue: null })).toEqual(new Set());
	});
});

describe("a files-only run's record", () => {
	const spreadOf = (holders: [string, string[]][]): Spread => ({ holders: new Map(holders), lost: [], refused: new Map() });

	it('is empty when it is missing or cannot be read', () => {
		const file = recordFile();
		expect(readRecord(file)).toEqual([]);
		writeRecord(file, spreadOf([]), [], []);
		writeFileSync(file, 'not json');
		expect(readRecord(file)).toEqual([]);
		writeFileSync(file, JSON.stringify({ version: 1, copies: [[A, 'not a hash'], 'x', [B, lampGlb]] }));
		expect(readRecord(file)).toEqual([`${B} ${lampGlb}`]);
	});

	it("holds each copy a run verified, keeps other runs' copies, and drops one this run no longer holds", () => {
		const file = recordFile();
		writeRecord(file, spreadOf([[lampGlb, [OWN, A, B]], [insertStep, [OWN]]]), [OWN, A, B], [{ sha256: lampGlb }, { sha256: insertStep }]);
		expect(readRecord(file)).toHaveLength(4);
		// The next run asks OWN and A about the model only, and A's copy fails its check.
		writeRecord(file, spreadOf([[lampGlb, [OWN]]]), [OWN, A], [{ sha256: lampGlb }]);
		expect(readRecord(file).sort()).toEqual([`${OWN} ${lampGlb}`, `${B} ${lampGlb}`, `${OWN} ${insertStep}`].sort());
		expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1);
	});
});
