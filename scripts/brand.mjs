// Renders the raster icons in static/ from the vector sources in brand/: favicon.ico (the flat glyph at 16 px, the
// mark at 32 and 48), the touch and app icons, and a copy of the mark as icon.svg. Run after changing brand/:
//   node scripts/brand.mjs
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const source = (name) => readFileSync(new URL(`../brand/${name}`, import.meta.url), 'utf8');
const out = (name) => new URL(`../static/${name}`, import.meta.url);

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

/** One SVG rendered at size x size, transparent where the SVG draws nothing. */
async function png(svg, size) {
	const sized = svg.replace(/width="[^"]*" height="[^"]*"/, `width="${size}" height="${size}"`);
	await page.setViewportSize({ width: size, height: size });
	await page.setContent(`<html><body style="margin:0;background:transparent">${sized}</body></html>`);
	return page.locator('svg').screenshot({ omitBackground: true });
}

/** An ICO file holding PNG images, one per size (Windows Vista and later, and every browser, read these). */
function ico(images) {
	const header = Buffer.alloc(6 + 16 * images.length);
	header.writeUInt16LE(0, 0);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(images.length, 4);
	let offset = header.length;
	images.forEach(({ size, data }, i) => {
		const entry = 6 + 16 * i;
		header.writeUInt8(size >= 256 ? 0 : size, entry);
		header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
		header.writeUInt16LE(1, entry + 4);
		header.writeUInt16LE(32, entry + 6);
		header.writeUInt32LE(data.length, entry + 8);
		header.writeUInt32LE(offset, entry + 12);
		offset += data.length;
	});
	return Buffer.concat([header, ...images.map((image) => image.data)]);
}

const icon = source('icon.svg');
const square = source('icon-square.svg');
const glyph = source('glyph.svg');

writeFileSync(out('favicon.ico'), ico([
	{ size: 16, data: await png(glyph, 16) },
	{ size: 32, data: await png(icon, 32) },
	{ size: 48, data: await png(icon, 48) }
]));
// iOS rounds the corners itself and wants no transparency.
writeFileSync(out('apple-touch-icon.png'), await png(square, 180));
writeFileSync(out('icon-192.png'), await png(icon, 192));
writeFileSync(out('icon-512.png'), await png(icon, 512));
// Maskable: the platform cuts its own shape out of a full square; the mark stays inside the safe zone.
writeFileSync(out('icon-maskable-512.png'), await png(square, 512));
copyFileSync(new URL('../brand/icon.svg', import.meta.url), out('icon.svg'));

await browser.close();
console.log('static/: favicon.ico apple-touch-icon.png icon-192.png icon-512.png icon-maskable-512.png icon.svg');
