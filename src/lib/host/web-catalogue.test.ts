import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureCatalogue } from '$lib/catalogue/fixture';
import { sha256Hex } from '$lib/source/sha256';
import { fetchCatalogue, type PublishedSite } from './web-catalogue';
import { fetchSiteManifest } from './web-nostr';

vi.mock('./web-nostr', () => ({ fetchSiteManifest: vi.fn() }));

const SITE: PublishedSite = { pubkey: 'a'.repeat(64), id: 'lamps', relays: ['wss://relay.example.com'] };
const BESIDE = 'https://lamps.example.com/catalogue.json';
const SERVER = 'https://blossom.example.com';

const bytesOf = (home: string) => new TextEncoder().encode(JSON.stringify({ ...fixtureCatalogue(), home }));
const homes = Object.keys(fixtureCatalogue().models);
const old = bytesOf(homes[0]);
const fresh = bytesOf(homes[1]);

const key = generateSecretKey();
const manifest = (tags: string[][]) => finalizeEvent({ kind: 35128, created_at: 1, content: '', tags }, key);
const manifestNaming = (sha256: string) => manifest([['d', SITE.id], ['path', '/catalogue.json', sha256], ['server', SERVER]]);

/** The network: these URLs answer with these bytes, anything else with a 404. */
function serve(files: Record<string, Uint8Array<ArrayBuffer>>) {
	const asked: string[] = [];
	vi.stubGlobal('fetch', async (url: string) => {
		asked.push(url);
		const body = files[url];
		return body ? new Response(body) : new Response('gone', { status: 404, statusText: 'Not Found' });
	});
	return asked;
}

beforeEach(() => {
	vi.mocked(fetchSiteManifest).mockReset();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe('the catalogue a web page starts with', () => {
	it('is the one the newest manifest names, from a server it lists, when the copy beside the page is older', async () => {
		vi.mocked(fetchSiteManifest).mockResolvedValue(manifestNaming(sha256Hex(fresh)));
		serve({ [BESIDE]: old, [`${SERVER}/${sha256Hex(fresh)}`]: fresh });
		expect((await fetchCatalogue(BESIDE, SITE)).catalogue?.home).toBe(homes[1]);
	});

	it('is the copy beside the page when the manifest names that one, with no server asked', async () => {
		vi.mocked(fetchSiteManifest).mockResolvedValue(manifestNaming(sha256Hex(old)));
		const asked = serve({ [BESIDE]: old });
		expect((await fetchCatalogue(BESIDE, SITE)).catalogue?.home).toBe(homes[0]);
		expect(asked).toEqual([BESIDE]);
	});

	it('is the copy when no relay offers a manifest, or the manifest names no catalogue', async () => {
		serve({ [BESIDE]: old });
		vi.mocked(fetchSiteManifest).mockResolvedValue(null);
		expect((await fetchCatalogue(BESIDE, SITE)).catalogue?.home).toBe(homes[0]);
		vi.mocked(fetchSiteManifest).mockResolvedValue(manifest([['server', SERVER]]));
		expect((await fetchCatalogue(BESIDE, SITE)).catalogue?.home).toBe(homes[0]);
	});

	it('is the copy when asking the relays fails', async () => {
		serve({ [BESIDE]: old });
		vi.mocked(fetchSiteManifest).mockRejectedValue(new Error('no relay module'));
		expect((await fetchCatalogue(BESIDE, SITE)).catalogue?.home).toBe(homes[0]);
	});

	it('is the copy when no server has the newer one or sends other bytes', async () => {
		vi.mocked(fetchSiteManifest).mockResolvedValue(manifestNaming(sha256Hex(fresh)));
		serve({ [BESIDE]: old });
		expect((await fetchCatalogue(BESIDE, SITE)).catalogue?.home).toBe(homes[0]);
		serve({ [BESIDE]: old, [`${SERVER}/${sha256Hex(fresh)}`]: old });
		expect((await fetchCatalogue(BESIDE, SITE)).catalogue?.home).toBe(homes[0]);
	});

	it('is the copy when a relay that missed the last publish names an older catalogue', async () => {
		const catalogue = fixtureCatalogue();
		for (const model of Object.values(catalogue.models)) {
			for (const version of model.versions) version.date = '2020-01-01T00:00:00Z';
			for (const revision of model.companions?.revisions ?? []) revision.date = '2020-01-01T00:00:00Z';
		}
		const stale = new TextEncoder().encode(JSON.stringify({ ...catalogue, home: homes[1] }));
		vi.mocked(fetchSiteManifest).mockResolvedValue(manifestNaming(sha256Hex(stale)));
		serve({ [BESIDE]: old, [`${SERVER}/${sha256Hex(stale)}`]: stale });
		expect((await fetchCatalogue(BESIDE, SITE)).catalogue?.home).toBe(homes[0]);
	});

	it('is the newest one when the copy is missing, and says why when both are', async () => {
		vi.mocked(fetchSiteManifest).mockResolvedValue(manifestNaming(sha256Hex(fresh)));
		serve({ [`${SERVER}/${sha256Hex(fresh)}`]: fresh });
		expect((await fetchCatalogue(BESIDE, SITE)).catalogue?.home).toBe(homes[1]);
		vi.mocked(fetchSiteManifest).mockResolvedValue(null);
		expect(await fetchCatalogue(BESIDE, SITE)).toEqual({ catalogue: null, problem: '404 Not Found' });
	});

	it('asks no relay for a site that names none', async () => {
		serve({ [BESIDE]: old });
		expect((await fetchCatalogue(BESIDE, null)).catalogue?.home).toBe(homes[0]);
		expect(fetchSiteManifest).not.toHaveBeenCalled();
	});
});
