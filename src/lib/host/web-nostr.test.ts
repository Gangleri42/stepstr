import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools/pure';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchSiteManifest } from './web-nostr';

type Params = { onevent(event: Event): void; oneose(): void; onclose(): void };
const subscription = vi.hoisted(() => ({ params: null as Params | null, close: () => {} }));

vi.mock('nostr-tools/pool', () => ({
	SimplePool: class {
		subscribeMany(_relays: string[], _filter: unknown, params: Params) {
			subscription.params = params;
			return { close: subscription.close };
		}
	}
}));

const key = generateSecretKey();
const SITE = { pubkey: getPublicKey(key), id: 'lamps', relays: ['wss://a.example.com', 'wss://b.example.com'] };
const manifest = (created_at: number, id = SITE.id, secret = key) => finalizeEvent({ kind: 35128, created_at, content: '', tags: [['d', id]] }, secret);
const params = () => subscription.params!;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("a site's newest manifest", () => {
	it('settles shortly after the first answer, with the newest of those in by then', async () => {
		const found = fetchSiteManifest(SITE, 1500);
		const older = manifest(100);
		const newer = manifest(200);
		await vi.advanceTimersByTimeAsync(100);
		params().onevent(older);
		await vi.advanceTimersByTimeAsync(100);
		params().onevent(newer);
		await vi.advanceTimersByTimeAsync(250);
		expect((await found)?.id).toBe(newer.id);
	});

	it('leaves out what another key signed or another site names', async () => {
		const found = fetchSiteManifest(SITE, 1500);
		params().onevent(manifest(300, SITE.id, generateSecretKey()));
		params().onevent(manifest(300, 'other'));
		await vi.advanceTimersByTimeAsync(250);
		expect(await found).toBeNull();
	});

	it('is null when the wait runs out, and at once when every relay has answered or closed', async () => {
		const silent = fetchSiteManifest(SITE, 1500);
		await vi.advanceTimersByTimeAsync(1500);
		expect(await silent).toBeNull();
		const answered = fetchSiteManifest(SITE, 1500);
		params().oneose();
		expect(await answered).toBeNull();
		const closed = fetchSiteManifest(SITE, 1500);
		params().onclose();
		expect(await closed).toBeNull();
	});

	it('closes the subscription once settled', async () => {
		const close = vi.fn();
		subscription.close = close;
		const found = fetchSiteManifest(SITE, 1500);
		params().oneose();
		await found;
		expect(close).toHaveBeenCalledOnce();
		subscription.close = () => {};
	});
});
