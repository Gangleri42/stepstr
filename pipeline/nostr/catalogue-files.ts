// The files a site's catalogue names besides its STEP files, which live elsewhere: each version's published conversion
// (the GLB and the measurement data), and each companion revision's, with its zipped STEP file. The site's builder
// leaves them in <site>/catalogue-files, each named by its sha256, and the publisher spreads them with the site.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Blob, Catalogue } from '../../src/lib/catalogue/catalogue.ts';
import type { FileEntry } from './manifest.ts';

const TYPES = { glb: 'model/gltf-binary', gz: 'application/gzip', zip: 'application/zip' } as const;

/**
 * Each file the catalogue names once, as the publisher places it from `dir`; `path` says what it is in the logs. With
 * `check`, a file that is missing from `dir` or is not what the catalogue says stops it, with every such file named.
 */
export function catalogueEntries(catalogue: Catalogue, dir: string, check = true): FileEntry[] {
	const entries = new Map<string, FileEntry>();
	const add = (blob: Blob, name: string, ext: keyof typeof TYPES) => {
		if (!entries.has(blob.sha256)) entries.set(blob.sha256, { path: `/${name}.${ext}`, sha256: blob.sha256, bytes: blob.size, type: TYPES[ext], file: join(dir, blob.sha256) });
	};
	for (const [model, { versions, companions }] of Object.entries(catalogue.models)) {
		for (const version of versions) {
			add(version.files.glb, `${model}/${version.id}/model`, 'glb');
			add(version.files.measure, `${model}/${version.id}/measure.json`, 'gz');
		}
		for (const revision of companions?.revisions ?? []) {
			add(revision.files.glb, `${model}/companion/${revision.id}/model`, 'glb');
			add(revision.files.measure, `${model}/companion/${revision.id}/measure.json`, 'gz');
			add(revision.step, `${model}/companion/${revision.id}/step`, 'zip');
		}
	}
	const problems: string[] = [];
	for (const entry of check ? entries.values() : []) {
		const file = entry.file!;
		if (!existsSync(file)) problems.push(`${entry.path} is missing (${entry.sha256})`);
		else if (statSync(file).size !== entry.bytes) problems.push(`${entry.path} is ${statSync(file).size} bytes, the catalogue says ${entry.bytes}`);
		else if (createHash('sha256').update(readFileSync(file)).digest('hex') !== entry.sha256) problems.push(`${entry.path} does not match its sha256`);
	}
	if (problems.length) throw new Error(`${dir}: ${problems.length} of the catalogue's files cannot be published: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? '; …' : ''}`);
	return [...entries.values()];
}
