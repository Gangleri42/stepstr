<script lang="ts">
	import { onMount } from 'svelte';
	import { base } from '$app/paths';
	import App from '$lib/App.svelte';
	import { createWebHost, fetchCatalogue, type FetchedCatalogue } from '$lib/host/web';
	import { hasCatalogue, servers } from 'virtual:stepstr-site';

	// A site with a catalogue starts the app once it has fetched it, or found why it could not; one without starts at
	// once, prerendered as before.
	let fetched = $state<FetchedCatalogue>();
	onMount(() => {
		if (hasCatalogue) fetchCatalogue(`${base}/catalogue.json`).then((found) => (fetched = found));
	});
</script>

{#if !hasCatalogue}
	<App host={createWebHost(servers)} />
{:else if fetched}
	<App host={createWebHost(servers, fetched.catalogue ?? undefined, fetched.problem)} />
{/if}
