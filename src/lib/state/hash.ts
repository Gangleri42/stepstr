// The whole view lives in the URL hash so a link reproduces it: the file it shows, then how it is shown.
//   #/b/<sha256>.step?xs=<server>&sz=5053446&name=Seed-v15.step&hide=a3,b0&cut=x:12.5!&cam=12.1,-300,250;0,0,80&m=k3x9a1.f12.q7
//   #/u?src=<https url>&x=<sha256>&iso=c7        a file at a URL, pinned to its bytes by x
//   #/n/<nevent1…>?x=<sha256>                     a file a Nostr event points at
//   #/                                            nothing open yet
// A site with a catalogue (src/lib/catalogue) names its own models after those heads, and opens its home model on an
// empty route:
//   #/lamp@aaaaaaa?b=1111111&hide=a3             a model at a version, with a companion revision (or b=cad)
//   #/lamp                                        its latest version
// Unknown keys are ignored, so old links survive new features.

export type Axis = 'x' | 'y' | 'z';
export type Cut = { axis: Axis; offset: number; flip: boolean };
export type Camera = { position: [number, number, number]; target: [number, number, number]; zoom?: number };

/**
 * Where the file comes from. A Blossom blob is named by its hash; the others are pinned to their bytes by `sha256`. A
 * catalogue model is pinned by its version, which the catalogue ties to a STEP file's hash: a version, as written in
 * the link (a commit id, or more of the commit), and a companion, `cad` or a revision.
 */
export type Source =
	| { kind: 'blob'; sha256: string; ext?: string; servers: string[]; size?: number; author?: string }
	| { kind: 'url'; url: string; sha256?: string }
	| { kind: 'nostr'; pointer: string; sha256?: string }
	| { kind: 'catalogue'; model: string; version?: string; companion?: string };

/** A source that names a file itself; a catalogue model becomes one once the catalogue says which file it is. */
export type FileSource = Exclude<Source, { kind: 'catalogue' }>;

/** What a route needs of a site's catalogue: the models it names, and the one an empty route opens. */
export type RouteCatalogue = { home: string; models: Record<string, unknown> };

/**
 * One measured item: a face (f), edge (e) or vertex (v) of a body, or the centre (c) or midpoint (m) of an edge, by
 * its number in the file's measurement data. `check` is two characters derived from the item's size: a link whose
 * numbers point at something else after a rebuild drops the item instead of measuring the wrong thing.
 */
export type MeasureKind = 'f' | 'e' | 'v' | 'c' | 'm';
export type MeasureRef = { part: string; kind: MeasureKind; index: number; check?: string };

/** The file's axis that points up in the view. Most CAD files are modelled Z up; some are Y up. */
export type UpAxis = 'z' | 'y' | 'x' | '-z' | '-y' | '-x';
/** In the order the Up button steps through them. */
export const UP_AXES: UpAxis[] = ['z', 'y', 'x', '-z', '-y', '-x'];
const isUpAxis = (text: string | null): text is UpAxis => UP_AXES.some((axis) => axis === text);

export type ViewState = {
	source: Source | null;
	/** The file's name, for the title and for links. */
	name: string | null;
	hidden: string[];
	isolated: string[];
	cuts: Cut[];
	explode: number;
	camera: Camera | null;
	selected: string | null;
	/** At most two; they only mean something for exact bytes, so a route carries them only when its source is pinned. */
	measure: MeasureRef[];
	edges: boolean;
	ortho: boolean;
	up: UpAxis;
};

export function defaultState(source: Source | null = null): ViewState {
	return {
		source,
		name: null,
		hidden: [],
		isolated: [],
		cuts: [],
		explode: 0,
		camera: null,
		selected: null,
		measure: [],
		edges: true,
		ortho: false,
		up: 'z'
	};
}

/** Whether the source names exact bytes, so measured items and part ids in a link keep their meaning. */
export const pinned = (source: Source | null) =>
	!!source && (source.kind === 'blob' || (source.kind === 'catalogue' ? !!source.version : !!source.sha256));

/** A stable key for a source: two routes with the same key show the same file. */
export function sourceKey(source: Source): string;
export function sourceKey(source: Source | null): string | null;
export function sourceKey(source: Source | null): string | null {
	if (!source) return null;
	switch (source.kind) {
		case 'blob':
			return `sha256:${source.sha256}`;
		case 'url':
			return source.sha256 ? `sha256:${source.sha256}` : `url:${source.url}`;
		case 'nostr':
			return source.sha256 ? `sha256:${source.sha256}` : `nostr:${source.pointer}`;
		case 'catalogue':
			return `catalogue:${source.model}${source.version ? `@${source.version}` : ''}${source.companion ? `?b=${source.companion}` : ''}`;
	}
}

const MEASURE_REF = /^([0-9a-z]+)\.([fevcm])(0|[1-9]\d{0,5})(?:\.([0-9a-z]{2}))?$/;

