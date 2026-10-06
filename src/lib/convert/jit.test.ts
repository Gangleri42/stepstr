import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { measureJit } from './jit';

/** A clock that moves `step` ms each time it is read. */
const clock = (step: number) => {
	let t = 0;
	return () => (t += step);
};

describe('telling whether the browser has a JIT', () => {
	// Node's interpreter runs the loop in about 60 ms on a fast laptop, half the time Chromium's takes, so the Node runs
	// below read a clock that goes twice as fast, as a browser's interpreter would look.
	const doubled = () => performance.now() * 2;

	it('finds the JIT this Node runs with', () => {
		expect(measureJit()).toBe(false);
		expect(measureJit(doubled)).toBe(false);
	});

	it('finds none in Node run without one', () => {
		// Node strips TypeScript with WebAssembly, which --jitless turns off, so the child gets the module as JavaScript.
		const source = readFileSync(new URL('./jit.ts', import.meta.url), 'utf8');
		const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
		const run = `${js}\nconsole.log(JSON.stringify(measureJit(${doubled.toString()})));`;
		const out = execFileSync(process.execPath, ['--jitless', '--input-type=module', '-e', run], { encoding: 'utf8' });
		expect(JSON.parse(out)).toBe(true);
	});

	it('calls a loop slow by the clock, as an interpreter would run it', () => {
		expect(measureJit(clock(2))).toBe(true);
	});

	it('cannot tell on a clock coarsened for privacy', () => {
		expect(measureJit(clock(100))).toBeNull();
		expect(measureJit(clock(16.7))).toBeNull();
	});

	it('takes a coarse clock that never moved for a fast loop', () => {
		expect(measureJit(() => 0)).toBe(false);
	});
});
