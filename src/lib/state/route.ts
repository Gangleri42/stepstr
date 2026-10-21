// The hash grammar is the viewer's route (see hash.ts). Outside a URL, a napplet is opened with a NAP-INTENT payload on
// its site's convention, 3d-model for stepstr (state/archetype.ts): string fields any napplet of that role can read
// (url, sha256, servers, name, view) and `route`, stepstr's own full route, which wins when it is valid. Runtimes turn a
// convention URI's query into it.
import { resolveLink } from '$lib/source/links';
import { role } from 'virtual:stepstr-site';
import { decode, encode, isRoute, type ViewState } from './hash';

export const CONVENTION = role.convention;
export const OPEN_TOPICS = role.topics;
export const READY_TOPIC = role.ready;

/** A route in the hash grammar with its leading "#", or null when the text is not one. */
export function normalizeRoute(text: unknown): string | null {
	if (typeof text !== 'string') return null;
	const trimmed = text.trim();
	if (!trimmed.startsWith('#/') && !trimmed.startsWith('/')) return null;
	const hash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
	return isRoute(hash) ? hash : null;
}

const decoded = (text: unknown) => {
	if (typeof text !== 'string') return null;
	try {
		return decodeURIComponent(text);
	} catch {
		return null;
	}
};

const field = (payload: Record<string, unknown>, key: string) => {
	const value = payload[key];
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

/** The route an intent payload asks for, or null when it names nothing this viewer can open. */
export function routeFromPayload(payload: unknown, fallbackServers: string[] = []): string | null {
	if (!payload || typeof payload !== 'object') return null;
	const p = payload as Record<string, unknown>;
	// A runtime that did not percent-decode the query hands over "%2Fb%2F…"; accept that too.
	const route = normalizeRoute(p.route) ?? normalizeRoute(decoded(p.route));
	if (route) return route;

	const servers = (field(p, 'servers') ?? '').split(/[\s,]+/).filter((s) => /^https:\/\/[^\s/]+/.test(s));
	const sha256 = field(p, 'sha256') ?? field(p, 'x');
	const url = field(p, 'url');
	const resolved = url
		? resolveLink(url, { sha256, servers, fallback: fallbackServers })
		: sha256
			? resolveLink(sha256, { servers, fallback: fallbackServers })
			: null;
	if (!resolved || 'error' in resolved) return null;
	// View parameters travel as one field in the route's query grammar.
	const view = field(p, 'view');
	const state: ViewState = { ...decode(`#/${view ? `?${view.replace(/^\?/, '')}` : ''}`), source: resolved.source };
	state.name = field(p, 'name')?.slice(0, 200) ?? resolved.name ?? null;
	return encode(state);
}

/** The route as a convention URI another napplet can invoke: portable fields plus stepstr's full route. */
export function conventionUri(route: string): string {
	const state = decode(route);
	const params = new URLSearchParams();
	const { source } = state;
	if (source?.kind === 'blob') {
		params.set('url', `blossom:sha256:${source.sha256}`);
		if (source.servers.length) params.set('servers', source.servers.join(' '));
	} else if (source?.kind === 'url') {
		params.set('url', source.url);
	} else if (source?.kind === 'nostr') {
		params.set('url', `nostr:${source.pointer}`);
	}
	if (source && source.kind !== 'blob' && source.sha256) params.set('sha256', source.sha256);
	if (state.name) params.set('name', state.name);
	params.set('route', route.replace(/^#/, ''));
	return `${CONVENTION}?${params}`;
}
