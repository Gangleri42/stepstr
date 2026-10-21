// Publishes stepstr to Nostr, signed end to end:
//   1. builds the site (build/) and the napplet (dist-napplet: index.html and the converter.txt it fetches by hash), in
//      the site's directory (site.ts)
//   2. spreads the files, and those the site's catalogue names (catalogue-files/), over the Blossom servers
//      (nostr/spread.ts): each server takes the types it accepts, from the project's server by mirroring or by upload
//   3. downloads and hashes each copy where no earlier publish verified it, where it had to be placed again, or where
//      the server reports another size; every file must reach --min-public servers besides the project's
//   4. merges and publishes the relay list (10002) and server list (10063)
//   5. publishes the site manifest (35128) with a snapshot (5128), then the napplet manifest (35129) with its snapshot (5129)
//   6. fetches everything back from the relays and checks the signatures and the manifests
// Usage: npm run publish:nostr -- [--if-changed] [--dry-run] [--skip-build] [--skip-napplet] [--replace-lists] [--no-snapshot] [--min-public N]
// It runs only where STEPSTR_PUBLISHER=1 is set, beside a saved signer: a NIP-46 session with Amber on a phone, or a key
// (nostr/signer.ts says where each is kept). Anywhere else it refuses to start, dry runs included, since those talk to
// the relays and servers too.
// --if-changed stops early when the manifests on the relays already describe this build. The relays are the record of
// what is published; nothing about a deploy is written back into the repository.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { Event, EventTemplate } from 'nostr-tools/core';
import * as nip19 from 'nostr-tools/nip19';
import { verifyEvent } from 'nostr-tools/pure';
import { parseCatalogue } from '../src/lib/catalogue/catalogue.ts';
import { download, extOf, head } from './nostr/blossom.ts';
import { catalogueEntries } from './nostr/catalogue-files.ts';
import { chunksNeeded } from './nostr/carry.ts';
import { KIND, LOOKUP_RELAYS, mimeOf, readConfig } from './nostr/config.ts';
import { mergeRelayList, mergeServerList } from './nostr/lists.ts';
import { aggregate, collectFiles, NAPPLET_TEMPLATE, nappletOptions, nappletTemplate, siteTemplate, snapshotTemplate, tagValue, tagValues, validate, verifiedPairs, type FileEntry } from './nostr/manifest.ts';
import { siteOrigin, snapshotOrigin } from './nostr/nsite.ts';
import { Relays, type PublishReport } from './nostr/relays.ts';
import { openSigner, type Signer } from './nostr/signer.ts';
import { holdingAll, siteServers, spread, SpreadError, type Spread } from './nostr/spread.ts';
import { readCatalogue, SITE, STEPSTR_DIR } from './site.ts';

const log = (line = '') => console.log(line);
function fail(message: string): never {
	console.error(`\nerror: ${message}`);
	process.exit(1);
}

if (process.env.STEPSTR_PUBLISHER !== '1') fail('publishing runs only where STEPSTR_PUBLISHER=1 is set, beside a saved signer');

// Strict: a mistyped flag (--dryrun) stops the run instead of publishing for real.
const { values } = (() => {
	try {
		return parseArgs({
			strict: true,
			allowPositionals: false,
			options: {
				'if-changed': { type: 'boolean' },
				'dry-run': { type: 'boolean' },
				'skip-build': { type: 'boolean' },
				'skip-napplet': { type: 'boolean' },
				'replace-lists': { type: 'boolean' },
				'no-snapshot': { type: 'boolean' },
				'min-public': { type: 'string', default: '3' }
			}
		});
	} catch (err) {
		fail(err instanceof Error ? err.message : String(err));
	}
})();
const minPublic = Number(values['min-public']);
if (!Number.isInteger(minPublic) || minPublic < 0) fail(`--min-public must be a whole number, got "${values['min-public']}"`);
const opts = {
	ifChanged: !!values['if-changed'],
	dryRun: !!values['dry-run'],
	skipBuild: !!values['skip-build'],
	skipNapplet: !!values['skip-napplet'],
	replaceLists: !!values['replace-lists'],
	snapshot: !values['no-snapshot'],
	minPublic
};