export function parseRef(token: string): MeasureRef | null {
	const match = MEASURE_REF.exec(token);
	if (!match) return null;
	const ref: MeasureRef = { part: match[1], kind: match[2] as MeasureKind, index: Number(match[3]) };
	if (match[4]) ref.check = match[4];
	return ref;
}

export const formatRef = (ref: MeasureRef) => `${ref.part}.${ref.kind}${ref.index}${ref.check ? `.${ref.check}` : ''}`;
export const sameRef = (a: MeasureRef, b: MeasureRef) => a.part === b.part && a.kind === b.kind && a.index === b.index;

const round = (v: number, step: number) => Math.round(v / step) * step;
const num = (v: number, step = 0.1) => String(Number(round(v, step).toFixed(3)));
const ID_LIST = /^[0-9a-z]+(,[0-9a-z]+)*$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX64_KEY = /^[0-9a-f]{64}$/i;
const COMPANION = /^(cad|[0-9a-f]{7})$/;

/** Percent-encodes everything but letters, digits and "-_.", so values never collide with the grammar's own signs. */
const component = (text: string) => encodeURIComponent(text).replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function encode(state: ViewState): string {
	const params: string[] = [];
	const { source } = state;
	let head = '#/';
	if (source?.kind === 'blob') {
		head = `#/b/${source.sha256}${source.ext ? `.${source.ext}` : ''}`;
		for (const server of source.servers) params.push(`xs=${component(server)}`);
		if (source.size) params.push(`sz=${source.size}`);
		if (source.author) params.push(`as=${source.author}`);
	} else if (source?.kind === 'url') {
		head = '#/u';
		params.push(`src=${component(source.url)}`);
		if (source.sha256) params.push(`x=${source.sha256}`);
	} else if (source?.kind === 'nostr') {
		head = `#/n/${source.pointer}`;
		if (source.sha256) params.push(`x=${source.sha256}`);
	} else if (source?.kind === 'catalogue') {
		head = `#/${source.model}${source.version ? `@${source.version}` : ''}`;
		if (source.companion) params.push(`b=${source.companion}`);
	}
	// A catalogue names its models itself.
	if (state.name && source?.kind !== 'catalogue') params.push(`name=${component(state.name)}`);
	if (state.hidden.length) params.push(`hide=${state.hidden.join(',')}`);
	if (state.isolated.length) params.push(`iso=${state.isolated.join(',')}`);
	if (state.cuts.length) {
		params.push(`cut=${state.cuts.map((c) => `${c.axis}:${num(c.offset)}${c.flip ? '!' : ''}`).join(',')}`);
	}
	if (state.explode > 0) params.push(`ex=${num(state.explode, 0.01)}`);
	if (state.camera) {
		const { position: p, target: t, zoom } = state.camera;
		params.push(`cam=${p.map((v) => num(v)).join(',')};${t.map((v) => num(v)).join(',')}${zoom ? `;${num(zoom, 0.01)}` : ''}`);
	}
	if (state.selected) params.push(`sel=${state.selected}`);
	if (state.measure.length && pinned(source)) params.push(`m=${state.measure.map(formatRef).join(',')}`);
	if (!state.edges) params.push('edges=0');
	if (state.ortho) params.push('ortho=1');
	if (state.up !== 'z') params.push(`up=${state.up}`);
	return params.length ? `${head}?${params.join('&')}` : head;
}

function triple(text: string | undefined): [number, number, number] | null {
	const parts = text?.split(',').map(Number);
	return parts?.length === 3 && parts.every(Number.isFinite) ? (parts as [number, number, number]) : null;
}

// NIP-19 bech32: the entities that can point at an event carrying a file.
const POINTER = /^(?:note|nevent|naddr)1[02-9ac-hj-np-z]{6,}$/;
const ROUTE = /^#\/(?:b\/([0-9a-f]{64})(?:\.([a-z0-9]{1,8}))?|(u)|n\/([0-9a-z]+))?(?:\?(.*))?$/i;
// Any version is kept as written, in lowercase: one the catalogue does not list opens the latest, and says so.
// `@latest`, and an `@` with nothing after it, name no version: the newest opens, as for the model alone.
const MODEL_ROUTE = /^#\/([a-z0-9-]+)(?:@([0-9a-z]{0,40}))?(?:\?(.*))?$/i;
const QUERY = /^[\w.,:;!=&%-]*$/;

/** A route that names a model the catalogue lists: the model, the version as written and the query. */
function modelRoute(hash: string, catalogue: RouteCatalogue | null | undefined) {
	const match = catalogue ? MODEL_ROUTE.exec(hash) : null;
	if (!catalogue || !match || !Object.hasOwn(catalogue.models, match[1].toLowerCase())) return null;
	const version = match[2]?.toLowerCase();
	return { model: match[1].toLowerCase(), version: version && version !== 'latest' ? version : undefined, query: match[3] };
}

