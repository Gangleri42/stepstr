/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
// Offline use of the web page. On install the worker caches this build's page, code, converter and icons under the
// build's version and serves them from that cache. Navigations try the network first, so a new deploy shows when
// online, and fall back to the cached page offline. Only same-origin requests are handled: files people open from
// Blossom, GitHub or relays go to the network as before, and the page keeps converted models in IndexedDB itself.
import { build, files, prerendered, version } from '$service-worker';

// The webworker library types `self` as a plain worker scope; this file runs as a service worker.
const worker = self as unknown as ServiceWorkerGlobalScope;

const CACHE = `stepstr-${version}`;
const ASSETS = [...build, ...files, ...prerendered];
const PATHS = new Set(ASSETS);
/** The page itself; the site has one, prerendered at the root of its base path beside the web app manifest. */
const PAGE = prerendered.find((path) => !path.endsWith('.webmanifest'));

worker.addEventListener('install', (event) => {
	event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

// Caches of earlier builds go once this one is active.
worker.addEventListener('activate', (event) => {
	event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
});

const cached = async (path: string) => (await caches.open(CACHE)).match(path);

worker.addEventListener('fetch', (event) => {
	const { request } = event;
	const url = new URL(request.url);
	if (request.method !== 'GET' || url.origin !== worker.location.origin) return;
	if (request.mode === 'navigate') {
		event.respondWith(fetch(request).catch(async () => (PAGE && (await cached(PAGE))) || Response.error()));
	} else if (PATHS.has(url.pathname)) {
		event.respondWith(cached(url.pathname).then((hit) => hit ?? fetch(request)));
	}
});
