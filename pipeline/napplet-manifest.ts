// After the napplet build. The converter goes next to index.html, to be published as a Blossom blob of its own: the
// napplet fetches it by the hash the build embedded. The manifest template (NIP-5D as of 2026-10-05) is read from the
// declarations the build wrote into the page's head, and names the page by its sha256. The napplet Vite plugin's
// single-file mode allows no other file in the output, so this runs after it, and its own manifest goes. Signing
// happens later, at publishing.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { CONVERTER_FILE, converterText } from './converter-file.ts';
import { readConfig } from './nostr/config.ts';
import { NAPPLET_TEMPLATE, nappletDeclarations, nappletTemplate, sha256, validate } from './nostr/manifest.ts';

const dir = 'dist-napplet';

const text = converterText(process.env.CONVERTER_WASM ?? 'converter/dist/converter.wasm');
const converter = sha256(text);
const html = readFileSync(`${dir}/index.html`);
if (!html.toString('utf8').includes(`blossom:sha256:${converter}`)) {
	throw new Error(`${dir}/index.html names another converter than converter/dist has now; build the napplet again`);
}
writeFileSync(`${dir}/${CONVERTER_FILE}`, text);
rmSync(`${dir}/.nip5a-manifest.json`, { force: true });

const declared = nappletDeclarations(html.toString('utf8'));
const id = readConfig().id;
if (declared.id !== id) throw new Error(`${dir}/index.html declares the napplet "${declared.id}", .nsite/config.json the site "${id}"`);
const template = nappletTemplate({ ...declared, artifact: sha256(html), created_at: 0 });
validate(template);
writeFileSync(`${dir}/${NAPPLET_TEMPLATE}`, `${JSON.stringify(template, null, 2)}\n`);
console.log(`${dir}/index.html: sha256 ${sha256(html)}; ${dir}/${CONVERTER_FILE}: ${text.length} bytes, sha256 ${converter}`);