/**
 * Whether the text has the shape of a route: a source head and a query made of the grammar's characters. With a
 * catalogue, a model it lists is a head too.
 */
export function isRoute(hash: string, catalogue?: RouteCatalogue | null) {
	const match = ROUTE.exec(hash);
	if (match) return (!match[4] || POINTER.test(match[4].toLowerCase())) && (match[5] === undefined || QUERY.test(match[5]));
	const named = modelRoute(hash, catalogue);
	return !!named && (named.query === undefined || QUERY.test(named.query));
}

/** An https URL, or null: the only scheme a `u` route may point at. */
function httpsUrl(text: string | null) {
	if (!text) return null;
	try {
		const url = new URL(text);
		return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
	} catch {
		return null;
	}
}

/**
 * The view a route describes. Values that do not parse are dropped one by one, so a hand-edited link keeps the rest.
 * With a catalogue, a route stepstr's heads do not take may name one of its models, and a route that names no file,
 * or nothing that parses, opens its home model.
 */
export function decode(hash: string, catalogue?: RouteCatalogue | null): ViewState {
	const match = ROUTE.exec(hash);
	const home = catalogue ? { kind: 'catalogue' as const, model: catalogue.home } : null;
	if (!match) {
		const named = modelRoute(hash, catalogue);
		if (!named) return defaultState(home);
		const params = new URLSearchParams(named.query ?? '');
		return view(params, catalogueSource(named.model, named.version, params));
	}
	const params = new URLSearchParams(match[5] ?? '');
	if (home && !match[1] && !match[3] && !match[4]) return view(params, catalogueSource(home.model, undefined, params));
	const x = params.get('x');
	const pin = x && HEX64_KEY.test(x) ? { sha256: x.toLowerCase() } : {};
	let source: Source | null = null;
	if (match[1]) {
		const servers = params.getAll('xs').map(httpsUrl).filter((s): s is string => !!s).map((s) => s.replace(/\/+$/, ''));
		const size = Number(params.get('sz'));
		const author = params.get('as');
		source = { kind: 'blob', sha256: match[1].toLowerCase(), servers };
		if (match[2]) source.ext = match[2].toLowerCase();
		if (Number.isSafeInteger(size) && size > 0) source.size = size;
		if (author && HEX64.test(author)) source.author = author;
	} else if (match[3]) {
		const url = httpsUrl(params.get('src'));
		if (url) source = { kind: 'url', url, ...pin };
	} else if (match[4] && POINTER.test(match[4].toLowerCase())) {
		source = { kind: 'nostr', pointer: match[4].toLowerCase(), ...pin };
	}
	return view(params, source);
}

function catalogueSource(model: string, version: string | undefined, params: URLSearchParams): Source {
	const companion = params.get('b');
	return { kind: 'catalogue', model, ...(version ? { version } : {}), ...(companion && COMPANION.test(companion) ? { companion } : {}) };
}

/** The view around a source: how a route's query says it is shown. */
function view(params: URLSearchParams, source: Source | null): ViewState {
	const state = defaultState(source);
	const name = params.get('name')?.trim();
	if (name && source?.kind !== 'catalogue') state.name = name.slice(0, 200);

	const ids = (key: string) => {
		const value = params.get(key);
		return value && ID_LIST.test(value) ? value.split(',') : [];
	};
	state.hidden = ids('hide');
	state.isolated = ids('iso');

	for (const part of params.get('cut')?.split(',') ?? []) {
		const cut = /^([xyz]):(-?\d+(?:\.\d+)?)(!?)$/.exec(part);
		if (cut && state.cuts.length < 3) state.cuts.push({ axis: cut[1] as Axis, offset: Number(cut[2]), flip: cut[3] === '!' });
	}

	const explode = Number(params.get('ex'));
	if (Number.isFinite(explode)) state.explode = Math.min(1, Math.max(0, explode));

	const [p, t, z] = params.get('cam')?.split(';') ?? [];
	const position = triple(p), target = triple(t);
	if (position && target) {
		state.camera = { position, target };
		if (z && Number(z) > 0) state.camera.zoom = Number(z);
	}

	const selected = params.get('sel');
	if (selected && /^[0-9a-z]+$/.test(selected)) state.selected = selected;

	// Measured items name faces and edges of exact bytes: a route that names no hash cannot carry them.
	for (const token of pinned(source) ? (params.get('m')?.split(',') ?? []) : []) {
		const ref = parseRef(token);
		if (ref && state.measure.length < 2 && !state.measure.some((r) => sameRef(r, ref))) state.measure.push(ref);
	}
	// Measurements are taken on the assembled model.
	if (state.measure.length) state.explode = 0;
	state.edges = params.get('edges') !== '0';
	state.ortho = params.get('ortho') === '1';
	const up = params.get('up');
	if (isUpAxis(up)) state.up = up;
	return state;
}