const config = readConfig(SITE.config);
const npub = nip19.npubEncode(config.pubkey);
const ownServer = config.servers[0];
const ownRelay = config.relays[0];
const unixNow = () => Math.floor(Date.now() / 1000);

// ---- build and file sets --------------------------------------------------------------------------------------------

if (!opts.skipBuild) {
	log('building the site and the napplet');
	// From stepstr's directory, for this site wherever the command started.
	const build = { stdio: 'inherit', cwd: STEPSTR_DIR, env: { ...process.env, STEPSTR_SITE: SITE.dir } } as const;
	execFileSync('npm', ['run', 'build'], build);
	if (!opts.skipNapplet) execFileSync('npm', ['run', 'build:napplet'], build);
}
if (!existsSync(`${SITE.build}/index.html`)) fail(`${SITE.build}/index.html is missing; run npm run build`);

const site = collectFiles(SITE.build);
const relays = new Relays();
const readRelays = [...new Set([...config.relays, ...config.archiveRelays])];

// The manifests as the relays have them now: the record an unattended run works from.
const current = {
	site: (await relays.latest(readRelays, { kinds: [KIND.site], authors: [config.pubkey], '#d': [config.id] })).event,
	napplet: opts.skipNapplet ? null : (await relays.latest(readRelays, { kinds: [KIND.napplet], authors: [config.pubkey], '#d': [config.id] })).event
};
const listed = (event: Event | null) => new Map(event?.tags.filter((t) => t[0] === 'path').map((t) => [t[1], t[2]]) ?? []);

// Blobs fetched from the project's server, by sha256: previous files read below, and bytes for re-uploads later.
const fetched = new Map<string, Uint8Array>();
const fromOwnServer = async (sha256: string, path: string) => {
	const cached = fetched.get(sha256);
	if (cached) return cached;
	const data = await download(ownServer, sha256, extOf(path));
	if (data) fetched.set(sha256, data);
	return data;
};

// A returning browser may hold the previous index.html for an hour, so the hashed files it loads stay in the manifest
// for one more deploy. They are found by following that index.html's imports through the manifest on the relays;
// files it carried from older deploys drop out. A first deploy has nothing to carry, and when the old index.html
// cannot be read, every hashed path of the old manifest stays once more.
const previousChunks: { path: string; sha256: string; bytes: number }[] = await (async () => {
	if (!current.site) return [];
	const files = listed(current.site);
	const read = async (path: string) => {
		const sha256 = files.get(path);
		const data = sha256 ? await fromOwnServer(sha256, path) : null;
		return data ? new TextDecoder().decode(data) : null;
	};
	const needed = await chunksNeeded(files, read);
	const paths = needed.size ? [...needed] : [...files.keys()].filter((path) => path.startsWith('/_app/immutable/'));
	if (!needed.size) log(`could not read the previous index.html from ${ownServer}; keeping all ${paths.length} hashed paths of the previous manifest`);
	return paths.map((path) => ({ path, sha256: files.get(path)!, bytes: 0 }));
})();
const previous: FileEntry[] = previousChunks.filter((p) => !site.some((s) => s.path === p.path)).map((p) => ({ ...p, type: mimeOf(p.path) }));
// The napplet: its page, which its manifest names, and the converter the page fetches by hash, a blob of its own.
const napplet = opts.skipNapplet ? [] : collectFiles(SITE.napplet, [`/${NAPPLET_TEMPLATE}`]);
const page = napplet.find((f) => f.path === '/index.html');
if (!opts.skipNapplet && !page) fail(`${SITE.napplet} has no /index.html; run npm run build:napplet`);
// What the build declared; the publisher signs it with the servers that hold the files.
const declared = opts.skipNapplet ? null : nappletOptions(JSON.parse(readFileSync(`${SITE.napplet}/${NAPPLET_TEMPLATE}`, 'utf8')));
if (declared && declared.id !== config.id) fail(`the napplet was built as "${declared.id}", the site id is "${config.id}"; build it again`);
if (declared && declared.artifact !== page?.sha256) fail(`${SITE.napplet}/${NAPPLET_TEMPLATE} names another index.html than ${SITE.napplet} has; run npm run build:napplet`);

