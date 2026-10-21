// The viewer inside a NIP-5D shell. There is no URL: routes come in as intents and go out as share links; bytes and
// events come from the shell; the converter runs on the page's own thread; the shell opens external links and reports
// its theme.
import type { Catalogue } from '$lib/catalogue/catalogue';
import type { Converter } from '$lib/convert/types';
import { nappletRecent } from '$lib/recent/napplet';
import { conventionUri } from '$lib/state/route';
import { isDarkColor, systemTheme, type ThemeInfo, type ThemeSource } from '$lib/theme.svelte';
import { copyText } from './copy';
import type { Host, ShareLink, Transport } from './host';
import { inbox } from './napplet-inbox';
import { close, has, type ShellTheme } from './napplet-runtime';
import { nappletTransport, pickWithShell } from './napplet-transport';

const HEX = /^#[0-9a-f]{6}$/i;

/** The system scheme until the shell reports its colours, and the shell's colours from then on. */
const shellTheme: ThemeSource = {
	watch(apply) {
		let stopSystem: (() => void) | null = systemTheme.watch(apply);
		const endSystem = () => {
			stopSystem?.();
			stopSystem = null;
		};
		const shell = has('theme', 'get', 'onChanged');
		if (!shell) return endSystem;
		const fromShell = (theme: ShellTheme | undefined) => {
			const colors = theme?.colors;
			if (!colors?.background || !HEX.test(colors.background)) return;
			// A change of the system scheme would otherwise wipe the shell's colours.
			endSystem();
			const info: ThemeInfo = { dark: isDarkColor(colors.background), colors };
			apply(info);
		};
		shell.get().then(fromShell, () => undefined);
		const handle = shell.onChanged(fromShell);
		return () => {
			endSystem();
			close(handle);
		};
	}
};

export type NappletHostOptions = {
	converter: Converter;
	/** Blossom servers to try for blobs no link names servers for. */
	servers: string[];
	/** Where the web viewer lives; share links point there. */
	webOrigin: string | null;
	transport?: Transport;
	/** The site's catalogue, which the napplet carries. */
	catalogue?: Catalogue;
};

export function createNappletHost({ converter, servers, webOrigin, transport = nappletTransport(), catalogue }: NappletHostOptions): Host {
	const storage = has('storage', 'getItem', 'setItem', 'removeItem');
	return {
		initialRoute: () => inbox.latest ?? '',
		onRoute: (listener) => inbox.subscribe(listener),
		// The shell owns the address bar; the route only leaves through share links and intents.
		publishRoute() {},
		transport,
		converter,
		servers,
		theme: shellTheme,
		shareLinks(route): ShareLink[] {
			const links: ShareLink[] = [];
			if (webOrigin) links.push({ id: 'web', label: 'Copy link', hint: 'the web viewer', text: `${webOrigin}/${route}` });
			links.push({ id: 'intent', label: 'Copy intent', hint: 'opens this view in a napplet shell', text: conventionUri(route) });
			return links;
		},
		copy: copyText,
		async openExternal(url, label) {
			const link = has('link', 'open');
			if (!link) return false;
			try {
				const result = await link.open(url, { label });
				return result?.status !== 'denied';
			} catch {
				return false;
			}
		},
		...(has('fs', 'pickFile', 'read') ? { pickFile: pickWithShell } : {}),
		...(storage ? { recent: nappletRecent(storage) } : {}),
		...(webOrigin ? { webViewer: (route: string) => `${webOrigin}/${route}` } : {}),
		catalogue
	};
}
