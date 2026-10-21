import { describe, expect, it } from 'vitest';
import { fixtureCatalogue } from '$lib/catalogue/fixture';
import { decode, defaultState, encode, formatRef, isRoute, parseRef, pinned, sourceKey, type ViewState } from './hash';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const NEVENT = 'nevent1qqsrhuxx8l9ex335q7he0f09aej04zpazpl0ne2cgukyawd24mayt8gpp4mhxue69uhkummn9ekx7mqpz3mhxue69uhhyetvv9ujuerpd46hxtnfduq3gamnwvaz7tmjv4kxz7fwdehhxarj9e3xzmnyqyt8wumn8ghj7un9d3shjtnwdaehgu3wvfskueqprpmhxue69uhhyetvv9ujuam9wd6x2unwvf6xxtnrdakqzyrhwden5te0dehhxarj9emkjmn9qy88wumn8ghj7mn0wvhxcmmv9uq3uamnwvaz7tmwdaehgu3dwp6kytnhv4kxcmmjv3jhytnwv46qz9mhwden5te0wfjkccte9ec8y6tdv9kzumn9wsqs6amnwvaz7tmwdaejumr0dsq3kamnwvaz7tm5dpjkvmmjv4ehgtnwdaehgu339e3k7mgqyfmhxue69uhhyetvv9ujumt0d4hxzmnfdeuzuum0vd5kzmqpzamhxue69uhkummnw3ezumrpdejqzxrhwden5te0wfjkccte9ehx7um5wghxyctwvsq3vamnwvaz7tmjv4kxz7fwwpexjmtpdshxuet5qqsgmn3ks2hpfjyv8xfqwnlcp3lfgaey0tm6ueknquuj3ekagd24gmgl5h3nm';

