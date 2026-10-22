// The link a napplet asks its shell for a blob by.
import { describe, expect, it } from 'vitest';
import { blossomLink } from './napplet-transport';

const hash = 'a'.repeat(64);

describe('blossomLink', () => {
	it('names the blob BUD-10 style, with the first four servers as hints', () => {
		const servers = ['https://blossom.primal.net', 'https://bls.example.com/', 'https://three.example.com', 'https://four.example.com:8443', 'https://five.example.com'];
		expect(blossomLink(hash, servers)).toBe(`blossom:${hash}?xs=blossom.primal.net&xs=bls.example.com&xs=three.example.com&xs=four.example.com%3A8443`);
	});

	it('drops repeats and anything but an https server, and names none when there are none', () => {
		expect(blossomLink(hash, ['https://a.example.com', 'https://a.example.com/', 'http://b.example.com', 'not a server'])).toBe(`blossom:${hash}?xs=a.example.com`);
		expect(blossomLink(hash, [])).toBe(`blossom:${hash}`);
	});
});
