// Events come from relays, or from a shell that asked relays on the napplet's behalf. An answer counts only when it is
// validly signed and is the event that was asked for: a relay (or a shell) may send any signed event it likes.
import * as nip19 from 'nostr-tools/nip19';
import { verifyEvent, type Event } from 'nostr-tools/pure';

export type EventFilter = { ids?: string[]; kinds?: number[]; authors?: string[]; '#d'?: string[] };

/**
 * What a NIP-19 pointer asks relays for, the relays it names and its author, both hints for finding it; null for
 * anything that names no event. An id names one event, so an nevent's author and kind are hints and not conditions.
 */
export function wanted(pointer: string): { filter: EventFilter; relays: string[]; author?: string } | null {
	let decoded: ReturnType<typeof nip19.decode>;
	try {
		decoded = nip19.decode(pointer);
	} catch {
		return null;
	}
	if (decoded.type === 'note') return { filter: { ids: [decoded.data] }, relays: [] };
	if (decoded.type === 'nevent') {
		const { id, relays = [], author } = decoded.data;
		return { filter: { ids: [id] }, relays, ...(author ? { author } : {}) };
	}
	if (decoded.type === 'naddr') {
		const { kind, pubkey, identifier, relays = [] } = decoded.data;
		return { filter: { kinds: [kind], authors: [pubkey], '#d': [identifier] }, relays };
	}
	return null;
}

function matches(event: Event, filter: EventFilter) {
	if (filter.ids && !filter.ids.includes(event.id)) return false;
	if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
	if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
	// An addressable event's identifier is its first d tag, the empty string without one.
	const d = filter['#d'];
	return !d || d.includes(event.tags.find((t) => t[0] === 'd')?.[1] ?? '');
}

function signed(event: Event) {
	// A fresh copy of the signed fields: nostr-tools remembers a verdict on the object itself, and an object that was
	// verified and then changed would keep it.
	const { id, pubkey, created_at, kind, tags, content, sig } = event;
	try {
		return verifyEvent({ id, pubkey, created_at, kind, tags, content, sig });
	} catch {
		return false;
	}
}

/**
 * The newest of the answers that is validly signed and matches the filter, or null. Replaceable and addressable events
 * have older versions on some relays than on others; on a tie the lower id wins (NIP-01).
 */
export function newest(answers: unknown[], filter: EventFilter): Event | null {
	let best: Event | null = null;
	for (const answer of answers) {
		if (!answer || typeof answer !== 'object') continue;
		const event = answer as Event;
		if (typeof event.id !== 'string' || !Array.isArray(event.tags) || !matches(event, filter) || !signed(event)) continue;
		if (!best || event.created_at > best.created_at || (event.created_at === best.created_at && event.id < best.id)) best = event;
	}
	return best;
}

/** The Blossom servers a kind 10063 list names, in its order. */
export function serversOf(list: Event | null): string[] {
	return (list?.tags ?? []).filter((t) => t[0] === 'server' && /^https:\/\//.test(t[1] ?? '')).map((t) => t[1].replace(/\/+$/, ''));
}