// The files the site's catalogue names, which no manifest lists: the viewer finds them by hash in catalogue.json.
const catalogue = (() => {
	try {
		return readCatalogue()?.catalogue ?? null;
	} catch (err) {
		fail(err instanceof Error ? err.message : String(err));
	}
})();
const catalogued: FileEntry[] = (() => {
	try {
		return catalogue ? catalogueEntries(catalogue, SITE.catalogueFiles) : [];
	} catch (err) {
		fail(err instanceof Error ? err.message : String(err));
	}
})();

const uploads: FileEntry[] = [...site, ...napplet];
const everything: FileEntry[] = [...uploads, ...catalogued.filter((c) => !uploads.some((u) => u.sha256 === c.sha256)), ...previous];
const megabytes = (entries: { bytes: number }[]) => (entries.reduce((n, e) => n + e.bytes, 0) / 1e6).toFixed(2);

log(`\nsite ${config.id} for ${npub}`);
log(`  ${site.length} files, ${megabytes(site)} MB, aggregate ${aggregate([...site, ...previous]).slice(0, 16)}…`);
if (previous.length) log(`  keeping ${previous.length} chunk paths of the previous deploy for browsers holding the old index.html`);
if (page) log(`  napplet ${napplet.map((f) => f.path).join(' ')}, ${megabytes(napplet)} MB, index.html ${page.sha256.slice(0, 16)}…`);
if (catalogued.length) log(`  catalogue ${catalogued.length} files, ${megabytes(catalogued)} MB`);
log(`  relays  ${config.relays.join(', ')}`);
log(`  servers ${config.servers.join(', ')}`);

// Already published: every file of this build is in the current manifest with the same hash (old chunks may linger).
const published = (files: FileEntry[], event: Event | null) => files.length > 0 && !!event && files.every((f) => listed(event).get(f.path) === f.sha256);
// The napplet's page embeds the converter's hash, so the page's hash covers both.
const nappletPublished = !!declared && !!current.napplet && tagValue(current.napplet, 'x') === declared.artifact;
if (opts.ifChanged && published(site, current.site) && (opts.skipNapplet || nappletPublished)) {
	log(`\nnothing changed: the manifests on the relays already describe this build (site ${current.site!.id.slice(0, 12)}…)`);
	relays.destroy();
	process.exit(0);
}

// ---- dry run: what would happen, with no signer and no writes ------------------------------------------------------

if (opts.dryRun) {
	log('\ndry run: presence on each server (unauthenticated HEAD)');
	for (const server of config.servers) {
		const present = await Promise.all(everything.map(async (e) => (await head(server, e.sha256)).status === 200));
		log(`  ${server}: ${present.filter(Boolean).length}/${everything.length} files already there`);
	}
	const siteEvent = siteTemplate({ id: config.id, entries: [...site, ...previous], servers: config.servers, title: config.title, description: config.description, source: config.source });
	validate(siteEvent);
	log(`\nsite manifest (unsigned): kind ${siteEvent.kind}, ${siteEvent.tags.length} tags, ${JSON.stringify(siteEvent).length} bytes`);
	if (declared) {
		const nappletEvent = nappletTemplate({ ...declared, servers: config.servers });
		validate(nappletEvent);
		log(`napplet manifest (unsigned): kind ${nappletEvent.kind}, ${nappletEvent.tags.length} tags, index.html ${declared.artifact.slice(0, 16)}…`);
	}
	log(`\nwould publish to ${config.relays.length} relays and the lists also to ${LOOKUP_RELAYS.join(', ')}`);
	log(`nsite: ${siteOrigin(config.pubkey, config.id, config.gatewayHostnames[0])}/`);
	if (config.url) log(`web page: ${config.url}/ (served from the published manifest by the Pages mirror)`);
	relays.destroy();
	process.exit(0);
}

