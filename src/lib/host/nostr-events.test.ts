import * as nip19 from 'nostr-tools/nip19';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import { newest, serversOf, wanted } from './nostr-events';

const key = generateSecretKey();
const pubkey = getPublicKey(key);
const other = generateSecretKey();
const sign = (kind: number, created_at: number, tags: string[][] = [], secret = key) => finalizeEvent({ kind, created_at, tags, content: '' }, secret);

describe('what a pointer asks for', () => {
	it('reads note, nevent and naddr', () => {
		const id = 'a'.repeat(64);
		expect(wanted(nip19.noteEncode(id))).toEqual({ filter: { ids: [id] }, relays: [] });
		expect(wanted(nip19.neventEncode({ id, author: pubkey, kind: 1063, relays: ['wss://r.example'] }))).toEqual({
			filter: { ids: [id] },
			relays: ['wss://r.example'],
			author: pubkey
		});
		expect(wanted(nip19.naddrEncode({ kind: 30063, pubkey, identifier: 'part' }))).toEqual({ filter: { kinds: [30063], authors: [pubkey], '#d': ['part'] }, relays: [] });
		expect(wanted(nip19.npubEncode(pubkey))).toBeNull();
		expect(wanted('nevent1garbage')).toBeNull();
	});
});

describe('answers from relays', () => {
	const filter = { kinds: [30063], authors: [pubkey], '#d': ['part'] };

	it('takes the newest version of an addressable event', () => {
		const old = sign(30063, 100, [['d', 'part']]);
		const now = sign(30063, 200, [['d', 'part']]);
		expect(newest([old, now], filter)?.id).toBe(now.id);
		expect(newest([now, old], filter)?.id).toBe(now.id);
	});

	it('accepts only what was asked for, validly signed', () => {
		const right = sign(30063, 100, [['d', 'part']]);
		const forged = { ...sign(30063, 300, [['d', 'part']]), content: 'changed' };
		const otherAuthor = sign(30063, 300, [['d', 'part']], other);
		const otherKind = sign(1063, 300, [['d', 'part']]);
		const otherD = sign(30063, 300, [['d', 'another']]);
		expect(newest([forged, otherAuthor, otherKind, otherD, null, 'text', right], filter)?.id).toBe(right.id);
		expect(newest([otherAuthor], filter)).toBeNull();
		// An event by id must be that event.
		expect(newest([right], { ids: [otherD.id] })).toBeNull();
		expect(newest([right], { ids: [right.id] })?.id).toBe(right.id);
	});

	it('reads a server list', () => {
		const list = sign(10063, 1, [['server', 'https://a.example/'], ['server', 'http://plain.example'], ['server', 'https://b.example']]);
		expect(serversOf(newest([list], { kinds: [10063], authors: [pubkey] }))).toEqual(['https://a.example', 'https://b.example']);
		expect(serversOf(null)).toEqual([]);
	});
});
