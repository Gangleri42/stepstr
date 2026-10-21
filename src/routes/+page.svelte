<script lang="ts">
	import App from '$lib/App.svelte';
	import { createWebHost } from '$lib/host/web';
	import { servers } from 'virtual:stepstr-site';
</script>

<App host={createWebHost(servers)} />