// ---- signer ---------------------------------------------------------------------------------------------------------

const signer: Signer = await openSigner(config.pubkey).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
log(`\nsigning as ${signer.npub}`);
const shutdown = async () => {
	await signer.close();
	relays.destroy();
};

// One upload authorisation covers a batch of hashes on every server, so a run signs a handful of tokens, not hundreds.
// The token is scoped by the file hashes and a short expiry only. BUD-11's optional `server` tags are read
// differently by the servers out there (hzrd149's blossom-server wants the bare domain, blssm.us and nsite.run
// reject anything but a URL), and a hash-scoped token replayed elsewhere can only place the same public bytes. A
// batch's token is signed again a minute before it expires; a server that wants a token minted just before the
// transfer gets one of its own each time (nostr/spread.ts).
const batches = new Map<string, FileEntry[]>();
for (let i = 0; i < everything.length; i += 20) {
	const batch = everything.slice(i, i + 20);
	for (const entry of batch) batches.set(entry.sha256, batch);
}
const EXPIRY = 600;
const authorisation = (hashes: string[], lifetime = EXPIRY) => {
	const signed = unixNow();
	return signer.signEvent({
		kind: KIND.blobAuth,
		created_at: signed,
		content: `Publish ${config.title}`,
		tags: [['t', 'upload'], ['expiration', String(signed + lifetime)], ...hashes.map((sha256) => ['x', sha256])]
	});
};
// The servers of one file are served at once, so a batch keeps its pending signature and they all wait for that one.
const auths = new Map<FileEntry[], { signed: number; auth: Promise<Event> }>();
const auth = {
	batched(entry: { sha256: string }): Promise<Event> {
		const batch = batches.get(entry.sha256)!;
		const cached = auths.get(batch);
		if (cached && unixNow() - cached.signed < EXPIRY - 60) return cached.auth;
		const signed = unixNow();
		const pending = authorisation(batch.map((e) => e.sha256));
		auths.set(batch, { signed, auth: pending });
		return pending;
	},
	fresh: (entry: { sha256: string }) => authorisation([entry.sha256], 300)
};

// ---- blobs: which servers take which types, then to the project's server and from it to the rest, then verified ---

// What the manifests on the relays list was verified on their servers before they went out; finding those files
// there again while placing, at their size, is enough.
const verifiedBefore = verifiedPairs([current.site, current.napplet]);
// No manifest names the converter: the napplet's page does, by hash. The converter the published page names was
// verified with it, on the same servers.
const publishedPage = current.napplet && tagValue(current.napplet, 'x');
const pageBytes = publishedPage ? await fromOwnServer(publishedPage, '/index.html') : null;
const publishedConverter = pageBytes ? /blossom:sha256:([0-9a-f]{64})/.exec(new TextDecoder().decode(pageBytes))?.[1] : undefined;
if (current.napplet && publishedConverter) for (const server of tagValues(current.napplet, 'server')) verifiedBefore.add(`${server} ${publishedConverter}`);
// Nor the files the published catalogue names. Each copy of them was verified where it was placed or found, on the
// servers the site manifest lists; a server there that refused a type holds none of it, and is asked again.
const publishedCatalogue = listed(current.site).get('/catalogue.json');
const catalogueBytes = publishedCatalogue ? await fromOwnServer(publishedCatalogue, '/catalogue.json') : null;
if (current.site && catalogueBytes) {
	try {
		const before = catalogueEntries(parseCatalogue(JSON.parse(new TextDecoder().decode(catalogueBytes))), '', false);
		for (const server of tagValues(current.site, 'server')) for (const entry of before) verifiedBefore.add(`${server} ${entry.sha256}`);
	} catch {
		// A catalogue that cannot be read lists nothing: every copy is downloaded again.
	}
}

