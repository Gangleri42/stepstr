import { describe, expect, it } from 'vitest';
import { stepFilesOf } from './nostr-files';

const A = 'a'.repeat(64);
const event = (kind: number, tags: string[][]) => ({ kind, pubkey: 'p'.repeat(64), tags, content: '' });

describe('files in Nostr events', () => {
	it('reads a NIP-94 file event', () => {
		const files = stepFilesOf(event(1063, [
			['url', `https://cdn.example/${A}.step`],
			['m', 'model/step'],
			['x', A],
			['size', '5053446'],
			['fallback', `https://mirror.example/${A}.step`],
			['server', 'https://listed.example/']
		]));
		expect(files).toEqual([{
			url: `https://cdn.example/${A}.step`,
			sha256: A,
			mime: 'model/step',
			name: `${A}.step`,
			size: 5053446,
			servers: ['https://cdn.example', 'https://mirror.example', 'https://listed.example']
		}]);
	});

	it('reads imeta tags and keeps only STEP files', () => {
		const files = stepFilesOf(event(1, [
			['imeta', 'url https://img.example/photo.jpg', 'm image/jpeg'],
			['imeta', 'url https://files.example/Bracket.stp', `x ${A}`],
			['imeta', 'url https://files.example/other', 'm model/step+zip']
		]));
		expect(files.map((f) => f.url)).toEqual(['https://files.example/Bracket.stp', 'https://files.example/other']);
		expect(files[0]).toMatchObject({ sha256: A, name: 'Bracket.stp', servers: [] });
	});

	it('ignores insecure and malformed entries', () => {
		expect(stepFilesOf(event(1063, [['url', 'http://cdn.example/a.step'], ['x', 'nope']]))).toEqual([]);
		expect(stepFilesOf(event(1063, [['url', 'https://cdn.example/a.txt'], ['m', 'text/plain']]))).toEqual([]);
	});
});
