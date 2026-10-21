// Blossom servers stubbed at fetch, for the tests of spreading files over them: each holds blobs by sha256 and can
// refuse a type, refuse an authorisation signed a while ago or one it has seen, or lack the mirror endpoint.
import { createHash } from 'node:crypto';
import type { Event } from 'nostr-tools/core';
import { vi } from 'vitest';
import type { FileEntry } from './manifest.ts';

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const NOW = 1_800_000_000;

export type Server = {
	blobs: Map<string, Uint8Array>;
	/** Types it refuses at preflight. */
	refuses?: string[];
	/** It refuses an authorisation signed more than two minutes before the request. */
	strict?: boolean;
	/** It takes each authorisation once, and answers a second use with a 400 that names it. */
	once?: boolean;
	/** It answers a preflight for a file it holds with a 400. */
	refusesHeld?: boolean;
	/** It has no mirror endpoint. */
	noMirror?: boolean;
	/** What was asked of it: "<method> <path>". */
	calls: string[];
};

export function file(name: string, type: string, text: string): FileEntry & { data: Uint8Array } {
	const data = new TextEncoder().encode(text);
	return { path: `/${name}`, sha256: sha256(data), bytes: data.length, type, file: name, data };
}

/** Servers stubbed at fetch, by origin. */
export function world(spec: Record<string, Partial<Server>>) {
	const servers = Object.fromEntries(Object.entries(spec).map(([origin, s]) => [origin, { blobs: new Map(), calls: [], ...s } as Server]));
	/** "<origin> <event id>" for each authorisation a server has seen. */
	const seen = new Set<string>();
	vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
		const url = new URL(input);
		const server = servers[url.origin];
		const method = init.method ?? 'GET';
		if (!server) throw new TypeError('fetch failed');
		server.calls.push(`${method} ${url.pathname}`);
		const headers = new Headers(init.headers);
		const authorisation = headers.get('authorization');
		const event = authorisation ? (JSON.parse(Buffer.from(authorisation.slice(6), 'base64url').toString()) as Event) : null;
		const refuse = (status: number, reason: string) => new Response(null, { status, headers: { 'x-reason': reason } });
		if (event && server.strict && NOW - event.created_at > 120) return refuse(401, 'authorisation too old');
		if (event && server.once) {
			if (seen.has(`${url.origin} ${event.id}`)) return refuse(400, 'Auth event already used');
			seen.add(`${url.origin} ${event.id}`);
		}
		const hash = /^\/([0-9a-f]{64})/.exec(url.pathname)?.[1];
		if (hash) {
			const blob = server.blobs.get(hash);
			if (!blob) return new Response(null, { status: 404 });
			return new Response(method === 'HEAD' ? null : (blob.slice().buffer as ArrayBuffer), { headers: { 'content-length': String(blob.length) } });
		}
		if (url.pathname === '/upload' && method === 'HEAD') {
			if (server.refusesHeld && server.blobs.has(headers.get('x-sha-256') ?? '')) return refuse(400, 'already got that file (head)');
			return server.refuses?.includes(headers.get('x-content-type') ?? '') ? refuse(415, 'type not allowed') : new Response(null, { status: 200 });
		}
		if (url.pathname === '/upload' && method === 'PUT') {
			const body = new Uint8Array(init.body as Uint8Array);
			server.blobs.set(sha256(body), body);
			return new Response('{}', { status: 201 });
		}
		if (url.pathname === '/mirror' && method === 'PUT') {
			if (server.noMirror) return new Response(null, { status: 404 });
			const from = new URL(JSON.parse(init.body as string).url);
			const blob = servers[from.origin]?.blobs.get(from.pathname.slice(1).split('.')[0]);
			if (!blob) return refuse(502, 'could not fetch it');
			server.blobs.set(sha256(blob), blob);
			return new Response('{}', { status: 201 });
		}
		return new Response(null, { status: 404 });
	});
	return servers;
}
