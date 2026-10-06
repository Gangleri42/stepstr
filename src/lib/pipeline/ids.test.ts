import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { partId } from './ids.ts';

/** The pipeline's original, Node-only definition: links made with it must keep working. */
const nodePartId = (path: string) =>
	(createHash('sha256').update(path).digest().readUIntBE(0, 6) % 36 ** 6).toString(36).padStart(6, '0');

describe('part ids', () => {
	it.each(['frame:1', 'frame:1+side_plates:1', 'frame:1+side_plates:1/side_plates', '/Seed', 'Gehäuse:2+Schraube M3x8:14/Körper', ''])(
		'gives %j the same id as the Node pipeline',
		(path) => {
			expect(partId(path)).toBe(nodePartId(path));
			expect(partId(path)).toMatch(/^[0-9a-z]{6}$/);
		}
	);
});
