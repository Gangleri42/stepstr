// The Pages mirror runs from a checkout of pipeline/ alone (.github/workflows/pages.yml), so nothing it loads may live
// outside it.
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

/** The files a module loads by its relative imports, and theirs in turn; type-only imports load nothing. */
function loads(file: string, seen = new Set<string>()): Set<string> {
	if (seen.has(file)) return seen;
	seen.add(file);
	const text = readFileSync(file, 'utf8');
	for (const [statement, spec] of text.matchAll(/^(?:import|export)\b[^;]*?from\s+'(\.{1,2}\/[^']+)'/gm)) {
		if (!/^(?:import|export)\s+type\b/.test(statement)) loads(join(dirname(file), spec), seen);
	}
	for (const [, spec] of text.matchAll(/\bimport\(\s*'(\.{1,2}\/[^']+)'\s*\)/g)) loads(join(dirname(file), spec), seen);
	return seen;
}

describe('the Pages mirror', () => {
	it('loads nothing from outside pipeline/, which is all its checkout holds', () => {
		const outside = [...loads(join(root, 'pipeline/mirror-nostr.ts'))].map((file) => relative(root, file)).filter((file) => !file.startsWith('pipeline/'));
		expect(outside).toEqual([]);
	});
});
