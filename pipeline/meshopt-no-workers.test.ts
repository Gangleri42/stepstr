import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MeshoptEncoder } from 'meshoptimizer/encoder';
import { describe, expect, it } from 'vitest';
import { withoutWorkers } from './meshopt-no-workers.ts';

const source = readFileSync(fileURLToPath(new URL('../node_modules/meshoptimizer/meshopt_decoder.mjs', import.meta.url)), 'utf8');

describe('withoutWorkers', () => {
	it('cuts every mention of workers from meshoptimizer\'s decoder', () => {
		expect(source).toMatch(/new Worker\(/);
		expect(withoutWorkers(source)).not.toMatch(/worker/i);
	});

	it('leaves a decoder that decodes', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'stepstr-meshopt-'));
		try {
			writeFileSync(join(dir, 'decoder.mjs'), withoutWorkers(source));
			const { MeshoptDecoder } = await import(/* @vite-ignore */ pathToFileURL(join(dir, 'decoder.mjs')).href);
			await MeshoptEncoder.ready;
			const vertices = new Uint8Array(Array.from({ length: 64 * 8 }, (_, i) => (i * 37) % 251));
			const encoded = MeshoptEncoder.encodeGltfBuffer(vertices, 64, 8, 'ATTRIBUTES');
			expect('useWorkers' in MeshoptDecoder).toBe(false);
			expect([...(await MeshoptDecoder.decodeGltfBufferAsync(64, 8, encoded, 'ATTRIBUTES'))]).toEqual([...vertices]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('stops the build when the decoder changed shape', () => {
		expect(() => withoutWorkers(source.replace('useWorkers: function (count)', 'useWorkers: function (n)'))).toThrow(/useWorkers found 0 times/);
		expect(() => withoutWorkers(`${source}\nnew Worker('x');`)).toThrow(/worker code is left/);
	});
});
