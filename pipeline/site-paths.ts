// Where a site's files are, and nothing more: the Pages mirror reads these from a checkout of pipeline/ alone
// (.github/workflows/pages.yml), so this module loads none of the app's code from src/, as site.ts does.
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SitePaths = {
	dir: string;
	/** The site's .nsite/config.json, as nostr/config.ts reads it. */
	config: string;
	/** Its models and their versions (src/lib/catalogue), where it has them. */
	catalogue: string;
	/** The files the catalogue names, each by its sha256, as the site's builder leaves them for the publisher. */
	catalogueFiles: string;
	/** The web build. */
	build: string;
	/** The napplet build: index.html, converter.txt and the manifest template. */
	napplet: string;
	/** The copies of the catalogue's files a files-only publish verified, which no manifest lists yet. Never published. */
	verified: string;
};

export const STEPSTR_DIR = fileURLToPath(new URL('..', import.meta.url));

/** A site's paths; a relative directory is taken from where the command runs. */
export function sitePaths(dir: string): SitePaths {
	const at = resolve(dir);
	return {
		dir: at,
		config: join(at, '.nsite/config.json'),
		catalogue: join(at, 'catalogue.json'),
		catalogueFiles: join(at, 'catalogue-files'),
		build: join(at, 'build'),
		napplet: join(at, 'dist-napplet'),
		verified: join(at, '.cache/verified-copies.json')
	};
}

export const SITE = sitePaths(process.env.STEPSTR_SITE || STEPSTR_DIR);
