// Fetches the converter build converter/converter.lock.json names from the Blossom servers in .nsite/config.json, for a
// checkout without Docker: the published napplet carries the same build, so the servers hold it by its sha256. Each
// server is asked in turn and the first whose bytes have the locked sha256 and size is taken; a file already in place
// with them stays.
//   npm run converter:fetch
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { wasmBuild } from './converter-build.mjs';

/** Long enough for 9 MB over a slow line, short enough that a server that never answers does not stop the run. */
const TIMEOUT = 120_000;

/**
 * The locked build's bytes from the first server that has them, or null when none does.
 * @param {{ sha256: string, size: number }} lock
 * @param {string[]} servers
 * @param {{ fetch?: typeof fetch, warn?: (line: string) => void }} [options]
 * @returns {Promise<{ bytes: Uint8Array, server: string } | null>}
 */
export async function fetchLocked(lock, servers, { fetch = globalThis.fetch, warn = console.warn } = {}) {
	for (const server of servers) {
		const host = new URL(server).host;
		try {
			const response = await fetch(`${server.replace(/\/+$/, '')}/${lock.sha256}`, { signal: AbortSignal.timeout(TIMEOUT) });
			if (!response.ok) {
				warn(`${host}: ${response.status}`);
				continue;
			}
			const bytes = new Uint8Array(await response.arrayBuffer());
			if (bytes.length === lock.size && createHash('sha256').update(bytes).digest('hex') === lock.sha256) return { bytes, server };
			warn(`${host} sent other bytes`);
		} catch (err) {
			warn(`${host}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return null;
}

async function main() {
	const at = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
	const { wasm: lock } = JSON.parse(readFileSync(at('converter/converter.lock.json'), 'utf8'));
	const { servers } = JSON.parse(readFileSync(at('.nsite/config.json'), 'utf8'));
	const target = at('converter/dist/converter.wasm');
	if (existsSync(target) && JSON.stringify(wasmBuild(target)) === JSON.stringify(lock)) {
		console.log(`converter/dist/converter.wasm is the locked build, ${lock.sha256}`);
		return;
	}
	const found = await fetchLocked(lock, servers);
	if (!found) {
		console.error(`no server in .nsite/config.json has the locked converter, sha256 ${lock.sha256}; build it with converter/build.sh`);
		process.exit(1);
	}
	mkdirSync(at('converter/dist'), { recursive: true });
	writeFileSync(target, found.bytes);
	console.log(`converter/dist/converter.wasm from ${new URL(found.server).host}, ${lock.sha256}, ${lock.size} bytes`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
