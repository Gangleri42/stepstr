import { gzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { lfsMediaUrl, lfsPointer } from './github';
import { sniff, unwrapStep } from './sniff';

const utf8 = (text: string) => new TextEncoder().encode(text);
const STEP = utf8('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n');

describe('sniff', () => {
	it('recognises what it may be handed', () => {
		expect(sniff(STEP)).toBe('step');
		expect(sniff(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('\n\nISO-10303-21;')]))).toBe('step');
		expect(sniff(zipSync({ 'a.step': STEP }))).toBe('zip');
		expect(sniff(gzipSync(STEP))).toBe('gzip');
		expect(sniff(utf8('glTF\u0002\u0000'))).toBe('glb');
		expect(sniff(utf8('<?xml version="1.0"?><iso_10303_28 xmlns="urn:oid:1.0.10303.28.2.1.1">'))).toBe('step-xml');
		expect(sniff(utf8(`version https://git-lfs.github.com/spec/v1\noid sha256:${'c'.repeat(64)}\nsize 42\n`))).toBe('lfs');
		expect(sniff(utf8('solid cube'))).toBe('unknown');
	});

	it('takes the STEP out of a zip or gzip', () => {
		const zip = zipSync({ 'readme.txt': utf8('hello world, a longer file than the step'), 'cad/Part.STP': STEP });
		expect(unwrapStep(zip, 'download.zip')).toEqual({ bytes: STEP, name: 'Part.STP' });
		expect(unwrapStep(gzipSync(STEP), 'part.step.gz')).toEqual({ bytes: STEP, name: 'part.step' });
		expect(unwrapStep(STEP, 'part.step').bytes).toBe(STEP);
	});

	it('says why it cannot open something else', () => {
		expect(() => unwrapStep(utf8('solid cube'), 'cube.stl')).toThrow(/not a STEP file/);
		expect(() => unwrapStep(zipSync({}), 'empty.zip')).toThrow(/empty/);
	});
});

describe('Git LFS', () => {
	it('reads a pointer and finds its content', () => {
		const pointer = utf8(`version https://git-lfs.github.com/spec/v1\noid sha256:${'c'.repeat(64)}\nsize 42\n`);
		expect(lfsPointer(pointer)).toEqual({ oid: 'c'.repeat(64), size: 42 });
		expect(lfsPointer(STEP)).toBeNull();
		expect(lfsMediaUrl('https://raw.githubusercontent.com/o/r/main/a.step')).toBe('https://media.githubusercontent.com/media/o/r/main/a.step');
	});
});
