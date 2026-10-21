import { describe, expect, it } from 'vitest';
import { fixtureCatalogue } from '$lib/catalogue/fixture';
import { decode, encode, isRoute } from './hash';
import { CONVENTION, conventionUri, normalizeRoute, routeFromPayload } from './route';

const A = 'a'.repeat(64);

describe('route', () => {
	it('recognises the hash grammar and nothing else', () => {
		expect(isRoute('#/')).toBe(true);
		expect(isRoute(`#/b/${A}.step?xs=https%3A%2F%2Fa.example&cut=x:12.5!,z:-3&cam=1,2,3;4,5,6;2&edges=0`)).toBe(true);
		expect(isRoute(`#/b/${A}?m=k3x9a1.f12.q7,0f2kq7.c40`)).toBe(true);
		expect(isRoute('#nonsense')).toBe(false);
		expect(isRoute(`#/b/${A}?x=<script>`)).toBe(false);
		expect(isRoute(`#/b/${A}?a=b#c`)).toBe(false);
		expect(isRoute('#/b/abc')).toBe(false);
	});

	it('normalises with or without the leading hash', () => {
		expect(normalizeRoute(`/b/${A}?cut=x:12.5`)).toBe(`#/b/${A}?cut=x:12.5`);
		expect(normalizeRoute(` #/b/${A} `)).toBe(`#/b/${A}`);
		expect(normalizeRoute('javascript:alert(1)')).toBeNull();
		expect(normalizeRoute('//host/path')).toBeNull();
		expect(normalizeRoute('')).toBeNull();
		expect(normalizeRoute(42)).toBeNull();
	});

	it('round-trips through the intent convention', () => {
		const route = `#/b/${A}.step?xs=https%3A%2F%2Fa.example&name=part.step&hide=1,2f&cut=x:12.5!`;
		const uri = conventionUri(route);
		expect(uri.startsWith(`${CONVENTION}?url=blossom%3Asha256%3A${A}&servers=https%3A%2F%2Fa.example&name=part.step&route=`)).toBe(true);
		// What a runtime does with the query: percent-decode into a string-only payload.
		const payload = Object.fromEntries(new URLSearchParams(uri.slice(uri.indexOf('?') + 1)));
		expect(routeFromPayload(payload)).toBe(route);
		// Another 3d-model napplet reads the portable fields; so does stepstr without `route`.
		const { route: _, ...portable } = payload;
		expect(decode(routeFromPayload(portable)!).source).toEqual({ kind: 'blob', sha256: A, servers: ['https://a.example'] });
	});

	it('accepts a payload a runtime forgot to decode', () => {
		expect(routeFromPayload({ route: `%2Fb%2F${A}%3Fortho%3D1` })).toBe(`#/b/${A}?ortho=1`);
	});

	it('opens what stlstr sends: a url, a name, a type and a size', () => {
		const route = routeFromPayload({ url: 'https://cdn.example/files/part.step', name: 'Bracket', mime: 'model/step', size: '1234' });
		expect(decode(route!)).toMatchObject({ source: { kind: 'url', url: 'https://cdn.example/files/part.step' }, name: 'Bracket' });
		const blob = routeFromPayload({ url: `https://cdn.example/${A}.step`, sha256: A }, ['https://fallback.example']);
		expect(decode(blob!).source).toEqual({ kind: 'blob', sha256: A, ext: 'step', servers: ['https://cdn.example', 'https://fallback.example'] });
	});

	it('takes view parameters in the route grammar', () => {
		const route = routeFromPayload({ url: `blossom:sha256:${A}`, servers: 'https://a.example https://b.example', view: 'cut=x:1&ortho=1' });
		expect(route).toBe(encode({ ...decode(`#/b/${A}?cut=x:1&ortho=1`), source: { kind: 'blob', sha256: A, servers: ['https://a.example', 'https://b.example'] } }));
	});

	it('ignores payloads that name nothing it can open', () => {
		expect(routeFromPayload({ url: 'http://example.com/a.step' })).toBeNull();
		expect(routeFromPayload({ url: 'ftp://example.com/a.step' })).toBeNull();
		expect(routeFromPayload({ model: 'seed' })).toBeNull();
		expect(routeFromPayload({})).toBeNull();
		expect(routeFromPayload(null)).toBeNull();
		expect(routeFromPayload('#/b/x')).toBeNull();
	});
});

