// The Pages mirror's test for having nothing to deploy.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MANIFEST_STAMP, servesManifest } from './served.ts';

const URL = 'https://lamps.example.com';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('whether an address serves a manifest', () => {
	it('asks for the stamp beside the files and compares the event id', async () => {
		const asked: string[] = [];
		vi.stubGlobal('fetch', async (input: string) => (asked.push(input), new Response('abc123\n')));
		expect(await servesManifest(URL, 'abc123')).toBe(true);
		expect(await servesManifest(URL, 'def456')).toBe(false);
		expect(asked[0]).toBe(`${URL}/${MANIFEST_STAMP}`);
	});

	it('says no when the stamp is missing or the address does not answer, so the site is deployed', async () => {
		vi.stubGlobal('fetch', async () => new Response('Not found', { status: 404 }));
		expect(await servesManifest(URL, 'abc123')).toBe(false);
		vi.stubGlobal('fetch', async () => {
			throw new TypeError('fetch failed');
		});
		expect(await servesManifest(URL, 'abc123')).toBe(false);
	});
});
