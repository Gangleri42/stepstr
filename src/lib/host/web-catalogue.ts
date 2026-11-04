// The catalogue a web page starts with. The copy beside the page is as old as the page's last deploy. The site's newest
// signed manifest names the catalogue just published, so the page asks for that one and a new version shows without a
// deploy, as it does in a napplet, whose shell opens the newest signed event. The copy stays the answer when no relay
// answers in time, when no server has the newer one, and offline, where the service worker keeps it.
import { parseCatalogue, type Catalogue } from '$lib/catalogue/catalogue';
import { sha256Hex } from '$lib/source/sha256';
import { webTransport } from './web-transport';

/** Where a site's newest signed manifest is found. */
export type PublishedSite = { pubkey: string; id: string; relays: string[] };

/** A site's catalogue as the page got it, or why it has none. When it has none, the page opens files as any stepstr does, and the app says why. */
export type FetchedCatalogue = { catalogue: Catalogue; problem?: undefined } | { catalogue: null; problem: string };

const MANIFEST_WAIT = 1500;
const BLOB_WAIT = 3000;

const parsed = (bytes: Uint8Array) => parseCatalogue(JSON.parse(new TextDecoder().decode(bytes)));

/** The newest date among a catalogue's versions and revisions. */
function newestDate({ models }: Catalogue) {
	const entries = Object.values(models).flatMap((model) => [...model.versions, ...(model.companions?.revisions ?? [])]);
	return Math.max(...entries.map(({ date }) => Date.parse(date)));
}

async function copyBesidePage(url: string): Promise<{ fetched: FetchedCatalogue; sha256: string | null }> {
	let problem: string;
	try {
		const response = await fetch(url, { cache: 'no-cache' });
		if (response.ok) {
			const bytes = new Uint8Array(await response.arrayBuffer());
			return { fetched: { catalogue: parsed(bytes) }, sha256: sha256Hex(bytes) };
		}
		problem = `${response.status} ${response.statusText}`.trim();
	} catch (err) {
		problem = err instanceof Error ? err.message : String(err);
	}
	console.warn(`${url}: ${problem}`);
	return { fetched: { catalogue: null, problem }, sha256: null };
}

async function namedByNewestManifest(site: PublishedSite) {
	try {
		const { fetchSiteManifest } = await import('./web-nostr');
		const manifest = await fetchSiteManifest(site, MANIFEST_WAIT);
		if (!manifest) return null;
		const sha256 = manifest.tags.find((tag) => tag[0] === 'path' && tag[1] === '/catalogue.json')?.[2];
		return sha256 ? { sha256, servers: manifest.tags.filter((tag) => tag[0] === 'server').map((tag) => tag[1]) } : null;
	} catch (err) {
		console.warn(`no site manifest: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

/** Fetched before the app starts; `url` is the copy beside the page, `site` where the newest manifest is asked for. */
export async function fetchCatalogue(url: string, site: PublishedSite | null): Promise<FetchedCatalogue> {
	const [copy, newest] = await Promise.all([copyBesidePage(url), site ? namedByNewestManifest(site) : null]);
	if (!newest || newest.sha256 === copy.sha256) return copy.fetched;
	try {
		const { bytes } = await webTransport().blob(newest.sha256, newest.servers, undefined, AbortSignal.timeout(BLOB_WAIT));
		const catalogue = parsed(bytes);
		// A relay that missed the last publish names a catalogue older than a copy deployed since.
		const kept = copy.fetched.catalogue;
		return kept && newestDate(catalogue) < newestDate(kept) ? copy.fetched : { catalogue };
	} catch (err) {
		console.warn(`the newest catalogue ${newest.sha256}: ${err instanceof Error ? err.message : String(err)}`);
		return copy.fetched;
	}
}
