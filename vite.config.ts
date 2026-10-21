import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { aboutModule } from './pipeline/about.ts';
import { readConfig } from './pipeline/nostr/config.ts';
import { catalogueFile, escapeAttribute, SITE, siteModule } from './pipeline/site.ts';

// SvelteKit stamps the build into _app/version.json; the last commit that touched the app, instead of the clock,
// keeps two builds of the same source byte-identical, which is how the Nostr publisher knows nothing changed.
// Commits to the pipeline, the deploy scripts or the docs leave the stamp alone.
const commit = (() => {
	try {
		return execFileSync('git', ['log', '-1', '--format=%h', '--', 'src', 'static', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json'], { encoding: 'utf8' }).trim() || 'dev';
	} catch {
		return 'dev';
	}
})();

// The site's description for src/app.html, which SvelteKit fills in from the public environment as it is: escaped here.
process.env.PUBLIC_SITE_DESCRIPTION = escapeAttribute(readConfig(SITE.config).description);

// Served at the root of the nsite. Set BASE_PATH=/<dir> for a deploy under a sub-path.
const base = (process.env.BASE_PATH ?? '') as '' | `/${string}`;

export default defineConfig({
	// The dev server hands the Worker the converter from converter/dist.
	server: { fs: { allow: ['converter'] } },
	plugins: [
		siteModule(),
		catalogueFile(base),
		aboutModule(fileURLToPath(new URL('./converter/dist/converter.wasm', import.meta.url))),
		sveltekit({
			compilerOptions: {
				// Runes mode for the project's own components; libraries keep their own mode.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// Single static page; all view state lives in the URL hash. Written into the site's directory (pipeline/site.ts).
			adapter: adapter({ pages: SITE.build, assets: SITE.build, fallback: undefined }),
			paths: { base },
			// The converter (converter/): its loader, and the wasm module the web build serves next to the page.
			alias: { $converter: 'converter' },
			version: { name: commit },
			// src/routes/+layout.svelte registers src/service-worker.ts in production builds only.
			serviceWorker: { register: false }
		})
	]
});
