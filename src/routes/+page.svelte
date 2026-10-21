<script lang="ts">
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import type { Catalogue } from '$lib/catalogue/catalogue';
	import App from '$lib/App.svelte';
	import { createWebHost, fetchCatalogue } from '$lib/host/web';
	import { hasCatalogue, servers } from 'virtual:stepstr-site';

	// A site with a catalogue starts the app once it has fetched it, null if it could not; one without starts at once,
	// prerendered as before.
	let catalogue = $state<Catalogue | null>();
	onMount(() => {
		if (hasCatalogue) fetchCatalogue(`${base}/catalogue.json`).then((found) => (catalogue = found));
	});
</script>

{#if !hasCatalogue}
	<App host={createWebHost(servers)} />
{:else if catalogue !== undefined}
	<App host={createWebHost(servers, catalogue ?? undefined)} />
{/if}
