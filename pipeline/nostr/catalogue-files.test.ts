// The files a catalogue names, as the publisher reads them from the directory the site's builder leaves them in.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureCatalogue } from '../../src/lib/catalogue/fixture.ts';
import { catalogueEntries } from './catalogue-files.ts';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

/** A catalogue with one model whose published files are real bytes, written to a directory unless left out. */
function site(leaveOut: string[] = []) {
	const dir = mkdtempSync(join(tmpdir(), 'catalogue-files-'));
	dirs.push(dir);
	const blob = (text: string) => {
		const bytes = new TextEncoder().encode(text);
		const sha256 = createHash('sha256').update(bytes).digest('hex');
		if (!leaveOut.includes(text)) writeFileSync(join(dir, sha256), bytes);
		return { sha256, size: bytes.length };
	};
	const catalogue = fixtureCatalogue();
	const { clock } = catalogue.models;
	catalogue.models = { clock };
	clock.versions[0].files = { glb: blob('glb'), measure: blob('measure') };
	const [latest, older] = clock.companions!.revisions;
	latest.files = { glb: blob('insert glb'), measure: blob('insert measure') };
	latest.step = blob('insert step');
	// A revision whose files did not change between commits names the same blobs.
	older.files = latest.files;
	older.step = latest.step;
	return { dir, catalogue };
}

describe("a catalogue's files", () => {
	it('are each published once, with a type a server can refuse', () => {
		const { dir, catalogue } = site();
		const entries = catalogueEntries(catalogue, dir);
		expect(entries.map((e) => [e.path, e.type])).toEqual([
			['/clock/ddddddd/model.glb', 'model/gltf-binary'],
			['/clock/ddddddd/measure.json.gz', 'application/gzip'],
			['/clock/companion/eeeeeee/model.glb', 'model/gltf-binary'],
			['/clock/companion/eeeeeee/measure.json.gz', 'application/gzip'],
			['/clock/companion/eeeeeee/step.zip', 'application/zip']
		]);
		expect(entries[0]).toMatchObject({ sha256: catalogue.models.clock.versions[0].files.glb.sha256, bytes: 3, file: join(dir, catalogue.models.clock.versions[0].files.glb.sha256) });
	});

	it('must all be there, as the catalogue describes them', () => {
		const { dir, catalogue } = site(['insert step']);
		catalogue.models.clock.versions[0].files.glb.size = 4;
		expect(() => catalogueEntries(catalogue, dir)).toThrow(/2 of the catalogue's files cannot be published: \/clock\/ddddddd\/model\.glb is 3 bytes, the catalogue says 4; \/clock\/companion\/eeeeeee\/step\.zip is missing/);
		expect(catalogueEntries(catalogue, dir, false)).toHaveLength(5);
	});
});
