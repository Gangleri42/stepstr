import { afterEach, describe, expect, it, vi } from 'vitest';
import { webTransport } from './web-transport';

/** A response whose body arrives in these chunks, with these headers; `cors` makes it one from another origin. */
function respond(chunks: number[], headers: Record<string, string>, cors = false) {
	let at = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (at === chunks.length) controller.close();
			else controller.enqueue(new Uint8Array(chunks[at++]).fill(at));
		}
	});
	const response = new Response(body, { headers });
	if (cors) Object.defineProperty(response, 'type', { value: 'cors' });
	vi.stubGlobal('fetch', async () => response);
}

async function progress() {
	const seen: (number | null)[] = [];
	const bytes = await webTransport().url('https://files.example.com/part.step', (fraction) => seen.push(fraction));
	return { seen, size: bytes.length };
}

afterEach(() => vi.unstubAllGlobals());

describe('download progress', () => {
	it('follows the body against its length', async () => {
		respond([4, 4, 2], { 'content-length': '10', 'content-type': 'application/octet-stream' }, true);
		expect(await progress()).toEqual({ seen: [0.4, 0.8, 1], size: 10 });
	});

	it('has no fraction for a body sent compressed, whose length is the compressed size', async () => {
		respond([4, 4, 2], { 'content-length': '3', 'content-encoding': 'gzip' });
		expect(await progress()).toEqual({ seen: [null, null, null], size: 10 });
	});

	it('has none for text from another origin, which may have been compressed out of sight', async () => {
		// As raw.githubusercontent.com answers: gzip, which the browser hides from the page.
		respond([4, 4, 2], { 'content-length': '3', 'content-type': 'text/plain; charset=utf-8' }, true);
		expect(await progress()).toEqual({ seen: [null, null, null], size: 10 });
	});

	it('drops the fraction once the body runs past its length', async () => {
		respond([2, 4, 4], { 'content-length': '5' });
		expect(await progress()).toEqual({ seen: [0.4, null, null], size: 10 });
	});

	it('has none without a length', async () => {
		respond([4, 6], {});
		expect(await progress()).toEqual({ seen: [null, null], size: 10 });
	});
});
