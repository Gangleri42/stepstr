// The site a build is for. STEPSTR_SITE names its directory, stepstr's own by default: the builds and the publishing
// tools read that site's .nsite/config.json and write and read its outputs there, while the code, the packages and the
// tsconfig stay stepstr's, so every site converts with the same code and gets the same conversion id.
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { readConfig } from './nostr/config.ts';

export type SitePaths = {
	dir: string;
	/** The site's .nsite/config.json, as nostr/config.ts reads it. */
	config: string;
	/** The web build. */
	build: string;
	/** The napplet build: index.html, converter.txt and the manifest template. */
	napplet: string;
};

export const STEPSTR_DIR = fileURLToPath(new URL('..', import.meta.url));

/** A site's paths; a relative directory is taken from where the command runs. */
export function sitePaths(dir: string): SitePaths {
	const at = resolve(dir);
	return { dir: at, config: join(at, '.nsite/config.json'), build: join(at, 'build'), napplet: join(at, 'dist-napplet') };
}

export const SITE = sitePaths(process.env.STEPSTR_SITE || STEPSTR_DIR);

/** The site's config as the module virtual:stepstr-site, for the web page. */
export function siteModule(): Plugin {
	const id = 'virtual:stepstr-site';
	const resolved = `\0${id}`;
	return {
		name: 'stepstr-site',
		resolveId: (source) => (source === id ? resolved : undefined),
		load: (loading) => (loading === resolved ? `export default ${JSON.stringify(readConfig(SITE.config))};` : undefined)
	};
}
