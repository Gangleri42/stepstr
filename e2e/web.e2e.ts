// The web build, as the static site serves it.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { GOLDEN, SEED_URL, fixturePath, serveFixtures } from './support';

async function openLink(page: Page, link: string) {
	const field = page.getByRole('textbox', { name: 'Link to a STEP file' });
	await field.fill(link);
	await field.press('Enter');
}

/**
 * The routes of the web build's recent files, or null after dropping its kept models; null, and no database made, when
 * there is none yet.
 */
function inDatabase(page: Page, work: 'routes' | 'drop-models') {
	return page.evaluate(
		(work) =>
			new Promise<string[] | null>((resolve, reject) => {
				const open = indexedDB.open('stepstr');
				open.onupgradeneeded = () => open.transaction?.abort();
				open.onerror = () => resolve(null);
				open.onsuccess = () => {
					const db = open.result;
					const tx = db.transaction(work === 'routes' ? 'recent' : 'models', work === 'routes' ? 'readonly' : 'readwrite');
					const rows = work === 'routes' ? tx.objectStore('recent').getAll() : null;
					if (!rows) tx.objectStore('models').clear();
					tx.oncomplete = () => {
						db.close();
						resolve(rows ? rows.result.map((row: { route: string }) => row.route) : null);
					};
					tx.onerror = () => reject(tx.error);
				};
			}),
		work
	);
}

test.beforeEach(async ({ page }) => {
	await serveFixtures(page);
});

test('opens a link and gives the same model in every browser', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Open a STEP file' })).toBeVisible();
	await openLink(page, SEED_URL);
	// Every browser here has its JIT, so the conversion goes without the heads-up about running without one.
	await expect(page.locator('.loading')).toContainText(/Starting the converter|Reading|Building|Sizing|Meshing|Preparing part|Measuring/, { timeout: 60_000 });
	await expect(page.locator('.loading .note')).toHaveCount(0);
	await expect(page.locator('aside.panel')).toBeVisible({ timeout: 150_000 });
	await expect(page.locator('.loading')).toHaveCount(0);
	await expect(page.locator('html')).toHaveAttribute('data-glb', GOLDEN['seed-v15'].glb);
	await expect(page).toHaveTitle('Seed-v15.step · stepstr');
	// The route now names the file's bytes, so the link reopens exactly this. The app writes it a moment after a change.
	await expect(page).toHaveURL(/[?&]x=9380f4da945e7706ef03095d83102248196bef3add5bd0c72570ca124dcaa5f1/);

	await page.keyboard.press('i');
	await expect(page.locator('.measure-card')).toContainText('Click a face');
});

test('stops the download when cancelled', async ({ page }) => {
	const failed: string[] = [];
	page.on('requestfailed', (request) => request.url().startsWith('https://files.example/') && failed.push(request.url()));
	// A server that never answers.
	await page.route('https://files.example/**', () => {});
	await page.goto(`/#/u?src=${encodeURIComponent('https://files.example/large.step')}`);
	await expect(page.locator('.loading')).toContainText('Downloading');
	await page.locator('.loading').getByRole('button', { name: 'Cancel' }).click();
	await expect(page.locator('.loading')).toHaveCount(0);
	await expect(page.getByRole('heading', { name: 'Open a STEP file' })).toBeVisible();
	await expect.poll(() => failed.length).toBeGreaterThan(0);
});

test('names the converter build in About', async ({ page }) => {
	await page.goto('/');
	await page.locator('details.about summary').click();
	await expect(page.locator('details.about')).toContainText(/sha256 [0-9a-f]{64}/);
});

test('keeps what it opened, and reopens it as it was left, without a download or the converter', async ({ page }) => {
	let downloads = 0;
	const converter: string[] = [];
	page.on('request', (request) => {
		if (request.url() === SEED_URL) downloads++;
		if (/converter[^/]*\.wasm/.test(request.url())) converter.push(request.url());
	});
	await page.goto('/');
	await openLink(page, SEED_URL);
	await expect(page.locator('html')).toHaveAttribute('data-glb', GOLDEN['seed-v15'].glb, { timeout: 150_000 });
	expect(converter).toHaveLength(1);
	await page.getByRole('button', { name: 'Ortho', exact: true }).click();
	await expect.poll(() => inDatabase(page, 'routes')).toEqual([expect.stringContaining('ortho=1')]);
	await page.keyboard.press('o');
	const card = page.getByRole('button', { name: /^Seed-v15\.step/ });
	await expect(card.locator('img')).toBeVisible();

	// A new visit: the list is still there, and the file opens from the model this device kept, in the view it was left in.
	await page.goto('/');
	await page.evaluate(() => delete document.documentElement.dataset.glb);
	await page.getByRole('button', { name: /^Seed-v15\.step/ }).click();
	await expect(page.locator('html')).toHaveAttribute('data-glb', GOLDEN['seed-v15'].glb);
	await expect(page.getByRole('button', { name: 'Ortho', exact: true })).toHaveAttribute('aria-pressed', 'true');
	expect(downloads).toBe(1);
	expect(converter).toHaveLength(1);

	await page.keyboard.press('o');
	await page.getByRole('button', { name: 'Remove Seed-v15.step from this list' }).click();
	await expect(page.getByRole('heading', { name: 'Recently viewed' })).toHaveCount(0);
	await expect(page.getByRole('heading', { name: 'Open a STEP file' })).toBeFocused();
});

