// Another site's builds: its own config in, its own outputs out, and stepstr's left as they were. Both builds run, a
// few seconds each.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CONVERTER, lacking } from '../test/prerequisites.ts';
import { NAPPLET_TEMPLATE } from './nostr/manifest.ts';
import { sitePaths, STEPSTR_DIR } from './site.ts';

describe('sitePaths', () => {
	it('puts the config and both builds in the site directory, a relative one taken from the working directory', () => {
		expect(sitePaths('/srv/site')).toEqual({
			dir: '/srv/site',
			config: '/srv/site/.nsite/config.json',
			build: '/srv/site/build',
			napplet: '/srv/site/dist-napplet'
		});
		expect(sitePaths('..').dir).toBe(join(process.cwd(), '..'));
	});
});

/** Every file under a directory with its sha256, or null where there is no directory. */
function tree(dir: string): Record<string, string> | null {
	if (!existsSync(dir)) return null;
	const files: Record<string, string> = {};
	const walk = (path: string) => {
		for (const name of readdirSync(path)) {
			const file = join(path, name);
			if (statSync(file).isDirectory()) walk(file);
			else files[file.slice(dir.length)] = createHash('sha256').update(readFileSync(file)).digest('hex');
		}
	};
	walk(dir);
	return files;
}

describe.skipIf(lacking(CONVERTER))('a build for another site', () => {
	const dir = mkdtempSync(join(tmpdir(), 'stepstr-site-'));
	const site = sitePaths(dir);
	const own = sitePaths(STEPSTR_DIR);
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it('reads its config and writes its outputs, leaving stepstr\'s alone', () => {
		const stepstr = JSON.parse(readFileSync(own.config, 'utf8'));
		mkdirSync(join(dir, '.nsite'));
		writeFileSync(
			site.config,
			JSON.stringify({
				id: 'other',
				title: 'Other',
				description: 'Another site.',
				pubkey: stepstr.pubkey,
				relays: ['wss://relay.example.com'],
				servers: ['https://blossom.example.com']
			})
		);
		const before = [tree(own.build), tree(own.napplet)];
		const env = { ...process.env, STEPSTR_SITE: dir };
		for (const script of ['build', 'build:napplet']) execFileSync('npm', ['run', script], { cwd: STEPSTR_DIR, env, stdio: 'pipe' });
		expect([tree(own.build), tree(own.napplet)]).toEqual(before);

		const scripts = readdirSync(join(site.build, '_app/immutable/nodes')).map((name) => readFileSync(join(site.build, '_app/immutable/nodes', name), 'utf8')).join('\n');
		expect(scripts).toContain('https://blossom.example.com');
		expect(scripts).not.toContain(stepstr.servers[1]);

		const page = readFileSync(join(site.napplet, 'index.html'), 'utf8');
		expect(page).toContain('<meta name="napplet-id" content="other"');
		expect(page).toContain('<meta name="napplet-server" content="https://blossom.example.com"');
		const manifest: { tags: string[][] } = JSON.parse(readFileSync(join(site.napplet, NAPPLET_TEMPLATE), 'utf8'));
		expect(manifest.tags.filter((t) => t[0] === 'd')).toEqual([['d', 'other']]);
	}, 300_000);
});
