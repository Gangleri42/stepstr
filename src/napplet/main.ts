// Entry of the napplet artefact: one HTML file with everything inlined, mounted inside a shell's sandboxed frame. The
// converter comes separately, through the shell, the first time a file is opened.
import '$lib/styles/tokens.css';
import { mount } from 'svelte';
import App from '$lib/App.svelte';
import { converterFetcher } from '$lib/convert/converter-source';
import { mainThreadConverter } from '$lib/convert/main-thread';
import { createNappletHost } from '$lib/host/napplet';
import { openInbox } from '$lib/host/napplet-inbox';
import { nappletTransport } from '$lib/host/napplet-transport';
import { converter, servers, webOrigin } from 'virtual:stepstr';

// Subscribe before anything heavy runs: the shell may deliver the opening intent right away.
openInbox(servers);

const transport = nappletTransport();
mount(App, {
	target: document.getElementById('app')!,
	props: { host: createNappletHost({ converter: mainThreadConverter(converterFetcher(transport, converter, servers)), servers, webOrigin, transport }) }
});
