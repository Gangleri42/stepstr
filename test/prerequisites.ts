// Files the tests need but the repository does not hold: the converter build, the test files, the oracle's output and
// the napplet build. A test skips without them, so a plain `npm test` runs on any checkout. With STEPSTR_STRICT=1 a
// missing one fails the run instead, naming the file and the command that makes it, so a green strict run has tested
// everything. STEPSTR_SLOW stays a choice in both modes: without it the Hammer tests skip.
import { existsSync } from 'node:fs';

export type Prerequisite = { what: string; path: string; how: string };

export const STRICT = process.env.STEPSTR_STRICT === '1';
export const SLOW = Boolean(process.env.STEPSTR_SLOW);

// STEPSTR_WASM points the tests at another build, or at nothing, to see what a checkout without one does.
export const CONVERTER: Prerequisite = {
	what: 'the converter build',
	path: process.env.STEPSTR_WASM ?? 'converter/dist/converter.wasm',
	how: 'build it with `converter/build.sh`'
};

/**
 * Whether a test must skip for want of one of these files. Under STEPSTR_STRICT=1 a missing file throws instead, while
 * vitest collects the tests, which fails the test file with the message.
 */
export function lacking(...needed: Prerequisite[]): boolean {
	const absent = needed.filter((p) => !existsSync(p.path));
	if (absent.length && STRICT) {
		throw new Error(`STEPSTR_STRICT: ${absent.map((p) => `${p.what} (${p.path}) is missing; ${p.how}`).join('. ')}`);
	}
	return absent.length > 0;
}
