<script lang="ts">
	import { onMount } from 'svelte';
	import { dev } from '$app/environment';
	import { base } from '$app/paths';
	import '$lib/styles/tokens.css';

	let { children } = $props();

	// The service worker (src/service-worker.ts) makes the page work offline. It is registered after the page has
	// loaded, so its downloads do not compete with the first visit, and never in development, where a worker left on
	// localhost would serve stale files to whatever runs on that port next. A browser that refuses it gets the page as
	// before.
	onMount(() => {
		if (dev || !('serviceWorker' in navigator)) return;
		const register = () => void navigator.serviceWorker.register(`${base}/service-worker.js`).catch(() => undefined);
		if (document.readyState === 'complete') register();
		else addEventListener('load', register, { once: true });
	});
</script>

<svelte:head>
	<title>stepstr</title>
</svelte:head>

{@render children()}