log('\nchecking servers (BUD-06 preflight per file type), then placing files');
let spreadOut: Spread;
try {
	spreadOut = await spread({
		servers: config.servers,
		entries: everything,
		verifiedBefore,
		minPublic: opts.minPublic,
		// The local file, or for a chunk carried over from the previous deploy, a verified copy from the project's server.
		bytesOf: async (entry) => (entry.file ? readFileSync(entry.file) : fromOwnServer(entry.sha256, entry.path)),
		auth,
		log
	});
} catch (err) {
	await shutdown();
	fail(err instanceof SpreadError ? err.message : String(err));
}
const lostPrevious = new Set(spreadOut.lost.map((entry) => entry.path));
const carried = previous.filter((p) => !lostPrevious.has(p.path));
if (lostPrevious.size) log(`  ${lostPrevious.size} previous chunk paths are no longer on ${ownServer} and are dropped`);
// Everything that must be served, and the site's own file set (the napplet is its own manifest). A manifest lists the
// servers that hold every file it names; the site's also vouches for the catalogue's files, which the next publish
// trusts on those servers.
const siteEntries: FileEntry[] = [...site, ...carried];
const serverTags = siteServers(spreadOut, config.servers, siteEntries, catalogued);
const nappletServers = holdingAll(spreadOut, config.servers, napplet);
for (const [server, types] of spreadOut.refused) log(`  ${server} holds no ${types.join(', ')}`);
log(`  the site's files are on ${serverTags.length} servers${declared ? `, the napplet's on ${nappletServers.length}` : ''}`);

// ---- relay and server lists -----------------------------------------------------------------------------------------

const listRelays = [...new Set([...config.relays, ...LOOKUP_RELAYS])];
const report = (r: Record<string, { ok: boolean; reason: string }>) =>
	Object.entries(r)
		.map(([relay, v]) => `${v.ok ? 'ok' : 'NO'} ${relay.replace('wss://', '')}${v.ok ? '' : ` (${v.reason})`}`)
		.join(', ');
const laterThan = (existing: Event | null) => Math.max(unixNow(), (existing?.created_at ?? 0) + 1);

async function publishList(kind: 10002 | 10063, tagsFor: (existing: Event | null) => { tags: string[][]; added: string[]; dropped: string[] }) {
	const { event: existing } = await relays.latest(listRelays, { kinds: [kind], authors: [config.pubkey] });
	const merge = tagsFor(existing);
	if (merge.dropped.length) log(`  kind ${kind}: replacing, dropping ${merge.dropped.join(', ')}`);
	if (existing && !merge.added.length && !merge.dropped.length && JSON.stringify(existing.tags) === JSON.stringify(merge.tags)) {
		log(`  kind ${kind}: unchanged (${merge.tags.length} entries)`);
		return;
	}
	const event = await signer.signEvent({ kind, created_at: laterThan(existing), content: existing?.content ?? '', tags: merge.tags });
	log(`  kind ${kind}: ${merge.tags.length} entries${merge.added.length ? `, added ${merge.added.join(', ')}` : ''} → ${report(await relays.publish(listRelays, event))}`);
}

log('\npublishing the relay list and the server list');
// The archive relays take no writes from the publisher but keep its events for good, so readers see them as outboxes.
await publishList(KIND.relayList, (existing) => mergeRelayList(existing, [...config.relays, ...config.archiveRelays.map((url) => ({ url, marker: 'write' as const }))], opts.replaceLists));
await publishList(KIND.serverList, (existing) => mergeServerList(existing, serverTags, opts.replaceLists));

// ---- manifests and snapshots ----------------------------------------------------------------------------------------

async function publishManifest(name: string, build: (created_at: number) => EventTemplate, kind: 35128 | 35129) {
	// The relays are the record: the new manifest replaces whatever they hold, and must be dated after it.
	const { event: remote } = await relays.latest(readRelays, { kinds: [kind], authors: [config.pubkey], '#d': [config.id] });
	const template = build(laterThan(remote));
	validate(template);
	const event = await signer.signEvent(template);
	const published = await relays.publish(config.relays, event);
	log(`  ${name} ${kind} ${event.id.slice(0, 12)}… → ${report(published)}`);
	if (!Object.values(published).some((r) => r.ok)) {
		await shutdown();
		fail(`no relay accepted the ${name} manifest`);
	}
	let snapshot: Event | null = null;
	let snapshotReport: PublishReport = {};
	if (opts.snapshot) {
		snapshot = await signer.signEvent(snapshotTemplate(event, ownRelay, event.created_at + 1));
		validate(snapshot, { snapshot: true });
		snapshotReport = await relays.publish(config.relays, snapshot);
		log(`  ${name} snapshot ${snapshot.kind} ${snapshot.id.slice(0, 12)}… → ${report(snapshotReport)}`);
	}
	// Read back: the manifest must come back from at least two relays, valid, with the aggregate computed here.
	const back = await relays.latest(readRelays, { kinds: [kind], authors: [config.pubkey], '#d': [config.id] });
	const holders = Object.entries(back.seen).filter(([, id]) => id === event.id).map(([relay]) => relay);
	if (!back.event || back.event.id !== event.id || !verifyEvent(back.event)) {
		await shutdown();
		fail(`${name}: the relays return ${back.event?.id.slice(0, 12) ?? 'nothing'} instead of ${event.id.slice(0, 12)}…`);
	}
	validate(back.event);
	log(`  ${name} read back from ${holders.length} relays, signature and manifest checked${holders.length < 2 ? ' (WARNING: fewer than two relays hold it)' : ''}`);
	const snapshotRelays = Object.entries(snapshotReport).filter(([, r]) => r.ok).map(([relay]) => relay);
	return { event, relays: holders, snapshot, snapshotRelays };
}

log('\npublishing the site');
const siteResult = await publishManifest(
	'site',
	(created_at) => siteTemplate({ id: config.id, entries: siteEntries, servers: serverTags, title: config.title, description: config.description, source: config.source, created_at }),
	KIND.site
);
let nappletResult: Awaited<ReturnType<typeof publishManifest>> | null = null;
if (declared) {
	log('\npublishing the napplet');
	nappletResult = await publishManifest('napplet', (created_at) => nappletTemplate({ ...declared, servers: nappletServers, created_at }), KIND.napplet);
}

// ---- gateway check --------------------------------------------------------------------------------------------------

const gateway = config.gatewayHostnames[0];
const origin = siteOrigin(config.pubkey, config.id, gateway);
const indexEntry = siteEntries.find((e) => e.path === '/index.html');
if (indexEntry) {
	try {
		const response = await fetch(`${origin}/index.html`, { signal: AbortSignal.timeout(20_000), cache: 'no-store' });
		const served = new Uint8Array(await response.arrayBuffer());
		const same = createHash('sha256').update(served).digest('hex') === indexEntry.sha256;
		log(`\n${gateway}: /index.html ${response.status}, ${same ? 'matches this deploy' : 'differs (the gateway may still cache the previous deploy for up to an hour)'}`);
	} catch (err) {
		log(`\n${gateway}: could not fetch /index.html (${err instanceof Error ? err.message : err})`);
	}
}

const naddr = (kind: number) => nip19.naddrEncode({ kind, pubkey: config.pubkey, identifier: config.id, relays: [ownRelay] });
log('\npublished');
log(`  site      ${origin}/`);
for (const host of config.gatewayHostnames.slice(1)) log(`            ${siteOrigin(config.pubkey, config.id, host)}/`);
if (config.url) log(`  web page  ${config.url}/ once the Pages mirror has run (.github/workflows/pages.yml)`);
if (siteResult.snapshot) log(`  snapshot  ${snapshotOrigin(siteResult.snapshot.id, gateway)}/`);
log(`  naddr     ${naddr(KIND.site)}`);
if (nappletResult) {
	log(`  napplet   ${naddr(KIND.napplet)}`);
	if (nappletResult.snapshot) log(`            snapshot nevent ${nip19.neventEncode({ id: nappletResult.snapshot.id, author: config.pubkey, kind: nappletResult.snapshot.kind, relays: [ownRelay] })}`);
}
await shutdown();
