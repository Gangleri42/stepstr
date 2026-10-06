// Fetches the test files test/fixtures.json names into .cache/fixtures/, checked against their sha256, from their URLs,
// which name commits so they keep serving the same bytes. A file already there with the right hash stays.
//   node scripts/fixtures.mjs             every file
//   node scripts/fixtures.mjs seed-v15    one
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const fixtures = JSON.parse(readFileSync(new URL('../test/fixtures.json', import.meta.url), 'utf8'));
const dir = new URL('../.cache/fixtures/', import.meta.url);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
mkdirSync(dir, { recursive: true });

for (const [name, fixture] of Object.entries(fixtures)) {
	if (process.argv[2] && process.argv[2] !== name) continue;
	const path = new URL(fixture.file, dir);
	if (existsSync(path) && sha256(readFileSync(path)) === fixture.sha256) {
		console.log(`${name}: present`);
		continue;
	}
	let bytes = null;
	for (const url of fixture.urls) {
		try {
			const response = await fetch(url);
			if (!response.ok) continue;
			const body = Buffer.from(await response.arrayBuffer());
			if (sha256(body) === fixture.sha256) {
				bytes = body;
				break;
			}
			console.warn(`${name}: ${new URL(url).host} sent other bytes`);
		} catch (err) {
			console.warn(`${name}: ${new URL(url).host}: ${err.message}`);
		}
	}
	if (!bytes) {
		console.error(`${name}: not found with sha256 ${fixture.sha256}`);
		process.exitCode = 1;
		continue;
	}
	writeFileSync(path, bytes);
	console.log(`${name}: fetched, ${bytes.length} bytes`);
}
