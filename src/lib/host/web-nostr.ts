// Nostr reads for the web build: one event by pointer, a user's Blossom server list (kind 10063) and a site's newest
// manifest. Loaded on first use, so a page without a catalogue that never opens a Nostr link never talks to a relay.
import { SimplePool } from 'nostr-tools/pool';
import type { Event } from 'nostr-tools/pure';
import { newest, serversOf, wanted, type EventFilter } from './nostr-events';
import type { PublishedSite } from './web-catalogue';

/** Relays to ask besides the ones a pointer names: large general relays and the server-list indexers. */
const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.nostr.band'];
const LIST_RELAYS = ['wss://purplepag.es', 'wss://user.kindpag.es', ...RELAYS];
const WAIT = 6000;
const SITE_MANIFEST = 35128;
/** How long the other relays get once one has offered a manifest: the page waits on this to start. */
const MANIFEST_GRACE = 250;

const pool = new SimplePool();

async function ask(relays: string[], filter: EventFilter): Promise<Event | null> {
	const unique = [...new Set(relays)];
	// An id names one event, so the first answer is the answer. Anything else can have newer versions on some relays
	// than on others, so every relay is asked.
	const answers = filter.ids ? [await pool.get(unique, filter, { maxWait: WAIT })] : await pool.querySync(unique, filter, { maxWait: WAIT });
	return newest(answers, filter);
}

export async function fetchEvent(pointer: string): Promise<Event | null> {
	const want = wanted(pointer);
	return want ? ask([...want.relays, ...RELAYS], want.filter) : null;
}

export async function fetchServerList(pubkey: string): Promise<string[]> {
	return serversOf(await ask(LIST_RELAYS, { kinds: [10063], authors: [pubkey] }));
}

/**
 * The newest signed manifest of a site the relays offer within `wait` ms: shortly after the first answer, at once when
 * every relay has answered or none can be reached, and null when none has it.
 */
export function fetchSiteManifest(site: PublishedSite, wait: number): Promise<Event | null> {
	const filter = { kinds: [SITE_MANIFEST], authors: [site.pubkey], '#d': [site.id] };
	return new Promise((resolve) => {
		const answers: Event[] = [];
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(newest(answers, filter));
			subscription.close();
		};
		let timer = setTimeout(finish, wait);
		const subscription = pool.subscribeMany(site.relays, filter, {
			onevent(event) {
				answers.push(event);
				if (answers.length > 1) return;
				clearTimeout(timer);
				timer = setTimeout(finish, MANIFEST_GRACE);
			},
			oneose: finish,
			onclose: finish
		});
	});
}
