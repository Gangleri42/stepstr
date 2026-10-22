// Browser tests (e2e/*.e2e.ts) in Chromium, Firefox and WebKit: the web build as the static site serves it, the web
// build of a site with a catalogue (e2e/site), and the napplet of each in the local dev shell, each on a port of its
// own so no other project's server is taken for it. The test
// files come from `node scripts/fixtures.mjs` and are served in place of the network, so every browser converts the
// same bytes and must produce the same model.
//   npx playwright install chromium firefox webkit   once
//   npm run test:e2e
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: 'e2e',
	testMatch: '*.e2e.ts',
	timeout: 180_000,
	expect: { timeout: 10_000 },
	workers: 3,
	reporter: 'list',
	// Service workers stay off: page.route cannot see requests a worker answers. The offline test turns one on.
	use: { baseURL: 'http://127.0.0.1:4273', serviceWorkers: 'block' },
	projects: [
		{ name: 'chromium', use: { ...devices['Desktop Chrome'] } },
		{ name: 'firefox', use: { ...devices['Desktop Firefox'] } },
		{ name: 'webkit', use: { ...devices['Desktop Safari'] } }
	],
	webServer: [
		// First: SvelteKit builds every site through .svelte-kit/output, which stepstr's own preview below serves from. This
		// one serves its build directory, as a plain static site.
		{
			command: 'npm run build && npx vite preview e2e/site --outDir build --host 127.0.0.1 --port 4275 --strictPort',
			env: { STEPSTR_SITE: 'e2e/site' },
			url: 'http://127.0.0.1:4275/',
			reuseExistingServer: !process.env.CI,
			timeout: 300_000
		},
		{
			command: 'npm run build && npx vite preview --host 127.0.0.1 --port 4273 --strictPort',
			url: 'http://127.0.0.1:4273/',
			reuseExistingServer: !process.env.CI,
			timeout: 300_000
		},
		{
			command: 'npm run build:napplet && node scripts/dev-shell/serve.mjs',
			env: { PORT: '4281' },
			url: 'http://127.0.0.1:4281/',
			reuseExistingServer: !process.env.CI,
			timeout: 300_000
		},
		// The napplet of the site with a catalogue, which carries the catalogue: built with the files published for it
		// (e2e/published.ts, NAPPLET_SITE), which the dev shell serves.
		{
			command: 'npx tsx e2e/published.ts --napplet-site && npm run build:napplet && node scripts/dev-shell/serve.mjs',
			env: { STEPSTR_SITE: '.cache/e2e-published/napplet-site', PORT: '4282' },
			url: 'http://127.0.0.1:4282/',
			reuseExistingServer: !process.env.CI,
			timeout: 300_000
		}
	]
});