describe('route, on a site with a catalogue', () => {
	// Routes and payloads on a site whose catalogue lists three models.
	const catalogue = fixtureCatalogue();

	it('recognises the hash grammar and nothing else', () => {
		expect(isRoute('#/stand', catalogue)).toBe(true);
		expect(isRoute('#/stand@ccc4444?hide=a3,b0&cut=x:12.5!,z:-3&cam=1,2,3;4,5,6;2&edges=0', catalogue)).toBe(true);
		expect(isRoute('#/stand@ccc4444?m=k3x9a1.f12.q7,0f2kq7.c40', catalogue)).toBe(true);
		expect(isRoute('#nonsense', catalogue)).toBe(false);
		expect(isRoute('#/stand?x=<script>', catalogue)).toBe(false);
		expect(isRoute('#/stand?a=b#c', catalogue)).toBe(false);
		expect(isRoute(`#/b/${A}?cut=x:1`, catalogue)).toBe(true);
	});

	it('normalises with or without the leading hash', () => {
		expect(normalizeRoute('/stand@ccc4444?cut=x:12.5', catalogue)).toBe('#/stand@ccc4444?cut=x:12.5');
		expect(normalizeRoute(' #/lamp ', catalogue)).toBe('#/lamp');
		expect(normalizeRoute('/lamp')).toBeNull();
		expect(normalizeRoute('javascript:alert(1)', catalogue)).toBeNull();
		expect(normalizeRoute('//host/path', catalogue)).toBeNull();
		expect(normalizeRoute('', catalogue)).toBeNull();
		expect(normalizeRoute(42, catalogue)).toBeNull();
	});

	it('round-trips through the intent convention, with the model and version as fields of their own', () => {
		const route = '#/stand@ccc4444?hide=1,2f&cut=x:12.5!';
		const uri = conventionUri(route, catalogue);
		expect(uri).toBe(`${CONVENTION}?model=stand&version=ccc4444&route=%2Fstand%40ccc4444%3Fhide%3D1%2C2f%26cut%3Dx%3A12.5%21`);
		// What a runtime does with the query: percent-decode into a string-only payload.
		const payload = Object.fromEntries(new URLSearchParams(uri.slice(uri.indexOf('?') + 1)));
		expect(routeFromPayload(payload, [], catalogue)).toBe(route);
		expect(encode(decode(routeFromPayload(payload, [], catalogue)!, catalogue))).toBe(route);
		// Another napplet of the site's role reads the model and version.
		const { route: _, ...portable } = payload;
		expect(routeFromPayload(portable, [], catalogue)).toBe('#/stand@ccc4444');
		expect(conventionUri('#/lamp', catalogue)).toBe(`${CONVENTION}?model=lamp&route=%2Flamp`);
	});

	it('accepts a payload a runtime forgot to decode', () => {
		expect(routeFromPayload({ route: '%2Flamp%40aaaaaaa%3Fortho%3D1' }, [], catalogue)).toBe('#/lamp@aaaaaaa?ortho=1');
	});

	it('falls back to model and version fields', () => {
		expect(routeFromPayload({ model: 'Lamp', version: 'AAAAAAA' }, [], catalogue)).toBe('#/lamp@aaaaaaa');
		expect(routeFromPayload({ model: 'lamp', version: 'four' }, [], catalogue)).toBe('#/lamp');
		expect(routeFromPayload({ model: 'lamp', version: 'aaaaaa' }, [], catalogue)).toBe('#/lamp');
		expect(routeFromPayload({ model: 'lamp', version: '4' }, [], catalogue)).toBe('#/lamp');
		expect(routeFromPayload({ model: 'lamp', view: 'cut=x:1&ortho=1' }, [], catalogue)).toBe('#/lamp?cut=x:1&ortho=1');
		expect(routeFromPayload({ model: 4 }, [], catalogue)).toBeNull();
		expect(routeFromPayload({ model: 'anvil' }, [], catalogue)).toBeNull();
		expect(routeFromPayload({}, [], catalogue)).toBeNull();
		expect(routeFromPayload(null, [], catalogue)).toBeNull();
		expect(routeFromPayload('#/lamp', [], catalogue)).toBeNull();
	});

	it("still opens stepstr's own payloads", () => {
		expect(routeFromPayload({ url: `blossom:sha256:${A}` }, [], catalogue)).toBe(`#/b/${A}`);
		expect(routeFromPayload({ route: `/b/${A}?ortho=1` }, [], catalogue)).toBe(`#/b/${A}?ortho=1`);
	});
});
