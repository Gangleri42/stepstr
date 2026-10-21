// Another site's builds: its own config in, its own outputs out, and stepstr's left as they were. Both builds run, a
// few seconds each.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CONVERTER, lacking } from '../test/prerequisites.ts';
import { fixtureCatalogue } from '../src/lib/catalogue/fixture.ts';
import { nappletRole } from '../src/lib/state/archetype.ts';
import { readConfig } from './nostr/config.ts';
import { NAPPLET_TEMPLATE } from './nostr/manifest.ts';
import { readCatalogue, sitePaths, STEPSTR_DIR } from './site.ts';

describe('sitePaths', () => {
	it('puts the config and both builds in the site directory, a relative one taken from the working directory', () => {
		expect(sitePaths('/srv/site')).toEqual({
			dir: '/srv/site',
			config: '/srv/site/.nsite/config.json',
			catalogue: '/srv/site/catalogue.json',
			catalogueFiles: '/srv/site/catalogue-files',
			build: '/srv/site/build',
			napplet: '/srv/site/dist-napplet',
			verified: '/srv/site/.cache/verified-copies.json'
		});
		expect(sitePaths('..').dir).toBe(join(process.cwd(), '..'));
	});
});

describe('a site\'s napplet role', () => {
	it('is stepstr\'s own where the config names none', () => {
		expect(nappletRole()).toEqual({
			archetype: '3d-model',
			convention: 'napplet:3d-model/open',
			topics: ['napplet:3d-model/open', '3d-model:open'],
			ready: '3d-model:ready',
			params: ['url', 'sha256', 'servers', 'name', 'view', 'route'],
			requires: ['inc', 'resource'],
			optional: ['theme', 'link', 'outbox', 'fs', 'storage']
		});
	});

	it('takes the archetype\'s topics, and stepstr\'s for what it leaves out', () => {
		expect(nappletRole({ archetype: 'cad-viewer', optional: ['theme'] })).toMatchObject({
			convention: 'napplet:cad-viewer/open',
			topics: ['napplet:cad-viewer/open', 'cad-viewer:open'],
			ready: 'cad-viewer:ready',
			requires: ['inc', 'resource'],
			optional: ['theme']
		});
	});

	it('is checked when the config is read', () => {
		const dir = mkdtempSync(join(tmpdir(), 'stepstr-config-'));
		const stepstr = JSON.parse(readFileSync(sitePaths(STEPSTR_DIR).config, 'utf8'));
		const path = join(dir, 'config.json');
		try {
			writeFileSync(path, JSON.stringify({ ...stepstr, napplet: { archetype: 'CAD viewer', param: ['model'], optional: 'theme' } }));
			expect(() => readConfig(path)).toThrow(/napplet.archetype must be of \[a-z0-9-\]; napplet.param is no napplet setting; napplet.optional must be a list of words/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
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

describe('a site\'s catalogue', () => {
	it('is read and checked when there is one', () => {
		const dir = mkdtempSync(join(tmpdir(), 'stepstr-catalogue-'));
		const path = join(dir, 'catalogue.json');
		try {
			expect(readCatalogue(path)).toBeNull();
			const text = JSON.stringify(fixtureCatalogue(), null, '\t');
			writeFileSync(path, text);
			expect(readCatalogue(path)).toEqual({ text, catalogue: fixtureCatalogue() });
			writeFileSync(path, JSON.stringify({ ...fixtureCatalogue(), home: 'anvil' }));
			expect(() => readCatalogue(path)).toThrow(`${path}: the catalogue is not valid: catalogue.home names no model it lists`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/** Writes a site's config, builds both outputs for it and returns their paths; stepstr's own builds must stay as they were. */
function buildSite(dir: string, config: object, catalogue?: object) {
	const site = sitePaths(dir);
	const own = sitePaths(STEPSTR_DIR);
	mkdirSync(join(dir, '.nsite'));
	writeFileSync(site.config, JSON.stringify(config));
	if (catalogue) writeFileSync(site.catalogue, JSON.stringify(catalogue, null, '\t'));
	const before = [tree(own.build), tree(own.napplet)];
	// Vitest's NODE_ENV would make development builds.
	const env = { ...process.env, NODE_ENV: 'production', STEPSTR_SITE: dir };
	for (const script of ['build', 'build:napplet']) execFileSync('npm', ['run', script], { cwd: STEPSTR_DIR, env, stdio: 'pipe' });
	expect([tree(own.build), tree(own.napplet)]).toEqual(before);
	return site;
}

describe.skipIf(lacking(CONVERTER))('a build for another site', () => {
	const dirs: string[] = [];
	const siteDir = () => {
		dirs.push(mkdtempSync(join(tmpdir(), 'stepstr-site-')));
		return dirs.at(-1)!;
	};
	afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
	const stepstr = JSON.parse(readFileSync(sitePaths(STEPSTR_DIR).config, 'utf8'));

	it('reads its config and writes its outputs, leaving stepstr\'s alone', () => {
		const site = buildSite(siteDir(), {
			id: 'other',
			title: 'Other & co',
			description: 'Another "site".',
			pubkey: stepstr.pubkey,
			relays: ['wss://relay.example.com'],
			servers: ['https://blossom.example.com'],
			napplet: { archetype: 'cad-viewer', params: ['model', 'version'] }
		});
		expect(existsSync(join(site.build, 'catalogue.json'))).toBe(false);

		const web = readFileSync(join(site.build, 'index.html'), 'utf8');
		expect(web).toContain('<title>Open a STEP file · Other &amp; co</title>');
		expect(web).toContain('<meta name="description" content="Another &quot;site&quot;." />');
		expect(JSON.parse(readFileSync(join(site.build, 'manifest.webmanifest'), 'utf8'))).toMatchObject({ name: 'Other & co', description: 'Another "site".' });
		const scripts = Object.keys(tree(join(site.build, '_app'))!).map((path) => readFileSync(join(site.build, '_app', path), 'utf8')).join('\n');
		expect(scripts).toContain('https://blossom.example.com');
		expect(scripts).not.toContain(stepstr.servers[1]);

		const page = readFileSync(join(site.napplet, 'index.html'), 'utf8');
		expect(page).toContain('<title>Other &amp; co</title>');
		expect(page).toContain('<meta name="napplet-id" content="other"');
		expect(page).toContain('<meta name="napplet-intent" content="napplet:cad-viewer/open model version"');
		expect(page).toContain('<meta name="napplet-requires" content="inc resource"');
		expect(page).toContain('<meta name="napplet-server" content="https://blossom.example.com"');
		// The page listens on the site's topics.
		expect(page).toContain('cad-viewer:ready');
		expect(page).not.toContain('3d-model:ready');
		const manifest: { tags: string[][] } = JSON.parse(readFileSync(join(site.napplet, NAPPLET_TEMPLATE), 'utf8'));
		const tags = (name: string) => manifest.tags.filter((t) => t[0] === name);
		expect(tags('d')).toEqual([['d', 'other']]);
		expect(tags('title')).toEqual([['title', 'Other & co']]);
		expect(tags('z')).toEqual([['z', 'cad-viewer']]);
	}, 300_000);

	it('carries its catalogue: beside the web page as written, inside the napplet as checked', () => {
		const catalogue = fixtureCatalogue();
		const site = buildSite(siteDir(), { ...stepstr, id: 'catalogued', title: 'Catalogued' }, catalogue);
		expect(readFileSync(join(site.build, 'catalogue.json'), 'utf8')).toBe(JSON.stringify(catalogue, null, '\t'));
		// The web page fetches it, so its code holds none of it.
		const scripts = Object.keys(tree(join(site.build, '_app'))!).map((path) => readFileSync(join(site.build, '_app', path), 'utf8')).join('\n');
		expect(scripts).not.toContain(catalogue.models.stand.versions[0].step.sha256);
		const page = readFileSync(join(site.napplet, 'index.html'), 'utf8');
		for (const { versions } of Object.values(catalogue.models)) for (const v of versions) expect(page).toContain(v.step.sha256);
		expect(page).toContain(catalogue.conversion);
	}, 300_000);
});
