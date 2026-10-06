import { describe, expect, it } from 'vitest';
import type { Transport } from '$lib/host/host';
import { TransportError } from '$lib/host/host';
import { explainLoadError } from '$lib/source/load';
import { converterFetcher } from './converter-source';

describe('the napplet converter', () => {
	it('says when the converter, not the file, could not be fetched', async () => {
		const failing: Transport = {
			blob: async () => {
				throw new TransportError('not-found', 'no Blossom server asked has this file');
			},
			url: async () => new Uint8Array()
		};
		const fetching = converterFetcher(failing, { sha256: 'a'.repeat(64), source: `blossom:sha256:${'a'.repeat(64)}` }, ['https://a.example']);
		const error = await fetching().catch((err) => err);
		expect(error).toMatchObject({ reason: 'not-found' });
		expect(explainLoadError(error).message).toBe('The converter could not be fetched: no Blossom server asked has this file.');
	});
});
