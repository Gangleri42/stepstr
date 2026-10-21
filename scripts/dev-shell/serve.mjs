// A small NIP-5D shell for trying the built napplet locally: it serves the shell page, the artefact with the Kehto
// runtime prelude injected (the way Paja and stlstr mount napplets), the napplet's other files and those its site's
// catalogue names by sha256 (as the Blossom servers they are published to would), and reads Nostr events for the
// napplet's outbox requests.
// Usage: npm run build:napplet, then npm run dev:shell and open http://127.0.0.1:4180/. HOST=<this machine's address>
// serves it to other devices on the network, such as a phone. STEPSTR_SITE=<dir> serves that site's napplet
// (<dir>/dist-napplet) and catalogue files (<dir>/catalogue-files), as the builds and tools read it (pipeline/site.ts).
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectNappletNamespacePrelude } from '@kehto/shell';
import { SimplePool } from 'nostr-tools/pool';

const port = Number(process.env.PORT ?? 4180);
const host = process.env.HOST ?? '127.0.0.1';
const ALL_DOMAINS = ['inc', 'resource', 'theme', 'link', 'outbox', 'fs', 'storage'];
const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.nostr.band', 'wss://purplepag.es'];
// A relative site directory is taken from where the command runs; without one, stepstr's own.
const site = resolve(process.env.STEPSTR_SITE || fileURLToPath(new URL('../..', import.meta.url)));
const artefactDir = join(site, 'dist-napplet');
const artefact = join(artefactDir, 'index.html');
const catalogueFiles = join(site, 'catalogue-files');
const shell = new URL('./index.html', import.meta.url);
const pool = new SimplePool();

const json = (res, value) => {
	res.setHeader('content-type', 'application/json');
	res.end(JSON.stringify(value));
};
const relaysOf = (list) => [...new Set([...(Array.isArray(list) ? list : []).filter((r) => /^wss:\/\//.test(r)), ...RELAYS])];

/** Hashes of the built napplet's files, kept while a file keeps its size and time. */
const hashes = new Map();

/** A file of the built napplet or of the site's catalogue by its sha256, or null. */
function blob(sha256) {
	// The builder names the catalogue's files by their sha256; the napplet checks what it gets.
	const catalogued = join(catalogueFiles, sha256);
	if (existsSync(catalogued)) return readFileSync(catalogued);
	if (!existsSync(artefactDir)) return null;
	for (const name of readdirSync(artefactDir)) {
		const path = `${artefactDir}/${name}`;
		const stat = statSync(path);
		if (!stat.isFile()) continue;
		const stamp = `${stat.size}:${stat.mtimeMs}`;
		if (hashes.get(path)?.stamp !== stamp) hashes.set(path, { stamp, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
		if (hashes.get(path).sha256 === sha256) return readFileSync(path);
	}
	return null;
}

async function body(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', 'http://localhost');
	try {
		if (url.pathname === '/napplet.html') {
			if (!existsSync(artefact)) return res.writeHead(404).end(`${artefact} is missing: run npm run build:napplet first`);
			const domains = (url.searchParams.get('domains') ?? ALL_DOMAINS.join(',')).split(',').filter((d) => ALL_DOMAINS.includes(d));
			res.setHeader('content-type', 'text/html; charset=utf-8');
			return res.end(injectNappletNamespacePrelude(readFileSync(artefact, 'utf8'), { domains }));
		}
		// The napplet's own files, the way the Blossom servers it is published to serve them.
		const hash = /^\/blob\/([0-9a-f]{64})$/.exec(url.pathname)?.[1];
		if (hash) {
			const bytes = blob(hash);
			res.setHeader('access-control-allow-origin', '*');
			return bytes ? res.end(bytes) : res.writeHead(404).end();
		}
		// The napplet's outbox requests, answered from public relays.
		if (url.pathname === '/nostr/get' && req.method === 'POST') {
			const { id, author, relays } = await body(req);
			const event = await pool.get(relaysOf(relays), { ids: [id], ...(author ? { authors: [author] } : {}) }, { maxWait: 6000 });
			return json(res, event ?? null);
		}
		if (url.pathname === '/nostr/query' && req.method === 'POST') {
			const { filters, relays } = await body(req);
			return json(res, await pool.querySync(relaysOf(relays), filters[0] ?? {}, { maxWait: 6000 }));
		}
		res.setHeader('content-type', 'text/html; charset=utf-8');
		res.end(readFileSync(shell));
	} catch (err) {
		res.writeHead(500).end(String(err));
	}
}).listen(port, host, () => console.log(`stepstr dev shell at http://${host}:${port}/`));
