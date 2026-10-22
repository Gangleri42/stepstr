// The site a build is for. STEPSTR_SITE names its directory, stepstr's own by default: the builds and the publishing
// tools read that site's .nsite/config.json and write and read its outputs there, while the code, the packages and the
// tsconfig stay stepstr's, so every site converts with the same code and gets the same conversion id.
import { existsSync, readFileSync } from 'node:fs';
import type { Plugin } from 'vite';
import { parseCatalogue, type Catalogue } from '../src/lib/catalogue/catalogue.ts';
import { nappletRole } from '../src/lib/state/archetype.ts';
import { readConfig } from './nostr/config.ts';
import { SITE } from './site-paths.ts';

// The paths alone live in site-paths.ts, which the Pages mirror loads without src/.
export { SITE, sitePaths, STEPSTR_DIR, type SitePaths } from './site-paths.ts';

/** The site's catalogue.json as written and as checked, or null for a site without one. One that fails the check stops the build. */
export function readCatalogue(path = SITE.catalogue): { text: string; catalogue: Catalogue } | null {
	if (!existsSync(path)) return null;
	const text = readFileSync(path, 'utf8');
	try {
		return { text, catalogue: parseCatalogue(JSON.parse(text)) };
	} catch (err) {
		throw new Error(`${path}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

export const escapeAttribute = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The module virtual:stepstr-site, which both builds generate: what the site is called, how it describes itself, its
 * Blossom servers, the napplet's role and its catalogue. The napplet carries the catalogue. The web page imports only
 * whether there is one and fetches catalogue.json (catalogueFile) as it starts: its code then stays the same from one
 * catalogue to the next, and the service worker can serve the code from its cache and the catalogue fresh.
 */
export function siteModule(): Plugin {
	const id = 'virtual:stepstr-site';
	const resolved = `\0${id}`;
	const exported = () => {
		const { title, description, servers, napplet } = readConfig(SITE.config);
		const catalogue = readCatalogue()?.catalogue ?? null;
		return Object.entries({ title, description, servers, role: nappletRole(napplet), catalogue, hasCatalogue: !!catalogue })
			.map(([name, value]) => `export const ${name} = ${JSON.stringify(value)};`)
			.join('\n');
	};
	return {
		name: 'stepstr-site',
		resolveId: (source) => (source === id ? resolved : undefined),
		load: (loading) => (loading === resolved ? exported() : undefined)
	};
}

/** The site's catalogue.json beside the web page: written into the build, and served by the dev server at `base`. */
export function catalogueFile(base: string): Plugin {
	return {
		name: 'stepstr-catalogue',
		configureServer(server) {
			server.middlewares.use(`${base}/catalogue.json`, (_req, res, next) => {
				const read = readCatalogue();
				if (!read) return next();
				res.setHeader('content-type', 'application/json');
				res.end(read.text);
			});
		},
		generateBundle() {
			// SvelteKit builds the server and then the page; the file belongs with the page.
			const read = this.environment.name === 'client' ? readCatalogue() : null;
			if (read) this.emitFile({ type: 'asset', fileName: 'catalogue.json', source: read.text });
		}
	};
}
