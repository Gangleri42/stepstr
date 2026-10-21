import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fetchLocked } from './converter-fetch.mjs';

const wasm = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
const lock = { sha256: createHash('sha256').update(wasm).digest('hex'), size: wasm.length };

/** A fetch that answers each server by its host, and records what was asked. */
function servers(answers: Record<string, () => Response>) {
	const asked: string[] = [];
	const fetch = async (url: string | URL | Request) => {
		const address = new URL(String(url));
		asked.push(address.href);
		const answer = answers[address.host];
		if (!answer) throw new TypeError('fetch failed');
		return answer();
	};
	return { asked, fetch: fetch as typeof globalThis.fetch };
}

describe('fetchLocked', () => {
	it('asks each server for the sha256 in turn and takes the first that sends the locked bytes', async () => {
		const { asked, fetch } = servers({
			'a.example.com': () => new Response('not found', { status: 404 }),
			'b.example.com': () => new Response(new Uint8Array([...wasm.subarray(0, 7), 9])),
			'c.example.com': () => new Response(wasm),
			'd.example.com': () => new Response(wasm)
		});
		const warnings: string[] = [];
		const found = await fetchLocked(lock, ['https://a.example.com', 'https://b.example.com/', 'https://down.example.com', 'https://c.example.com', 'https://d.example.com'], {
			fetch,
			warn: (line) => warnings.push(line)
		});
		expect(found?.server).toBe('https://c.example.com');
		expect([...found!.bytes]).toEqual([...wasm]);
		expect(asked).toEqual(['a', 'b', 'down', 'c'].map((host) => `https://${host}.example.com/${lock.sha256}`));
		expect(warnings).toEqual(['a.example.com: 404', 'b.example.com sent other bytes', 'down.example.com: fetch failed']);
	});

	it('finds nothing where no server has it', async () => {
		const { fetch } = servers({});
		expect(await fetchLocked(lock, ['https://a.example.com', 'https://b.example.com'], { fetch, warn: () => {} })).toBeNull();
	});
});
