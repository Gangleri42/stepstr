// What a site's builder publishes for the catalogue test site, made here as one makes it (pipeline/convert.ts) from the
// Seed test file: its own files, and a twin of it as a companion revision for one of its parts, with part ids of
// its own as a builder gives a companion's. Made once per conversion id into .cache/e2e-published, and served by the
// tests in place of the Blossom servers the catalogue names.
//   npx tsx e2e/published.ts                  makes them ahead of a test run
//   npx tsx e2e/published.ts --napplet-site   and the test site with them, for its napplet (the Playwright config)
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync, zipSync } from 'fflate';
import { about } from '../pipeline/about.ts';
import { compressGlb } from '../pipeline/compress.ts';
import { convert, publishable, WASM, type Pin } from '../pipeline/convert.ts';
import type { Catalogue } from '../src/lib/catalogue/catalogue.ts';
import { MemoryIO } from '../src/lib/pipeline/memory-io.ts';
import { fixture } from '../test/fixtures.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const CACHE = join(root, '.cache/e2e-published');
/** The test site with its published files, as its builder leaves it for the napplet build and the dev shell. */
export const NAPPLET_SITE = join(CACHE, 'napplet-site');

/** The part of the Seed test file that the twin takes the place of. */
export const SLOT = 'tpen9t';
/** What the twin's part ids start with: the test file's ids are six characters, so none of the twin's is one of them. */
export const TWIN = 't';

export type PublishedSite = {
	conversion: string;
	lamp: { glb: Pin; measure: Pin };
	twin: { glb: Pin; measure: Pin; step: Pin };
	/** The files by sha256, as names in the cache directory. */
	files: string[];
};

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const pin = (bytes: Uint8Array): Pin => ({ sha256: sha256(bytes), size: bytes.length });

/** The converter's GLB with every part id prefixed, as a companion's builder renames them. */
async function twinOf(glb: Uint8Array) {
	const io = new MemoryIO();
	const doc = await io.readBinary(glb);
	for (const node of doc.getRoot().listNodes()) {
		const extras = node.getExtras() as { id?: string };
		if (extras.id) node.setExtras({ ...extras, id: `${TWIN}${extras.id}` });
	}
	return compressGlb(await io.writeBinary(doc));
}

/** The published files of the test site, made unless they are there for this conversion. */
export async function publishedSite(): Promise<PublishedSite> {
	const { conversion } = about(WASM);
	if (!conversion) throw new Error(`${WASM} is missing: build or fetch the converter`);
	const dir = join(CACHE, conversion);
	const index = join(dir, 'site.json');
	if (existsSync(index)) return JSON.parse(readFileSync(index, 'utf8')) as PublishedSite;
	const path = fixture('seed-v15');
	if (!path) throw new Error('the Seed test file is missing: run npm run fixtures');
	const step = new Uint8Array(readFileSync(path));
	const converted = await convert(step, 'Seed-v15.step');
	const lamp = await publishable(step, converted);
	const twinGlb = await twinOf(converted.glb);
	const twinMeasure = gzipSync(new TextEncoder().encode(JSON.stringify({ ...converted.measure, glb: sha256(twinGlb) })), { level: 9, mtime: 0 });
	const twinStep = zipSync({ 'Twin.step': step }, { level: 1, mtime: '1980-01-01' });
	const files = [lamp.glb, lamp.measure, twinGlb, twinMeasure, twinStep];
	// Written whole, then moved in place: of two runs that make them at once, the first to finish puts its own there.
	const scratch = `${dir}.${process.pid}`;
	mkdirSync(scratch, { recursive: true });
	for (const bytes of files) writeFileSync(join(scratch, sha256(bytes)), bytes);
	const site: PublishedSite = {
		conversion,
		lamp: { glb: lamp.summary.glb, measure: lamp.summary.measure },
		twin: { glb: pin(twinGlb), measure: pin(twinMeasure), step: pin(twinStep) },
		files: files.map(sha256)
	};
	writeFileSync(join(scratch, 'site.json'), `${JSON.stringify(site, null, '\t')}\n`);
	mkdirSync(CACHE, { recursive: true });
	if (existsSync(dir)) rmSync(scratch, { recursive: true });
	else renameSync(scratch, dir);
	return site;
}

/** A published file's bytes by sha256, or null for one the site does not publish. */
export function publishedFile(site: PublishedSite, sha256: string): Buffer | null {
	const path = join(CACHE, site.conversion, sha256);
	return /^[0-9a-f]{64}$/.test(sha256) && existsSync(path) ? readFileSync(path) : null;
}

/** What the test site says about the companion track and about its revision. */
export const TRACK_NOTE = 'The newest twin is left out: it needs a deeper lamp.';
export const REVISION_NOTE = 'Its screws are not modelled.';

/** The test site's catalogue with the files published for it, the twin in the latest Lamp's slot. */
export function publishedCatalogue(site: PublishedSite) {
	const catalogue = JSON.parse(readFileSync(new URL('site/catalogue.json', import.meta.url), 'utf8')) as Catalogue;
	catalogue.conversion = site.conversion;
	for (const model of Object.values(catalogue.models)) for (const version of model.versions) version.files = site.lamp;
	const [latest, older] = catalogue.models.lamp.versions;
	latest.slot = { id: SLOT, fix: [0, 0, 40] };
	older.slot = null;
	const revision = { id: 'ddddddd', commit: 'ddddddd'.padEnd(40, '0'), date: '2026-10-12', subject: 'Twin the lamp', step: site.twin.step };
	catalogue.models.lamp.companions = {
		label: 'Insert',
		source: 'https://example.com/twin',
		latest: 'ddddddd',
		revisions: [{ ...revision, files: { glb: site.twin.glb, measure: site.twin.measure }, notes: [REVISION_NOTE] }],
		notes: [TRACK_NOTE]
	};
	return catalogue;
}

/**
 * The test site in NAPPLET_SITE, for the napplet, which carries its catalogue: the site's config, the published
 * catalogue, and the published files in catalogue-files by sha256, where the dev shell serves them as Blossom would.
 */
export async function nappletSite(): Promise<PublishedSite> {
	const site = await publishedSite();
	rmSync(NAPPLET_SITE, { recursive: true, force: true });
	mkdirSync(join(NAPPLET_SITE, '.nsite'), { recursive: true });
	mkdirSync(join(NAPPLET_SITE, 'catalogue-files'));
	copyFileSync(new URL('site/.nsite/config.json', import.meta.url), join(NAPPLET_SITE, '.nsite/config.json'));
	writeFileSync(join(NAPPLET_SITE, 'catalogue.json'), `${JSON.stringify(publishedCatalogue(site), null, '\t')}\n`);
	for (const sha256 of site.files) copyFileSync(join(CACHE, site.conversion, sha256), join(NAPPLET_SITE, 'catalogue-files', sha256));
	return site;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	if (process.argv.includes('--napplet-site')) {
		await nappletSite();
		console.log(`the test site with its published files in ${NAPPLET_SITE}`);
	} else {
		const site = await publishedSite();
		console.log(`published files for conversion ${site.conversion.slice(0, 12)} in ${join(CACHE, site.conversion)}`);
	}
}
