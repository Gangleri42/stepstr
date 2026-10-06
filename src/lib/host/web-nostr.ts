// Nostr reads for the web build: one event by pointer, and a user's Blossom server list (kind 10063). Loaded on first
// use, so a page that never opens a Nostr link never talks to a relay.
import { SimplePool } from 'nostr-tools/pool';
import type { Event } from 'nostr-tools/pure';
import { newest, serversOf, wanted, type EventFilter } from './nostr-events';

/** Relays to ask besides the ones a pointer names: large general relays and the server-list indexers. */
const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.nostr.band'];
const LIST_RELAYS = ['wss://purplepag.es', 'wss://user.kindpag.es', ...RELAYS];
const WAIT = 6000;

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
