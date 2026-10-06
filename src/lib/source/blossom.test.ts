import { describe, expect, it } from 'vitest';
import { blobOfUrl, blobUrl, parseBlossomUri } from './blossom';
import { sha256Hex } from './sha256';

const sha = 'a'.repeat(64);

describe('blossom', () => {
	it('addresses a blob on a server', () => {
		expect(blobUrl('https://blossom.example.com/', sha, 'glb')).toBe(`https://blossom.example.com/${sha}.glb`);
		expect(blobUrl('https://blossom.example.com', sha)).toBe(`https://blossom.example.com/${sha}`);
	});

	it('parses a BUD-10 URI', () => {
		const uri = `blossom:${sha}.step?xs=https%3A%2F%2Fblossom.example.com&xs=blssm.us&as=${'b'.repeat(64)}&sz=2232812`;
		expect(parseBlossomUri(uri)).toEqual({ sha256: sha, ext: 'step', servers: ['https://blossom.example.com', 'https://blssm.us'], author: 'b'.repeat(64), size: 2232812 });
	});

	it('reads the canonical napplet form', () => {
		expect(parseBlossomUri(`blossom:sha256:${sha}`)).toEqual({ sha256: sha, ext: '', servers: [] });
	});

	it('tolerates bare hosts and missing parts', () => {
		expect(parseBlossomUri(`blossom:${sha.toUpperCase()}?xs=cdn.example/`)).toEqual({ sha256: sha, ext: '', servers: ['https://cdn.example'], author: undefined, size: undefined });
		expect(parseBlossomUri(`blossom:${sha}.zip?sz=-1&as=nope`)).toMatchObject({ size: undefined, author: undefined });
		expect(parseBlossomUri('blossom:nope')).toBeNull();
		expect(parseBlossomUri(`https://x/${sha}`)).toBeNull();
	});

	it('recognises a BUD-01 address', () => {
		expect(blobOfUrl(new URL(`https://cdn.example/${sha}.step`))).toEqual({ sha256: sha, ext: 'step', servers: ['https://cdn.example'] });
		expect(blobOfUrl(new URL(`https://cdn.example/files/${sha}`))).toMatchObject({ sha256: sha, servers: ['https://cdn.example'] });
		expect(blobOfUrl(new URL('https://cdn.example/model.step'))).toBeNull();
		expect(blobOfUrl(new URL(`http://cdn.example/${sha}`))).toBeNull();
	});

	it('hashes without WebCrypto', () => {
		expect(sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
	});
});