test('reopens a file from this device from the model it kept, or else from the file it kept', async ({ page }) => {
	await page.goto('/');
	await page.locator('input[type=file]').setInputFiles(fixturePath('seed-v15'));
	await expect(page.locator('html')).toHaveAttribute('data-glb', GOLDEN['seed-v15'].glb, { timeout: 150_000 });
	await page.keyboard.press('o');
	await expect(page.getByRole('button', { name: /^Seed-v15\.step/ }).locator('img')).toBeVisible();

	await page.goto('/');
	await page.getByRole('button', { name: /^Seed-v15\.step/ }).click();
	await expect(page.locator('html')).toHaveAttribute('data-glb', GOLDEN['seed-v15'].glb);

	// As a newer converter build would find it: no model, so the kept file is converted again.
	await inDatabase(page, 'drop-models');
	await page.goto('/');
	await page.getByRole('button', { name: /^Seed-v15\.step/ }).click();
	await expect(page.locator('html')).toHaveAttribute('data-glb', GOLDEN['seed-v15'].glb, { timeout: 150_000 });
	await expect(page.getByRole('alert')).toHaveCount(0);

	// Clear asks first.
	await page.keyboard.press('o');
	await page.getByRole('button', { name: 'Clear', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
	await page.getByRole('button', { name: 'Remove all', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Recently viewed' })).toHaveCount(0);
	await expect(page.getByRole('heading', { name: 'Open a STEP file' })).toBeFocused();
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Open a STEP file' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Recently viewed' })).toHaveCount(0);
});

test("turns the file's up axis, frames Iso around it and keeps it in the link", async ({ page }) => {
	await page.goto('/');
	await openLink(page, SEED_URL);
	await expect(page.locator('html')).toHaveAttribute('data-glb', GOLDEN['seed-v15'].glb, { timeout: 150_000 });
	/** The camera the link names: position, then target. */
	const camera = () =>
		page.evaluate(() => (new URLSearchParams(location.hash.split('?')[1] ?? '').get('cam') ?? '').split(';').map((part) => part.split(',').map(Number)));

	await page.getByRole('button', { name: 'Up Z' }).click();
	await expect(page).toHaveURL(/[?&]up=y(&|$)/);
	// Iso with Y up puts the camera above the model along Y.
	await expect.poll(async () => {
		const [position, target] = await camera();
		return position?.length === 3 && target?.length === 3 ? position[1] - target[1] : 0;
	}).toBeGreaterThan(0);

	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('data-glb', GOLDEN['seed-v15'].glb, { timeout: 150_000 });
	await expect(page.getByRole('button', { name: 'Up Y' })).toBeVisible();
	await page.keyboard.press('u');
	await expect(page).toHaveURL(/[?&]up=x(&|$)/);
});

test.describe('offline', () => {
	test.use({ serviceWorkers: 'allow' });

	test('opens a file from this device with no network, once the service worker has the build', async ({ page, context, browserName }) => {
		test.skip(browserName !== 'chromium', 'Playwright runs service workers fully only in Chromium');
		await page.goto('/');
		// The first visit installs the worker, which caches the build, converter included, before it activates.
		await page.evaluate(async () => {
			await navigator.serviceWorker.ready;
		});
		await context.setOffline(true);
		await page.reload();
		await expect(page.getByRole('heading', { name: 'Open a STEP file' })).toBeVisible();
		await page.locator('input[type=file]').setInputFiles(fixturePath('seed-v15'));
		await expect(page.locator('html')).toHaveAttribute('data-glb', GOLDEN['seed-v15'].glb, { timeout: 150_000 });
		await context.setOffline(false);
	});
});
