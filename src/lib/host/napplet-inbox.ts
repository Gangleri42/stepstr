// Files reach a napplet as intents, delivered out of band on an INC topic. The runtime may post the event as soon as
// the frame exists, so this subscribes at module load, before the UI or three.js are in, and keeps the last route for
// whoever mounts later. A host that already holds the file's bytes may hand them over as `data`.
import { addLocalFile } from '$lib/source/local';
import { decode, encode, type RouteCatalogue } from '$lib/state/hash';
import { OPEN_TOPICS, READY_TOPIC, routeFromPayload } from '$lib/state/route';
import { close, has, type Handle, type IncEvent } from './napplet-runtime';

let latest: string | null = null;
let opened = false;
/** Deliveries apply in the order they came: one that carries bytes takes longer to read than one with a link. */
let queue: Promise<void> = Promise.resolve();
let fallbackServers: string[] = [];
let siteCatalogue: RouteCatalogue | null = null;
const listeners = new Set<(route: string) => void>();
const handles: Handle[] = [];

/** An `inc.event` envelope carries the payload inside; some runtimes hand over the payload itself. */
function payloadOf(event: unknown) {
	if (event && typeof event === 'object' && 'topic' in event && ('payload' in event || 'sender' in event)) return (event as IncEvent).payload;
	return event;
}

async function bytesOf(data: unknown): Promise<Uint8Array | null> {
	if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	return null;
}

async function deliver(payload: unknown) {
	let route = routeFromPayload(payload, fallbackServers, siteCatalogue);
	const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null;
	const bytes = p ? await bytesOf(p.data) : null;
	if (p && bytes) {
		// The bytes are the file: keep them, and point the route at them by hash.
		const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim() : 'model.step';
		const sha256 = addLocalFile(name, bytes);
		const view = route ? decode(route, siteCatalogue) : decode(typeof p.view === 'string' ? `#/?${p.view}` : '#/');
		route = encode({ ...view, source: { kind: 'blob', sha256, servers: view.source?.kind === 'blob' ? view.source.servers : [] }, name });
	}
	if (!route) return;
	latest = route;
	for (const listener of listeners) listener(route);
}

function enqueue(payload: unknown) {
	queue = queue.then(() => deliver(payload)).catch(() => undefined);
}

export function openInbox(servers: string[], catalogue: RouteCatalogue | null = null) {
	if (opened) return;
	opened = true;
	fallbackServers = servers;
	siteCatalogue = catalogue;
	const inc = has('inc', 'on', 'emit');
	if (inc) {
		for (const topic of OPEN_TOPICS) {
			try {
				handles.push(inc.on(topic, (event) => enqueue(payloadOf(event))));
			} catch {
				// A runtime that rejects one topic form still gets the other.
			}
		}
		try {
			// stlstr-style shells hold the intent until the napplet says it listens.
			inc.emit(READY_TOPIC);
		} catch {
			// Not every runtime accepts a payload-less emit; nothing depends on it.
		}
	}
	addEventListener('pagehide', closeInbox, { once: true });
}

function closeInbox() {
	for (const handle of handles.splice(0)) close(handle);
}

export const inbox = {
	get latest() {
		return latest;
	},
	subscribe(listener: (route: string) => void) {
		listeners.add(listener);
		return () => listeners.delete(listener);
	}
};
