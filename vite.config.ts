import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { aboutModule } from './pipeline/about.ts';

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

export default defineConfig({
	// The dev server hands the Worker the converter from converter/dist.
	server: { fs: { allow: ['converter'] } },
	plugins: [
		aboutModule(fileURLToPath(new URL('./converter/dist/converter.wasm', import.meta.url))),
		sveltekit({
			compilerOptions: {
				// Runes mode for the project's own components; libraries keep their own mode.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			// Single static page; all view state lives in the URL hash.
			adapter: adapter({ fallback: undefined }),
			// Served at the root of the nsite. Set BASE_PATH=/<dir> for a deploy under a sub-path.
			paths: { base: (process.env.BASE_PATH ?? '') as '' | `/${string}` },
			// The converter (converter/): its loader, and the wasm module the web build serves next to the page.
			alias: { $converter: 'converter' },
			version: { name: commit },
			// src/routes/+layout.svelte registers src/service-worker.ts in production builds only.
			serviceWorker: { register: false }
		})
	]
});
