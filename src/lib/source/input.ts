// What the Open box, a paste or a drop hands over as text, turned into the route to open.
import { defaultState, encode, type RouteCatalogue } from '$lib/state/hash';
import { normalizeRoute, routeFromPayload } from '$lib/state/route';
import { resolveLink } from './links';

export function routeFromInput(text: string, fallbackServers: string[] = [], catalogue?: RouteCatalogue | null): { route: string } | { error: string } {
	const trimmed = text.trim();
	if (!trimmed) return { error: 'Paste a link to a STEP file.' };
	// A stepstr link keeps its route in the fragment.
	const hash = trimmed.indexOf('#/');
	if (hash >= 0) {
		const route = normalizeRoute(trimmed.slice(hash), catalogue);
		if (route) return { route };
	}
	// A convention URI: its query is the intent payload.
	if (trimmed.startsWith('napplet:')) {
		const query = trimmed.indexOf('?');
		const route = query > 0 ? routeFromPayload(Object.fromEntries(new URLSearchParams(trimmed.slice(query + 1))), fallbackServers, catalogue) : null;
		return route ? { route } : { error: 'That napplet link does not name a file.' };
	}
	const resolved = resolveLink(trimmed, { fallback: fallbackServers });
	if (!resolved) return { error: 'That does not look like a link to a STEP file.' };
	if ('error' in resolved) return resolved;
	return { route: encode({ ...defaultState(resolved.source), name: resolved.name ?? null }) };
}
