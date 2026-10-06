<script lang="ts">
	import App from '$lib/App.svelte';
	import { createWebHost } from '$lib/host/web';
	import site from '../../.nsite/config.json';
</script>

<App host={createWebHost(site.servers)} />