describe('hash', () => {
	it.each([
		'#/',
		`#/b/${A}.step`,
		`#/b/${A}.step?xs=https%3A%2F%2Fa.example&xs=https%3A%2F%2Fb.example&sz=5053446&as=${B}&name=Seed-v15.step&hide=a3,b0&cut=x:12.5,z:-3!&ex=0.6`,
		`#/u?src=https%3A%2F%2Fraw.githubusercontent.com%2Fo%2Fr%2Fmain%2Fa%2520b.step&x=${A}&m=k3x9a1.f12.q7`,
		`#/u?src=https%3A%2F%2Fexample.com%2Fpart.stp&iso=c7&cut=y:0&cam=120,80,90;0,0,20&sel=c7&edges=0`,
		`#/n/${NEVENT}?x=${A}&cam=100,-200,150.5;0,0,80;2.5&ortho=1`,
		`#/b/${A}?m=a1.e3,a1.v0.x2`
	])('round-trips %s', (hash) => {
		expect(encode(decode(hash))).toBe(hash);
	});

	it('opens nothing on garbage', () => {
		expect(decode('#nonsense')).toEqual(defaultState());
		expect(decode('')).toEqual(defaultState());
		expect(decode('#/hammer@41')).toEqual(defaultState());
		expect(decode(`#/n/npub1${'q'.repeat(58)}`)).toEqual(defaultState());
	});

	it('only follows https links', () => {
		expect(decode('#/u?src=http%3A%2F%2Fexample.com%2Fa.step').source).toBeNull();
		expect(decode('#/u?src=javascript%3Aalert(1)').source).toBeNull();
		expect(decode('#/u?src=https%3A%2F%2Fuser%3Apw%40example.com%2Fa.step').source).toBeNull();
		expect(decode(`#/b/${A}?xs=http%3A%2F%2Fexample.com&xs=https%3A%2F%2Fok.example%2F`).source).toMatchObject({ servers: ['https://ok.example'] });
	});

	it('encodes names and links so they cannot break the grammar', () => {
		const state = { ...defaultState({ kind: 'url', url: "https://example.com/~me/part (v2)!.step" } as const), name: "part (v2)!.step" };
		const hash = encode(state);
		expect(hash).toMatch(/^#\/u\?[\w.,:;!=&%-]*$/);
		expect(decode(hash)).toMatchObject({ source: { url: 'https://example.com/~me/part%20(v2)!.step' }, name: 'part (v2)!.step' });
	});

	it('drops malformed values and keeps the rest', () => {
		const state = decode(`#/b/${A}?hide=a3,<script>&cut=x:1,w:2,y:abc&ex=7&cam=1,2;3,4,5&sel=b2&sz=-4&as=nope`);
		expect(state.hidden).toEqual([]);
		expect(state.cuts).toEqual([{ axis: 'x', offset: 1, flip: false }]);
		expect(state.explode).toBe(1);
		expect(state.camera).toBeNull();
		expect(state.selected).toBe('b2');
		expect(state.source).toEqual({ kind: 'blob', sha256: A, servers: [] });
	});

	it('keeps at most three section planes', () => {
		expect(decode(`#/b/${A}?cut=x:1,y:2,z:3,x:4`).cuts).toHaveLength(3);
	});

	it("keeps the file's up axis, Z when the link names none or an unknown one", () => {
		const state = { ...defaultState({ kind: 'blob', sha256: A, servers: [] }), up: '-y' as const };
		expect(encode(state)).toContain('up=-y');
		expect(decode(encode(state)).up).toBe('-y');
		expect(encode(defaultState({ kind: 'blob', sha256: A, servers: [] }))).not.toContain('up=');
		expect(decode(`#/b/${A}?up=w`).up).toBe('z');
		expect(decode(`#/b/${A}`).up).toBe('z');
	});

	it('rounds camera coordinates to 0.1 mm', () => {
		const state = defaultState({ kind: 'blob', sha256: A, servers: [] });
		state.camera = { position: [1.234567, 2, 3], target: [0, 0, 0.049] };
		expect(encode(state)).toBe(`#/b/${A}?cam=1.2,2,3;0,0,0`);
	});

	it('reads measured items and drops what does not parse', () => {
		const state = decode(`#/b/${A}?m=a1.x3,a1.f,a1.f-1,A1.f2,a1.f01,a1.f1234567,a1.f2.abc,b2.f7.zz`);
		expect(state.measure).toEqual([{ part: 'b2', kind: 'f', index: 7, check: 'zz' }]);
		expect(parseRef('k3x9a1.m0')).toEqual({ part: 'k3x9a1', kind: 'm', index: 0 });
		expect(formatRef({ part: 'a', kind: 'c', index: 12, check: '3b' })).toBe('a.c12.3b');
	});

	it('keeps two measured items, each once', () => {
		expect(decode(`#/b/${A}?m=a.f1,a.f1.zz,a.e2,a.v3`).measure.map(formatRef)).toEqual(['a.f1', 'a.e2']);
	});

	it('measures the assembled model', () => {
		expect(decode(`#/b/${A}?ex=0.6&m=a.f1`).explode).toBe(0);
		expect(decode(`#/b/${A}?ex=0.6`).explode).toBe(0.6);
	});

	it('writes measured items only into a route pinned to exact bytes', () => {
		const url = decode(`#/u?src=https%3A%2F%2Fexample.com%2Fa.step&x=${A}&m=a.f1`);
		expect(encode(url)).toContain('m=a.f1');
		const unpinned = { ...url, source: { kind: 'url' as const, url: 'https://example.com/a.step' } };
		expect(encode(unpinned)).toBe('#/u?src=https%3A%2F%2Fexample.com%2Fa.step');
		expect(pinned(unpinned.source)).toBe(false);
	});

	it('keys sources by content where it is known', () => {
		expect(sourceKey(decode(`#/b/${A}`).source)).toBe(`sha256:${A}`);
		expect(sourceKey(decode(`#/u?src=https%3A%2F%2Fexample.com%2Fa.step&x=${A}`).source)).toBe(`sha256:${A}`);
		expect(sourceKey(decode('#/u?src=https%3A%2F%2Fexample.com%2Fa.step').source)).toBe('url:https://example.com/a.step');
		expect(sourceKey(null)).toBeNull();
	});
});

describe('hash, on a site with a catalogue', () => {
	// Links on a site whose catalogue lists three models.
	const catalogue = fixtureCatalogue();
	const at = (hash: string) => decode(hash, catalogue);
	const model = (name: string, version?: string): ViewState => defaultState({ kind: 'catalogue', model: name, ...(version ? { version } : {}) });

	it.each([
		'#/stand',
		'#/lamp@aaaaaaa',
		'#/stand@ccc4444?hide=a3,b0&cut=x:12.5,z:-3!&ex=0.6',
		'#/lamp?iso=c7&cut=y:0&cam=120,80,90;0,0,20&sel=c7&edges=0',
		'#/stand?cam=100,-200,150.5;0,0,80;2.5&ortho=1',
		'#/stand@1111111?m=k3x9a1.f12.q7,0f2kq7.c40',
		'#/lamp@bbbbbbbfedcba9876543210fedcba9876543210f?cut=y:0&cam=120,80,90;0,0,20&sel=c7&m=a1.e3,a1.v0.x2&edges=0',
		'#/lamp@bbbbbbb?b=eeeeeee&hide=a3',
		'#/lamp@1234567',
		'#/stand?b=cad'
	])('round-trips %s', (hash) => {
		expect(encode(at(hash))).toBe(hash);
	});

	it('reads a version in lowercase, and keeps the model when the version is mistyped', () => {
		expect(at('#/stand@ccc4444').source).toEqual({ kind: 'catalogue', model: 'stand', version: 'ccc4444' });
		expect(at('#/stand@CCC4444').source).toMatchObject({ version: 'ccc4444' });
		expect(at('#/stand').source).toEqual({ kind: 'catalogue', model: 'stand' });
		expect(at('#/stand@ccc444')).toEqual(model('stand', 'ccc444'));
		expect(at('#/stand@ccc4444g?ex=0.5').source).toMatchObject({ version: 'ccc4444g' });
		expect(at(`#/stand@${'a'.repeat(41)}`)).toEqual(model('stand'));
		expect(at('#/stand@ccc44.44')).toEqual(model('stand'));
	});

	it('keeps any version from a link as written, which the catalogue resolves', () => {
		const state = at('#/stand@41?b=cad&m=a.f1');
		expect(state.source).toEqual({ kind: 'catalogue', model: 'stand', version: '41', companion: 'cad' });
		expect(state.measure.map(formatRef)).toEqual(['a.f1']);
	});

	it('reads the companion as a revision or cad, and drops anything else', () => {
		expect(at('#/lamp?b=eeeeeee').source).toMatchObject({ companion: 'eeeeeee' });
		expect(at('#/lamp@bbbbbbb?b=cad').source).toMatchObject({ companion: 'cad' });
		expect(at('#/lamp?b=latest').source).toEqual({ kind: 'catalogue', model: 'lamp' });
		expect(at('#/lamp?b=EEEEEEE').source).toEqual({ kind: 'catalogue', model: 'lamp' });
		expect(at('#/lamp').source).toEqual({ kind: 'catalogue', model: 'lamp' });
	});

	it('opens the home model on an empty route, and on garbage', () => {
		expect(at('#/')).toEqual(model('stand'));
		expect(at('#/?ortho=1&b=cad').source).toEqual({ kind: 'catalogue', model: 'stand', companion: 'cad' });
		expect(at('#/?ortho=1').ortho).toBe(true);
		expect(at('#nonsense')).toEqual(model('stand'));
		expect(at('')).toEqual(model('stand'));
		expect(at('#/anvil@ccc4444')).toEqual(model('stand'));
		expect(at('#/b')).toEqual(model('stand'));
	});

	it('drops malformed values and keeps the rest', () => {
		const state = at('#/stand?hide=a3,<script>&cut=x:1,w:2,y:abc&ex=7&cam=1,2;3,4,5&sel=b2');
		expect(state.hidden).toEqual([]);
		expect(state.cuts).toEqual([{ axis: 'x', offset: 1, flip: false }]);
		expect(state.explode).toBe(1);
		expect(state.camera).toBeNull();
		expect(state.selected).toBe('b2');
	});

	it('keeps at most three section planes', () => {
		expect(at('#/lamp?cut=x:1,y:2,z:3,x:4').cuts).toHaveLength(3);
	});

	it('rounds camera coordinates to 0.1 mm', () => {
		const state = model('lamp');
		state.camera = { position: [1.234567, 2, 3], target: [0, 0, 0.049] };
		expect(encode(state)).toBe('#/lamp?cam=1.2,2,3;0,0,0');
	});

	it('reads measured items and drops what does not parse', () => {
		const state = at('#/lamp@bbbbbbb?m=a1.x3,a1.f,a1.f-1,A1.f2,a1.f01,a1.f1234567,a1.f2.abc,b2.f7.zz');
		expect(state.measure).toEqual([{ part: 'b2', kind: 'f', index: 7, check: 'zz' }]);
	});

	it('keeps two measured items, each once', () => {
		expect(at('#/lamp@bbbbbbb?m=a.f1,a.f1.zz,a.e2,a.v3').measure.map(formatRef)).toEqual(['a.f1', 'a.e2']);
	});

	it('measures the assembled model', () => {
		expect(at('#/lamp@bbbbbbb?ex=0.6&m=a.f1').explode).toBe(0);
		expect(at('#/lamp@bbbbbbb?ex=0.6').explode).toBe(0.6);
	});

	it('reads and writes measured items only in a route that names its version', () => {
		const state = at('#/lamp@bbbbbbb?m=a.f1');
		expect(pinned(state.source)).toBe(true);
		expect(encode({ ...state, source: { kind: 'catalogue', model: 'lamp' } })).toBe('#/lamp');
		expect(at('#/lamp?m=a.f1').measure).toEqual([]);
		expect(pinned(at('#/lamp').source)).toBe(false);
	});

	it('names no file: the catalogue names its models', () => {
		expect(at('#/lamp?name=Lamp.step').name).toBeNull();
		expect(encode({ ...at('#/lamp@aaaaaaa?ortho=1'), name: 'Seed-v15.step' })).toBe('#/lamp@aaaaaaa?ortho=1');
	});

	it("opens stepstr's own heads first", () => {
		expect(at(`#/b/${A}.step?name=part.step`)).toMatchObject({ source: { kind: 'blob', sha256: A, ext: 'step' }, name: 'part.step' });
		expect(at(`#/u?src=https%3A%2F%2Fexample.com%2Fpart.stp&x=${A}`).source).toEqual({ kind: 'url', url: 'https://example.com/part.stp', sha256: A });
		expect(at(`#/n/${NEVENT}`).source).toEqual({ kind: 'nostr', pointer: NEVENT });
		// A u head without a link names no file, and is no model either.
		expect(at('#/u').source).toBeNull();
	});

	it('leaves routes as they were without a catalogue', () => {
		expect(decode('#/stand@41')).toEqual(defaultState());
		expect(decode('#/lamp')).toEqual(defaultState());
		expect(decode('#/')).toEqual(defaultState());
		expect(isRoute('#/stand')).toBe(false);
		expect(isRoute('#/stand', catalogue)).toBe(true);
		expect(isRoute('#/stand@41?cut=x:1', catalogue)).toBe(true);
		expect(isRoute('#/anvil', catalogue)).toBe(false);
	});

	it('keys a model by its version, which the app resolves to a file', () => {
		expect(sourceKey(at('#/stand@ccc4444?b=cad').source)).toBe('catalogue:stand@ccc4444?b=cad');
		expect(sourceKey(at('#/stand').source)).toBe('catalogue:stand');
	});
});
