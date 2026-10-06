// The two long runs, each converting the Hammer, one after the other and in one browser: the cancel below is timed,
// and must not be timed against the other run's load.
import { expect, test } from '@playwright/test';
import { fixturePath, GOLDEN, SHELL, serveFixtures } from './support';

test.describe.configure({ mode: 'serial' });
test.skip(({ browserName }) => browserName !== 'chromium', 'the long runs go in one browser');

test.beforeEach(async ({ page }) => {
	await serveFixtures(page);
});

test('converts a large file from this device', async ({ page }) => {
	await page.goto('/');
	await page.setInputFiles('input[type=file]', fixturePath('hammer-v50'));
	await expect(page.locator('.loading')).toBeVisible();
	await expect(page.locator('aside.panel')).toBeVisible({ timeout: 170_000 });
	await expect(page.locator('.loading')).toHaveCount(0);
	await expect(page.locator('html')).toHaveAttribute('data-glb', GOLDEN['hammer-v50'].glb);
	await page.locator('details.notes summary').click();
	for (const warning of GOLDEN['hammer-v50'].warnings) await expect(page.locator('details.notes')).toContainText(warning);
});

test('stops a conversion in the middle when cancelled, where the converter can pause (JSPI)', async ({ page }) => {
	await page.goto(SHELL);
	const napplet = page.frameLocator('#frame');
	await expect(napplet.getByRole('heading', { name: 'Open a STEP file' })).toBeVisible({ timeout: 30_000 });
	// The shell hands over the bytes themselves, as a host that already holds the file would.
	await page.setInputFiles('#file', fixturePath('hammer-v50'));
	const loading = napplet.locator('.loading');
	await expect(loading).toContainText('Building the shapes', { timeout: 60_000 });
	// The page keeps getting turns: the bar moves while OpenCascade builds the shapes.
	const width = () => loading.locator('.bar div').evaluate((bar) => bar.style.width);
	const before = await width();
	await expect.poll(width, { timeout: 8_000 }).not.toBe(before);
	// A person's click is one input event; Playwright's own click would first make several round trips into the page.
	const box = (await loading.getByRole('button', { name: 'Cancel' }).boundingBox())!;
	const start = Date.now();
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
	await expect(loading).toHaveCount(0);
	// Without the pause the click waits for the whole call, about eleven seconds here. With it, for at most one stretch
	// of OpenCascade's shape healing that checks for no stop: up to 1.6 s here, so 5 s leaves room for a slower machine.
	expect(Date.now() - start).toBeLessThan(5_000);
	await expect(napplet.getByRole('heading', { name: 'Open a STEP file' })).toBeVisible();
});
