// Writes the published site into a folder exactly as its signed manifest (kind 35128) has it: every file from a listed
// Blossom server, checked against its sha256, the previous deploy's chunks included. Builds nothing, so what GitHub
// Pages serves at the web address (.github/workflows/pages.yml) is byte for byte the nsite. No keys involved.
// Usage: tsx pipeline/mirror-nostr.ts <dir> [--unless-served]
//   --unless-served   writes nothing when the web address already serves the manifest's index.html
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { download, extOf } from './nostr/blossom.ts';
import { KIND, LOOKUP_RELAYS, readConfig } from './nostr/config.ts';
import { tagValues, validate } from './nostr/manifest.ts';
import { Relays } from './nostr/relays.ts';
import { SITE } from './site.ts';

function fail(message: string): never {
	console.error(`error: ${message}`);
	process.exit(1);
}

const out = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!out) fail('usage: tsx pipeline/mirror-nostr.ts <dir> [--unless-served]');
const config = readConfig(SITE.config);
const relays = new Relays();
// Only events signed by the configured key and matching the filter come back (relays.ts).
const { event } = await relays.latest([...new Set([...config.relays, ...config.archiveRelays, ...LOOKUP_RELAYS])], { kinds: [KIND.site], authors: [config.pubkey], '#d': [config.id] });
relays.destroy();
if (!event) fail(`no site manifest of ${config.id} found on the relays`);
validate(event);
const paths = event.tags.filter((t) => t[0] === 'path').map(([, path, sha256]) => ({ path, sha256 }));
const index = paths.find((p) => p.path === '/index.html');
if (!index) fail('the manifest has no /index.html');

if (process.argv.includes('--unless-served')) {
	if (!config.url) fail(`--unless-served needs a url in ${SITE.config}`);
	const response = await fetch(`${config.url}/index.html`, { signal: AbortSignal.timeout(30_000), cache: 'no-store' }).catch(() => null);
	const served = response?.ok ? createHash('sha256').update(new Uint8Array(await response.arrayBuffer())).digest('hex') : null;
	if (served === index.sha256) {
		console.log(`${config.url} already serves the manifest ${event.id.slice(0, 12)}…; nothing written`);
		process.exit(0);
	}
}

const servers = tagValues(event, 'server');
for (const { path, sha256 } of paths) {
	let bytes: Uint8Array | null = null;
	for (const server of servers) bytes ??= await download(server, sha256, extOf(path));
	if (!bytes) fail(`${path}: no server the manifest lists has bytes with the sha256 ${sha256}`);
	const file = join(out, path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, bytes);
}
console.log(`${paths.length} files of the manifest ${event.id.slice(0, 12)}… (${new Date(event.created_at * 1000).toISOString()}) in ${out}`);
