// The napplet artefact (NIP-5D): a plain Vite build of the same components, everything inlined into one index.html,
// with the converter next to it as converter.txt. Not SvelteKit: its bootstrap reads location, which a srcdoc sandbox
// cannot resolve, and it loads chunks by URL.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nip5aManifest } from '@napplet/vite-plugin';
import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import { aboutModule } from './pipeline/about.ts';
import { CONVERTER_FILE, converterText } from './pipeline/converter-file.ts';
import { meshoptNoWorkers } from './pipeline/meshopt-no-workers.ts';
import { readConfig } from './pipeline/nostr/config.ts';
import { siteOrigin } from './pipeline/nostr/nsite.ts';
import { escapeAttribute, SITE, siteModule } from './pipeline/site.ts';
import { nappletRole } from './src/lib/state/archetype.ts';

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const site = readConfig(SITE.config);
const role = nappletRole(site.napplet);
const converterPath = process.env.CONVERTER_WASM ?? at('./converter/dist/converter.wasm');

export { CONVERTER_FILE };

/**
 * Build-time data. The converter does not ride inside the napplet: pipeline/napplet-manifest.ts writes it next to
 * index.html after the build, it is published as a Blossom blob of its own, and the napplet fetches it by its hash
 * through the shell when it first converts a file. The dev server serves it by URL instead. Also: where the web viewer
 * lives, the mark as the page's icon, and the napplet's declarations in the head, as NIP-5D maps them, which the
 * manifest is read from. The site's servers and catalogue come in through virtual:stepstr-site (pipeline/site.ts).
 * CONVERTER_WASM swaps in another converter.
 */
function stepstr(): Plugin {
	const id = 'virtual:stepstr';
	const resolved = `\0${id}`;
	let text: string | null = null;
	let devServer: ViteDevServer | null = null;
	const converter = () => (text ??= converterText(converterPath));
	return {
		name: 'stepstr',
		resolveId: (source) => (source === id ? resolved : null),
		configureServer(server) {
			devServer = server;
			server.middlewares.use(`/${CONVERTER_FILE}`, (_req, res) => {
				res.setHeader('content-type', 'text/plain; charset=utf-8');
				res.setHeader('access-control-allow-origin', '*');
				res.end(converter());
			});
		},
		// The mark as the page's icon, inline: a shell may show it, and a srcdoc page can load nothing by URL.
		transformIndexHtml(html) {
			const icon = readFileSync(at('./brand/icon.svg'), 'utf8').trim();
			const meta = (name: string, content: string) => `\t<meta name="${name}" content="${escapeAttribute(content)}" />\n`;
			const head = [
				meta('description', site.description),
				meta('napplet-id', site.id),
				meta('napplet-archetype', role.archetype),
				meta('napplet-intent', [role.convention, ...role.params].join(' ')),
				meta('napplet-requires', role.requires.join(' ')),
				meta('napplet-optional', role.optional.join(' ')),
				...(site.source ? [meta('napplet-source', site.source)] : []),
				...site.servers.map((server) => meta('napplet-server', server)),
				`\t<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(icon)}" />\n`
			];
			return html.replace('<title></title>', `<title>${escapeAttribute(site.title)}</title>`).replace('</head>', `${head.join('')}\t</head>`);
		},
		load(source) {
			if (source !== resolved) return null;
			const sha256 = createHash('sha256').update(converter()).digest('hex');
			// The port the dev server got, which is not the one asked for when that one was taken.
			const address = devServer?.httpServer?.address();
			const host = devServer?.config.server.host;
			const devUrl = devServer
				? `http://${typeof host === 'string' ? host : 'localhost'}:${address && typeof address === 'object' ? address.port : devServer.config.server.port}/${CONVERTER_FILE}`
				: null;
			// Share links go to the web page's own address, or to its nsite when the config names none.
			const webOrigin = site.url ?? siteOrigin(site.pubkey, site.id, site.gatewayHostnames[0]);
			return [
				`export const converter = ${JSON.stringify({ sha256, source: devUrl ?? `blossom:sha256:${sha256}` })};`,
				`export const webOrigin = ${JSON.stringify(webOrigin)};`
			].join('\n');
		}
	};
}

/** three.js loaders call fetch(); in the sandbox bytes arrive through the shell, so the network paths are cut out. */
function threeNoNetwork(): Plugin {
	const stubs: Record<string, string> = {
		'/three/src/loaders/FileLoader.js': `import { Loader } from './Loader.js';
			export class FileLoader extends Loader {
				setResponseType() { return this; }
				setMimeType() { return this; }
				load() { throw new Error('FileLoader is disabled in the napplet build'); }
			}`,
		'/three/src/loaders/ImageBitmapLoader.js': `import { Loader } from './Loader.js';
			export class ImageBitmapLoader extends Loader {
				constructor(manager) { super(manager); this.isImageBitmapLoader = true; this.options = { premultiplyAlpha: 'none' }; }
				setOptions(options) { this.options = options; return this; }
				load() { throw new Error('ImageBitmapLoader is disabled in the napplet build'); }
			}`
	};
	return {
		name: 'three-no-network',
		enforce: 'pre',
		load(id) {
			const hit = Object.keys(stubs).find((suffix) => id.endsWith(suffix));
			return hit ? stubs[hit] : null;
		}
	};
}

export default defineConfig({
	root: at('./src/napplet'),
	base: './',
	publicDir: false,
	// Its own dependency cache: shared with the web dev server's, each server's rebundling would outdate the other's.
	cacheDir: at('./node_modules/.vite-napplet'),
	resolve: {
		alias: [
			{ find: '$lib', replacement: at('./src/lib') },
			{ find: '$converter', replacement: at('./converter') },
			// The source entry, so the loader stubs above reach every internal import; three/examples/* stays as is.
			{ find: /^three$/, replacement: 'three/src/Three.js' }
		]
	},
	plugins: [
		aboutModule(converterPath),
		siteModule(),
		stepstr(),
		threeNoNetwork(),
		meshoptNoWorkers(),
		svelte({ configFile: false, preprocess: vitePreprocess(), compilerOptions: { runes: true } }),
		// For its single-file mode, which inlines everything into index.html. The manifest it writes has the shape NIP-5D
		// replaced on 2026-10-05; pipeline/napplet-manifest.ts writes the current one from the head declarations instead.
		nip5aManifest({
			nappletType: site.id,
			title: site.title,
			description: site.description,
			requires: role.requires,
			archetypes: [{ slug: role.archetype, convention: role.convention }],
			artifactMode: 'single-file'
		})
	],
	build: {
		outDir: SITE.napplet,
		emptyOutDir: true,
		modulePreload: { polyfill: false },
		sourcemap: false,
		target: 'es2022',
		// three.js and the app in one chunk; napplet-artifact.test.ts holds the real limit.
		chunkSizeWarningLimit: 2500
	},
	// Paja loads the dev server into an opaque-origin frame, which sends "Origin: null".
	server: { cors: { origin: '*' } },
	preview: { cors: { origin: '*' } }
});
