// The web build of a site with a catalogue (e2e/site): two models, Lamp at two versions and a Twin of it, all with the
// Seed test file's bytes. As built, its catalogue names a conversion no viewer has, so only the first opens, by
// converting. The tests after that serve it with the files a site's builder publishes (e2e/published.ts) and a twin of
// the Lamp as the companion in its slot; the last opens the site's napplet, built with those files, in the dev shell.
import { expect, test, type Page } from '@playwright/test';
import { publishedCatalogue, publishedFile, publishedSite, REVISION_NOTE, TRACK_NOTE, TWIN, type PublishedSite } from './published';
import { CATALOGUE_SHELL, CATALOGUE_SITE, GOLDEN, SEED_URL, serveFixtures } from './support';

test.beforeEach(async ({ page }) => {
	await serveFixtures(page);
});

test('picks models and versions in the header, and the route follows', async ({ page }) => {
	await page.goto(CATALOGUE_SITE);
	const header = page.locator('header');
	const version = header.getByRole('combobox', { name: 'Version' });
	// The empty route opens the home model, and once it is on screen the route names its version.
	await expect(page.locator('html')).toHaveAttribute('data-glb', GOLDEN['seed-v15'].glb, { timeout: 150_000 });
	await expect(page).toHaveURL(/#\/lamp@aaaaaaa$/);
	await expect(header.getByRole('button', { name: 'Lamp' })).toHaveAttribute('aria-pressed', 'true');
	await expect(version).toHaveValue('aaaaaaa');
	await expect(version.locator('option')).toHaveText(['latest', 'aaaaaaa · 14 Oct', 'bbbbbbb · 7 Oct']);

	await version.selectOption('bbbbbbb');
	await expect(page).toHaveURL(/#\/lamp@bbbbbbb$/);
	await page.getByRole('button', { name: 'Ortho', exact: true }).click();
	await expect(page).toHaveURL(/#\/lamp@bbbbbbb\?ortho=1$/);

	await header.getByRole('button', { name: 'Twin' }).click();
	await expect(page).toHaveURL(/#\/twin@ccccccc\?ortho=1$/);
	await expect(header.getByRole('button', { name: 'Twin' })).toHaveAttribute('aria-pressed', 'true');
	await expect(header.getByRole('button', { name: 'Lamp' })).toHaveAttribute('aria-pressed', 'false');
	await expect(version).toHaveValue('ccccccc');

	// A link may spell the commit out; the picker follows the route.
	await page.evaluate(() => (location.hash = `#/lamp@bbbbbbb${'0'.repeat(33)}`));
	await expect(page).toHaveURL(/#\/lamp@bbbbbbb$/);
	await expect(version).toHaveValue('bbbbbbb');
	// A version the catalogue does not list, a number among them, opens the latest and says so.
	await page.evaluate(() => (location.hash = '#/lamp@14'));
	await expect(page).toHaveURL(/#\/lamp@aaaaaaa$/);
	await expect(page.locator('.toast')).toContainText('The catalogue lists no version 14 of Lamp, so the latest opened.');
	await expect(version).toHaveValue('aaaaaaa');
	await version.selectOption('latest');
	await expect(page).toHaveURL(/#\/lamp@aaaaaaa$/);
	await expect(page.getByRole('alert')).toHaveCount(0);
});

/**
 * Serves the test site with the published catalogue, and its Blossom server with the published files but those
 * `withheld` names. Gives the requests that went to the server, for the Lamp's STEP file and for the converter.
 */
async function serveSite(page: Page, site: PublishedSite, withheld: (sha256: string) => boolean = () => false) {
	const requests = { blossom: [] as string[], step: [] as string[], converter: [] as string[] };
	page.on('request', (request) => {
		const url = request.url();
		if (url.startsWith('https://blossom.example.com/')) requests.blossom.push(url);
		if (url === SEED_URL) requests.step.push(url);
		if (/converter[^/]*\.wasm/.test(url)) requests.converter.push(url);
	});
	await page.route(`${CATALOGUE_SITE}catalogue.json`, (route) => route.fulfill({ json: publishedCatalogue(site) }));
	await page.route('https://blossom.example.com/**', (route) => {
		const sha256 = new URL(route.request().url()).pathname.slice(1).split('.')[0];
		const body = withheld(sha256) ? null : publishedFile(site, sha256);
		const headers = { 'access-control-allow-origin': '*' };
		return body ? route.fulfill({ body, headers }) : route.fulfill({ status: 404, headers });
	});
	return requests;
}

/** How many models the web build keeps in IndexedDB, and how many of them with a companion. */
const keptModels = (page: Page) =>
	page.evaluate(
		() =>
			new Promise<{ models: number; companions: number }>((resolve) => {
				const open = indexedDB.open('stepstr');
				open.onerror = () => resolve({ models: 0, companions: 0 });
				open.onsuccess = () => {
					const rows = open.result.transaction('models').objectStore('models').getAll();
					rows.onsuccess = () => resolve({ models: rows.result.length, companions: rows.result.filter((row: { with?: unknown }) => row.with).length });
					rows.onerror = () => resolve({ models: 0, companions: 0 });
				};
			})
	);

test.describe('with published files', () => {
	let site: PublishedSite;
	test.beforeAll(async () => {
		site = await publishedSite();
	});

	test('opens the home model pinned, from its files, fits the companion and measures on it', async ({ page }) => {
		const requests = await serveSite(page, site);
		await page.goto(CATALOGUE_SITE);
		await expect(page.locator('html')).toHaveAttribute('data-companion', site.twin.glb.sha256, { timeout: 60_000 });
		await expect(page.locator('html')).toHaveAttribute('data-glb', site.lamp.glb.sha256);
		// An empty route shows the newest of everything; once on screen, the route names both.
		await expect(page).toHaveURL(/#\/lamp@aaaaaaa\?b=ddddddd$/);
		expect(requests.converter).toEqual([]);
		expect(requests.step).toEqual([]);
		// A face of one of the Lamp's parts, and the same face of the twin's.
		await page.evaluate((twin) => (location.hash = `#/lamp@aaaaaaa?b=ddddddd&m=b67pyd.f1,${twin}b67pyd.f1`), TWIN);
		await expect(page.locator('.measure-card')).toContainText('Distance');
		await expect(page.locator('.toast')).toHaveCount(0);

		// Share copies a link to this version, measured items and all, and one to whatever is latest when it is opened.
		await page.evaluate(() => {
			const copied: string[] = [];
			Object.assign(window, { copied });
			Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => void copied.push(text) } });
		});
		await page.getByRole('button', { name: 'Share' }).click();
		const links = page.getByRole('menuitem', { name: /^Copy link/ });
		await expect(links).toHaveCount(2);
		await links.first().click();
		await links.last().click();
		const copied = await page.evaluate(() => (window as unknown as { copied: string[] }).copied);
		expect(copied).toEqual([`${CATALOGUE_SITE}#/lamp@aaaaaaa?b=ddddddd&m=b67pyd.f1,${TWIN}b67pyd.f1`, `${CATALOGUE_SITE}#/lamp`]);
		await page.getByRole('button', { name: 'Share' }).click();

		// The parts panel names the revision in the slot, and the STEP menu offers both files.
		const insert = page.getByRole('combobox', { name: 'Insert' });
		await expect(insert).toHaveValue('ddddddd');
		await expect(insert.locator('option')).toHaveText(['As in CAD', 'ddddddd · 12 Oct · latest']);
		await expect(page.locator('aside.panel')).toContainText('Twin the lamp');
		// With the site's notes on the track and on the revision shown.
		const notes = page.getByRole('list', { name: 'Notes on the Insert' }).getByRole('listitem');
		await expect(notes).toHaveText([TRACK_NOTE, REVISION_NOTE]);
		await page.getByRole('button', { name: 'STEP' }).click();
		await expect(page.getByRole('menuitem')).toHaveText([/^Seed-v15\.step/, /^Insert ddddddd/]);
		await page.keyboard.press('Escape');
		await expect(page.getByRole('menuitem')).toHaveCount(0);

		// As in CAD: the slot shows the Lamp's own part, the twin's measured item goes, and the route says so.
		await insert.selectOption('cad');
		await expect(page).toHaveURL(/#\/lamp@aaaaaaa\?m=b67pyd\.f1$/);
		await expect(page.locator('html')).not.toHaveAttribute('data-companion');
		await expect(notes).toHaveText([TRACK_NOTE]);
		await expect(page.getByRole('button', { name: 'STEP' })).not.toHaveAttribute('aria-expanded');
		await expect(page.locator('.measure-card')).not.toContainText('Distance');
		await expect(page.locator('.toast')).toHaveCount(0);
		expect(requests.converter).toEqual([]);
	});

	test('opens a version from its files, and again from the model and companion kept, with no request', async ({ page }) => {
		const requests = await serveSite(page, site);
		await page.goto(`${CATALOGUE_SITE}#/lamp@bbbbbbb`);
		await expect(page.locator('html')).toHaveAttribute('data-glb', site.lamp.glb.sha256, { timeout: 60_000 });
		await expect(page.locator('aside.panel')).toContainText('The Insert does not line up with this version');
		await expect(page.getByRole('list', { name: 'Notes on the Insert' }).getByRole('listitem')).toHaveText([TRACK_NOTE]);
		await expect(page.locator('html')).not.toHaveAttribute('data-companion');

		// The model's button opens the newest of everything, its companion too; the version picker stays on pinned versions,
		// which show the slot as in CAD unless they name a revision.
		await page.locator('header').getByRole('button', { name: 'Lamp' }).click();
		await expect(page.locator('html')).toHaveAttribute('data-companion', site.twin.glb.sha256);
		await expect(page).toHaveURL(/#\/lamp@aaaaaaa\?b=ddddddd$/);
		await expect.poll(() => keptModels(page)).toEqual({ models: 1, companions: 1 });
		expect(requests.converter).toEqual([]);
		expect(requests.step).toEqual([]);

		const before = requests.blossom.length;
		await page.evaluate(() => delete document.documentElement.dataset.glb);
		await page.reload();
		await expect(page.locator('html')).toHaveAttribute('data-companion', site.twin.glb.sha256);
		await expect(page.locator('html')).toHaveAttribute('data-glb', site.lamp.glb.sha256);
		expect(requests.blossom).toHaveLength(before);
		expect(requests.converter).toEqual([]);
		expect(requests.step).toEqual([]);
	});

	test('converts the STEP file in the browser when its published files cannot be had', async ({ page }) => {
		const requests = await serveSite(page, site, () => true);
		await page.goto(`${CATALOGUE_SITE}#/lamp@bbbbbbb`);
		await expect(page.locator('.loading .note')).toContainText('The published model could not be fetched', { timeout: 60_000 });
		await expect(page.locator('html')).toHaveAttribute('data-glb', GOLDEN['seed-v15'].glb, { timeout: 150_000 });
		expect(requests.step).toHaveLength(1);
		expect(requests.converter).toHaveLength(1);
	});

	test("converts a companion's zipped STEP file when its files cannot be had, and shows the model as in CAD when it does not fit", async ({ page }) => {
		// The twin's STEP file is the Lamp's own, so its part ids, which no builder renamed, are the Lamp's.
		const requests = await serveSite(page, site, (sha256) => sha256 === site.twin.glb.sha256 || sha256 === site.twin.measure.sha256);
		await page.goto(`${CATALOGUE_SITE}#/lamp`);
		// Converted here, its parts would not have the ids its site published, and links to them may not match.
		await expect(page.locator('.loading .note')).toContainText("Its parts get the converter's own ids", { timeout: 60_000 });
		await expect(page.locator('.toast')).toContainText(/Insert ddddddd could not be fitted: \d+ of its part ids are the model's too\. This is Lamp as in CAD\./, {
			timeout: 150_000
		});
		await expect(page.locator('html')).toHaveAttribute('data-glb', site.lamp.glb.sha256);
		await expect(page.locator('html')).not.toHaveAttribute('data-companion');
		await expect(page).toHaveURL(/#\/lamp@aaaaaaa\?b=ddddddd$/);
		await expect(page.locator('aside.panel')).toContainText('ddddddd could not be fitted');
		expect(requests.blossom).toContainEqual(expect.stringContaining(site.twin.step.sha256));
		expect(requests.converter).toHaveLength(1);
		expect(requests.step).toEqual([]);
	});

	test("opens the home model in the napplet from its files, fitted, under Paja's limits", async ({ page }) => {
		await page.goto(CATALOGUE_SHELL);
		await expect(page.locator('#parity')).toBeChecked();
		const napplet = page.frameLocator('#frame');
		await expect(napplet.locator('html')).toHaveAttribute('data-companion', site.twin.glb.sha256, { timeout: 60_000 });
		await expect(napplet.locator('html')).toHaveAttribute('data-glb', site.lamp.glb.sha256);
		// Asked of the shell by their hashes, and nothing else: neither the converter nor a STEP file.
		const resources = await page.evaluate(() => window.seen.resources);
		expect(resources).toContain(`blossom:sha256:${site.lamp.glb.sha256}`);
		expect(resources.filter((url) => !site.files.some((sha256) => url === `blossom:sha256:${sha256}`))).toEqual([]);
	});
});
