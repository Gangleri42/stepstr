// The napplet in the local dev shell (scripts/dev-shell), with Paja's limits on: its CSP, its type sniffer, 10 MiB.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { GOLDEN, SHELL, fixturePath, serveFixtures } from './support';

declare global {
	interface Window {
		seen: { resources: string[]; jank: { maxGap: number; over50: number } };
	}
}

/** Whether the shell's storage holds, for the napplet, a value with this text in it. */
const stored = (page: Page, text: string) =>
	page.evaluate((text) => Object.keys(localStorage).some((key) => key.startsWith('napplet:stepstr:') && (localStorage.getItem(key) ?? '').includes(text)), text);

test.beforeEach(async ({ page }) => {
	await serveFixtures(page);
	await page.goto(SHELL);
	await expect(page.frameLocator('#frame').getByRole('heading', { name: 'Open a STEP file' })).toBeVisible({ timeout: 30_000 });
});

test('opens a file sent as an intent, with the converter fetched through the shell by its hash', async ({ page }) => {
	const napplet = page.frameLocator('#frame');
	await page.selectOption('#preset', { label: 'GitHub link, Seed (5 MB)' });
	await page.click('#deliver');
	await expect(napplet.locator('aside.panel')).toBeVisible({ timeout: 150_000 });
	await expect(napplet.locator('html')).toHaveAttribute('data-glb', GOLDEN['seed-v15'].glb);
	const resources = await page.evaluate(() => window.seen.resources);
	expect(resources.filter((url) => url.startsWith('blossom:'))).toHaveLength(1);
});

test('offers the file from this device when the shell will not fetch one that large', async ({ page }) => {
	const napplet = page.frameLocator('#frame');
	await page.selectOption('#preset', { label: 'GitHub link, Hammer (20 MB: too large under parity)' });
	await page.click('#deliver');
	await expect(napplet.getByRole('alert')).toContainText('only up to a limit', { timeout: 60_000 });
	await expect(napplet.getByRole('alert').getByRole('button', { name: 'Choose the file on this device' })).toBeVisible();
});

test('lists what it opened in the shell\'s storage, and opens it again from there', async ({ page }) => {
	const napplet = page.frameLocator('#frame');
	await page.selectOption('#preset', { label: 'GitHub link, Seed (5 MB)' });
	await page.click('#deliver');
	await expect(napplet.locator('html')).toHaveAttribute('data-glb', GOLDEN['seed-v15'].glb, { timeout: 150_000 });
	// The picture is taken once the model has settled; then the napplet starts over.
	await expect.poll(() => stored(page, 'data:image/')).toBe(true);
	await page.click('#reload');
	const card = napplet.getByRole('button', { name: /^Seed-v15\.step/ });
	await expect(card.locator('img')).toBeVisible({ timeout: 30_000 });
	await card.click();
	await expect(napplet.locator('html')).toHaveAttribute('data-glb', GOLDEN['seed-v15'].glb, { timeout: 150_000 });
});

test('asks again for a file from this device, which a napplet does not keep', async ({ page }) => {
	const napplet = page.frameLocator('#frame');
	await page.setInputFiles('#file', fixturePath('seed-v15'));
	await expect(napplet.locator('html')).toHaveAttribute('data-glb', GOLDEN['seed-v15'].glb, { timeout: 150_000 });
	await expect.poll(() => stored(page, 'Seed-v15.step')).toBe(true);
	await page.click('#reload');
	await napplet.getByRole('button', { name: /^Seed-v15\.step/ }).click();
	await expect(napplet.getByRole('alert')).toContainText('is not kept here');
	await expect(napplet.getByRole('alert').getByRole('button', { name: 'Choose the file on this device' })).toBeVisible();
});
