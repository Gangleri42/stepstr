// What the browser tests share: the test files, served in place of the network at the URLs test/fixtures.json names,
// and the conversion each must give (test/golden.json).
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { MESH_RULE } from '../src/lib/convert/mesh-rule';
import { FIXTURES, fixture, goldenKey, type FixtureName } from '../test/fixtures';

/** The dev shell the tests start (playwright.config.ts). */
export const SHELL = 'http://127.0.0.1:4281/';

/** Where the Seed test file lives, pinned to a commit. */
export const SEED_URL = FIXTURES['seed-v15'].urls[0];

type Golden = { glb: string; warnings: string[] };
const golden = JSON.parse(readFileSync(new URL('../test/golden.json', import.meta.url), 'utf8')) as Record<string, Golden>;
/** What each test file must convert to, under the meshing rule the build uses. */
export const GOLDEN = Object.fromEntries((Object.keys(FIXTURES) as FixtureName[]).map((name) => [name, golden[goldenKey(name, MESH_RULE)]])) as Record<FixtureName, Golden>;

export const fixturePath = (name: FixtureName) => {
	const path = fixture(name);
	if (!path) throw new Error(`the test file ${name} is missing: run node scripts/fixtures.mjs`);
	return path;
};

/** Answers every request for a test file's URLs with the local copy, from any origin. */
export async function serveFixtures(page: Page) {
	for (const [name, { urls }] of Object.entries(FIXTURES)) {
		const body = readFileSync(fixturePath(name as FixtureName));
		for (const url of urls) {
			await page.route(url, (route) => route.fulfill({ body, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' } }));
		}
	}
}
