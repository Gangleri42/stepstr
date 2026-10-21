// The web app manifest, named and described after the site (pipeline/site.ts) and written when the page is
// prerendered. The icons are stepstr's mark, whatever the site.
import { description, title } from 'virtual:stepstr-site';

export const prerender = true;

const text = (value: string) => JSON.stringify(value);

export const GET = () =>
	new Response(
		`{
	"name": ${text(title)},
	"short_name": ${text(title)},
	"description": ${text(description)},
	"start_url": "./",
	"scope": "./",
	"display": "standalone",
	"background_color": "#121211",
	"theme_color": "#121211",
	"icons": [
		{ "src": "icon.svg", "type": "image/svg+xml", "sizes": "any", "purpose": "any" },
		{ "src": "icon-192.png", "type": "image/png", "sizes": "192x192", "purpose": "any" },
		{ "src": "icon-512.png", "type": "image/png", "sizes": "512x512", "purpose": "any" },
		{ "src": "icon-maskable-512.png", "type": "image/png", "sizes": "512x512", "purpose": "maskable" }
	]
}
`,
		{ headers: { 'content-type': 'application/manifest+json' } }
	);
