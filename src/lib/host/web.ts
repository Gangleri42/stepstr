// The viewer on a plain web page: the route lives in location.hash, files and events come over the network, and the
// conversion runs in a Worker.
import { workerConverter } from '$lib/convert/web';
import { indexedDbRecent } from '$lib/recent/indexeddb';
import { conventionUri } from '$lib/state/route';
import { systemTheme } from '$lib/theme.svelte';
import { copyText } from './copy';
import type { Host, ShareLink } from './host';
import { webTransport } from './web-transport';

export function createWebHost(servers: string[]): Host {
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
				{ id: 'intent', label: 'Copy intent', hint: 'opens it in a napplet shell', text: conventionUri(route) }
			];
		},
		copy: copyText,
		async openExternal(url) {
			// With noopener the browser hands back no window, so there is nothing to check.
			window.open(url, '_blank', 'noopener,noreferrer');
			return true;
		},
		recent: indexedDbRecent()
	};
}
