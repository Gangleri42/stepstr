// The viewer on a plain web page: the route lives in location.hash, files and events come over the network, and the
// conversion runs in a Worker.
import { parseCatalogue, type Catalogue } from '$lib/catalogue/catalogue';
import { workerConverter } from '$lib/convert/web';
import { indexedDbRecent } from '$lib/recent/indexeddb';
import { conventionUri } from '$lib/state/route';
import { systemTheme } from '$lib/theme.svelte';
import { copyText } from './copy';
import type { Host, ShareLink } from './host';
import { webTransport } from './web-transport';

/** A site's catalogue as the page got it, or why it has none. */
export type FetchedCatalogue = { catalogue: Catalogue; problem?: undefined } | { catalogue: null; problem: string };

/**
 * The site's catalogue.json, fetched before the app starts. It goes to the network each time (the service worker keeps
 * a copy for offline use), so a new publish shows at once. When it cannot be had or is not valid, the page opens files
 * as any stepstr does, and the app says why.
 */
export async function fetchCatalogue(url: string): Promise<FetchedCatalogue> {
	let problem: string;
	try {
		const response = await fetch(url, { cache: 'no-cache' });
		if (response.ok) return { catalogue: parseCatalogue(await response.json()) };
		problem = `${response.status} ${response.statusText}`.trim();
	} catch (err) {
		problem = err instanceof Error ? err.message : String(err);
	}
	console.warn(`${url}: ${problem}`);
	return { catalogue: null, problem };
}

export function createWebHost(servers: string[], catalogue?: Catalogue, catalogueProblem?: string): Host {
	return {
		initialRoute: () => location.hash,
		onRoute(listener) {
			const onHash = () => listener(location.hash);
			addEventListener('hashchange', onHash);
			return () => removeEventListener('hashchange', onHash);
		},
		publishRoute(route) {
			// replaceState: moving the camera must not pile up history entries.
			if (location.hash !== route) history.replaceState(history.state, '', route);
		},
		transport: webTransport(),
		converter: workerConverter(),
		servers,
		theme: systemTheme,
		shareLinks(route): ShareLink[] {
			return [
				{ id: 'web', label: 'Copy link', hint: 'opens this view here', text: `${location.origin}${location.pathname}${route}` },
				{ id: 'intent', label: 'Copy intent', hint: 'opens it in a napplet shell', text: conventionUri(route, catalogue) }
			];
		},
		copy: copyText,
		async openExternal(url) {
			// With noopener the browser hands back no window, so there is nothing to check.
			window.open(url, '_blank', 'noopener,noreferrer');
			return true;
		},
		recent: indexedDbRecent(),
		catalogue,
		catalogueProblem
	};
}
