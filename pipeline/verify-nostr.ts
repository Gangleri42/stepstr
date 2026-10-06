// Checks a published site and napplet the way a stranger would: fetch the manifests from the relays, verify the
// signatures, recompute the site's aggregate, follow the napplet's page to the converter it names, and confirm every
// file on every listed server. No keys involved.
// Usage: npm run verify:nostr -- [npub-or-hex] [site-id] [--full]
import { createHash } from 'node:crypto';
import * as nip19 from 'nostr-tools/nip19';
import { verifyEvent } from 'nostr-tools/pure';
import { blobUrl, download, extOf, head } from './nostr/blossom.ts';
import { KIND, LOOKUP_RELAYS, readConfig } from './nostr/config.ts';
import { aggregate, tagValue, tagValues, validate } from './nostr/manifest.ts';
import { siteOrigin } from './nostr/nsite.ts';
import { Relays } from './nostr/relays.ts';

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const full = process.argv.includes('--full');
const config = readConfig();
const who = positional[0] ?? config.pubkey;
const decoded = who.startsWith('npub1') ? nip19.decode(who) : null;
if (decoded && decoded.type !== 'npub') throw new Error(`${who} is not an npub`);
const pubkey = decoded ? decoded.data : who;
const id = positional[1] ?? config.id;
const relays = new Relays();
let failures = 0;
const check = (ok: boolean, line: string) => {
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${line}`);
	if (!ok) failures++;
};

async function checkManifest(kind: 35128 | 35129, name: string) {
	console.log(`\n${name} (kind ${kind}) of ${nip19.npubEncode(pubkey)}, d=${id}`);
	const { event, seen } = await relays.latest([...new Set([...config.relays, ...config.archiveRelays, ...LOOKUP_RELAYS])], { kinds: [kind], authors: [pubkey], '#d': [id] });
	if (!event) {
		check(false, 'no manifest found on any relay');
		return;
	}
	check(verifyEvent(event), `signature of ${event.id.slice(0, 12)}… (${new Date(event.created_at * 1000).toISOString()})`);
	const holders = Object.entries(seen).filter(([, eid]) => eid === event.id).map(([r]) => r.replace('wss://', ''));
	const stale = Object.entries(seen).filter(([, eid]) => eid && eid !== event.id).map(([r]) => r.replace('wss://', ''));
	check(holders.length >= 2, `newest copy on ${holders.length} relays: ${holders.join(', ')}${stale.length ? `; STALE on ${stale.join(', ')}` : ''}`);
	try {
		validate(event);
		check(true, kind === KIND.site ? 'NIP-5A shape and aggregate' : 'NIP-5D shape');
	} catch (err) {
		check(false, String(err));
	}
	const servers = tagValues(event, 'server');
	let blobs: { path: string; sha256: string }[];
	if (kind === KIND.site) {
		blobs = event.tags.filter((t) => t[0] === 'path').map((t) => ({ path: t[1], sha256: t[2] }));
		console.log(`  ${blobs.length} files, aggregate ${aggregate(blobs).slice(0, 16)}…; servers: ${servers.join(', ')}`);
	} else {
		const x = tagValue(event, 'x') ?? '';
		blobs = [{ path: '/index.html', sha256: x }];
		// The manifest names the page; the page names the converter it fetches, by hash.
		let page: Uint8Array | null = null;
		for (const server of servers) if (!page) page = await download(server, x, 'html');
		const converter = page ? /blossom:sha256:([0-9a-f]{64})/.exec(new TextDecoder().decode(page))?.[1] : undefined;
		check(!!converter, converter ? `index.html names the converter ${converter.slice(0, 16)}…` : 'index.html could not be fetched from a listed server, or names no converter');
		if (converter) blobs.push({ path: '/converter.txt', sha256: converter });
		console.log(`  "${event.content}"`);
		console.log(`  index.html ${x.slice(0, 16)}…; servers: ${servers.join(', ')}`);
		console.log(`  archetypes ${tagValues(event, 'z').join(', ') || 'none'}; intents ${event.tags.filter((t) => t[0] === 'i').map((t) => t.slice(1).join(' ')).join('; ') || 'none'}`);
		console.log(`  requires ${tagValues(event, 'R').join(', ') || 'nothing'}; optional ${tagValues(event, 'O').join(', ') || 'nothing'}`);
	}
	for (const server of servers) {
		let missing = 0, wrong = 0;
		for (const { path, sha256 } of blobs) {
			if (full) {
				const response = await fetch(blobUrl(server, sha256, extOf(path)), { signal: AbortSignal.timeout(120_000) }).catch(() => null);
				const data = response?.ok ? new Uint8Array(await response.arrayBuffer()) : null;
				if (!data) missing++;
				else if (createHash('sha256').update(data).digest('hex') !== sha256) wrong++;
			} else if ((await head(server, sha256)).status !== 200) missing++;
		}
		check(!missing && !wrong, `${server}: ${blobs.length - missing - wrong}/${blobs.length} files${wrong ? `, ${wrong} with a wrong hash` : ''}${full ? ' (downloaded and hashed)' : ' (HEAD)'}`);
	}
	return event;
}

async function checkList(kind: 10002 | 10063, name: string, tag: string) {
	const { event, seen } = await relays.latest(LOOKUP_RELAYS, { kinds: [kind], authors: [pubkey] });
	const where = Object.entries(seen).filter(([, eid]) => eid).map(([r]) => r.replace('wss://', ''));
	check(!!event && where.length > 0, `${name} (kind ${kind}) on the lookup relays: ${where.join(', ') || 'none'}${event ? `; ${tagValues(event, tag).length} entries` : ''}`);
	if (event) console.log(`       ${tagValues(event, tag).join(', ')}`);
}

console.log(`lists of ${nip19.npubEncode(pubkey)}`);
await checkList(KIND.relayList, 'relay list', 'r');
await checkList(KIND.serverList, 'server list', 'server');
const site = await checkManifest(KIND.site, 'site');
await checkManifest(KIND.napplet, 'napplet');
if (site) {
	const origin = siteOrigin(pubkey, id, config.gatewayHostnames[0]);
	const index = site.tags.find((t) => t[0] === 'path' && t[1] === '/index.html');
	if (index) {
		const expected = index[2];
		/** Whether a host serves the manifest's index.html; `stale` says why it may not yet. */
		const serves = async (host: string, stale: string) => {
			const response = await fetch(`${host}/index.html`, { signal: AbortSignal.timeout(30_000), cache: 'no-store' }).catch(() => null);
			const hash = response?.ok ? createHash('sha256').update(new Uint8Array(await response.arrayBuffer())).digest('hex') : null;
			check(hash === expected, `${host}/index.html ${response?.status ?? 'unreachable'}${hash ? (hash === expected ? ' matches the manifest' : ` differs from the manifest (${stale})`) : ''}`);
		};
		await serves(origin, 'gateway cache?');
		// The web page's own address, when this is the configured site: the Pages mirror serves the manifest's files.
		if (config.url && pubkey === config.pubkey && id === config.id) await serves(config.url, 'the Pages mirror runs every half hour');
	}
	console.log(`\n  ${origin}/  naddr ${nip19.naddrEncode({ kind: KIND.site, pubkey, identifier: id })}`);
	if (config.url && pubkey === config.pubkey && id === config.id) console.log(`  ${config.url}/`);
}
relays.destroy();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
