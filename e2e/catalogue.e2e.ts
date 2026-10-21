// The web build of a site with a catalogue (e2e/site): two models, Lamp at two versions and a Twin of it, all with the
// Seed test file's bytes, so only the first opens by converting.
import { expect, test } from '@playwright/test';
import { CATALOGUE_SITE, GOLDEN, serveFixtures } from './support';

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
