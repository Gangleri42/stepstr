// A site's catalogue: the models it shows by name, every version of each, and the files published for them, converted
// ahead with the conversion `conversion` names. A site ships it as catalogue.json beside its page (pipeline/site.ts);
// the web page fetches it before the app starts, the napplet carries it. Its links name a model and a version
// (state/hash.ts). The builds read it in Node too, so this file imports nothing.

export type Catalogue = {
	version: 1;
	/** The ABOUT.conversion the published files were made with; a viewer of another conversion converts the STEP. */
	conversion: string;
	/** Blossom servers that hold the published files, fastest first. */
	servers: string[];
	/** The model an empty route opens. */
	home: string;
	/** By the name routes use, in the order the header lists them. */
	models: Record<string, CatalogueModel>;
};

export type CatalogueModel = {
	title: string;
	/** Newest first. */
	versions: CatalogueVersion[];
	/** A model shown in place of one of its parts, such as a part another project makes, in revisions of its own. */
	companions?: CompanionTrack;
};

export type CatalogueVersion = {
	/** The commit's short hash, seven hex digits: what a link names. */
	id: string;
	/** The whole commit hash. */
	commit: string;
	/** The commit's date, ISO 8601. */
	date: string;
	subject: string;
	/** The STEP file, at its commit: an https URL anyone can fetch. */
	step: { sha256: string; size: number; url: string };
	/** The published conversion: a meshopt-compressed GLB and the gzipped measurement data. */
	files: { glb: Blob; measure: Blob };
	/** How its parts are shown, resolved for this version by the site's builder. */
	finishes?: Finish[];
	/** The part a companion takes the place of, and a shift for exports off the companion's frame. */
	slot?: { id: string; fix?: [number, number, number] } | null;
};

export type CompanionTrack = {
	label: string;
	/** Where the companion's revisions come from, in words or as a link. */
	source: string;
	latest: string | null;
	/** Newest first. */
	revisions: CompanionRevision[];
};

export type CompanionRevision = {
	id: string;
	commit: string;
	date: string;
	subject: string;
	/** The zipped STEP file, for download. */
	step: Blob;
	files: { glb: Blob; measure: Blob };
	finishes?: Finish[];
};

/**
 * A part's finish where its CAD colour alone does not show it: metal on the body's own colour, or glass over the whole
 * body. `parts` are body or component names (viewer/finishes.ts).
 */
export type Finish = { appearance: string; kind: 'metal' | 'glass'; roughness?: number; opacity?: number; parts: string[] };

/** A file on the catalogue's Blossom servers. */
export type Blob = { sha256: string; size: number };

/** Model names a route cannot use: the heads of stepstr's own routes. */
export const RESERVED = ['b', 'u', 'n'];

const HEX64 = /^[0-9a-f]{64}$/;
const SHORT = /^[0-9a-f]{7}$/;
const COMMIT = /^[0-9a-f]{40}$/;
// A letter first: a name of digits alone would sort ahead of the others in a JavaScript object.
const NAME = /^[a-z][a-z0-9-]*$/;

type Problems = string[];
type Shape = Record<string, (value: unknown, at: string, problems: Problems) => void>;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Checks an object against the fields it must and may have, and names any other field. */
function object(value: unknown, at: string, problems: Problems, required: Shape, optional: Shape = {}) {
	if (!isObject(value)) return void problems.push(`${at} must be an object`);
	for (const [key, check] of Object.entries(required)) {
		if (value[key] === undefined) problems.push(`${at}.${key} is missing`);
		else check(value[key], `${at}.${key}`, problems);
	}
	for (const [key, check] of Object.entries(optional)) if (value[key] !== undefined) check(value[key], `${at}.${key}`, problems);
	for (const key of Object.keys(value)) if (!(key in required) && !(key in optional)) problems.push(`${at}.${key} is not a catalogue field`);
}

const matching = (pattern: RegExp, rule: string) => (value: unknown, at: string, problems: Problems) => {
	if (typeof value !== 'string' || !pattern.test(value)) problems.push(`${at} must be ${rule}`);
};
const text = matching(/\S/, 'a non-empty string');
const anyText = matching(/^/, 'a string');
const server = matching(/^https?:\/\/[^\s/]+\/?$/, 'an http(s) server address');
const oneOf = (allowed: unknown[]) => (value: unknown, at: string, problems: Problems) => {
	if (!allowed.includes(value)) problems.push(`${at} must be ${allowed.map(String).join(' or ')}`);
};
const sha256 = matching(HEX64, '64 lowercase hex digits');
const short = matching(SHORT, '7 lowercase hex digits');
const commit = matching(COMMIT, '40 lowercase hex digits');
const date = (value: unknown, at: string, problems: Problems) => {
	if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(Date.parse(value))) problems.push(`${at} must be an ISO 8601 date`);
};
const count = (value: unknown, at: string, problems: Problems) => {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) problems.push(`${at} must be a positive integer`);
};
const fraction = (value: unknown, at: string, problems: Problems) => {
	if (typeof value !== 'number' || !(value >= 0 && value <= 1)) problems.push(`${at} must be a number from 0 to 1`);
};
const https = (value: unknown, at: string, problems: Problems) => {
	if (typeof value !== 'string' || !/^https:\/\/[^\s/]+\/\S*$/.test(value)) problems.push(`${at} must be an https URL`);
};
const list = (check: Shape[string], nonEmpty = false) => (value: unknown, at: string, problems: Problems) => {
	if (!Array.isArray(value) || (nonEmpty && !value.length)) return void problems.push(`${at} must be a${nonEmpty ? ' non-empty' : ''} list`);
	value.forEach((item, i) => check(item, `${at}[${i}]`, problems));
};
/** Names each id that comes twice in a list. */
const unique = (ids: unknown[], at: string, what: string, problems: Problems) => {
	const seen = new Set<unknown>();
	for (const id of ids) {
		if (id !== undefined && seen.has(id)) problems.push(`${at} lists ${what} ${String(id)} twice`);
		seen.add(id);
	}
};

const blob = (value: unknown, at: string, problems: Problems) => object(value, at, problems, { sha256, size: count });
const files = (value: unknown, at: string, problems: Problems) => object(value, at, problems, { glb: blob, measure: blob });
const finish = (value: unknown, at: string, problems: Problems) =>
	object(
		value,
		at,
		problems,
		{
			appearance: text,
			kind: oneOf(['metal', 'glass']),
			parts: list(text, true)
		},
		{ roughness: fraction, opacity: fraction }
	);
const triple = (value: unknown, at: string, problems: Problems) => {
	if (!Array.isArray(value) || value.length !== 3 || value.some((v) => typeof v !== 'number' || !Number.isFinite(v))) problems.push(`${at} must be three numbers`);
};
const slot = (value: unknown, at: string, problems: Problems) => {
	if (value !== null) object(value, at, problems, { id: matching(/^[0-9a-z]+$/, 'a part id') }, { fix: triple });
};

function version(value: unknown, at: string, problems: Problems) {
	object(
		value,
		at,
		problems,
		{
			id: short,
			commit,
			date,
			subject: anyText,
			step: (step, where, found) => object(step, where, found, { sha256, size: count, url: https }),
			files
		},
		{ finishes: list(finish), slot }
	);
	if (isObject(value) && typeof value.id === 'string' && typeof value.commit === 'string' && !value.commit.startsWith(value.id)) {
		problems.push(`${at}.id must begin its commit`);
	}
}

function revision(value: unknown, at: string, problems: Problems) {
	object(value, at, problems, { id: short, commit, date, subject: anyText, step: blob, files }, { finishes: list(finish) });
}

function companions(value: unknown, at: string, problems: Problems) {
	object(value, at, problems, {
		label: text,
		source: text,
		latest: (latest, where, found) => (latest === null ? undefined : short(latest, where, found)),
		revisions: list(revision)
	});
	if (!isObject(value) || !Array.isArray(value.revisions)) return;
	const ids = value.revisions.map((r) => (isObject(r) ? r.id : undefined));
	unique(ids, `${at}.revisions`, 'revision', problems);
	if (typeof value.latest === 'string' && !ids.includes(value.latest)) problems.push(`${at}.latest names no revision it lists`);
}

function model(value: unknown, at: string, problems: Problems) {
	object(value, at, problems, { title: text, versions: list(version, true) }, { companions });
	if (!isObject(value) || !Array.isArray(value.versions)) return;
	const versions = value.versions.filter(isObject);
	unique(versions.map((v) => v.id), `${at}.versions`, 'version', problems);
}

/**
 * The catalogue in a site's catalogue.json, checked field by field. A field it does not know, a hash or id of the wrong
 * shape, a model or version listed twice: each is named, and the catalogue is refused whole.
 */
export function parseCatalogue(value: unknown): Catalogue {
	const problems: Problems = [];
	object(value, 'catalogue', problems, {
		version: oneOf([1]),
		conversion: sha256,
		servers: list(server, true),
		home: text,
		models: (models, at, found) => {
			if (!isObject(models) || !Object.keys(models).length) return void found.push(`${at} must name at least one model`);
			for (const [name, entry] of Object.entries(models)) {
				if (!NAME.test(name) || RESERVED.includes(name)) found.push(`${at}: "${name}" must be lowercase letters, digits and dashes, a letter first, and not ${RESERVED.join(', ')}`);
				model(entry, `${at}.${name}`, found);
			}
		}
	});
	if (isObject(value) && isObject(value.models) && typeof value.home === 'string' && !(value.home in value.models)) {
		problems.push(`catalogue.home names no model it lists`);
	}
	if (problems.length) throw new Error(`the catalogue is not valid: ${problems.join('; ')}`);
	const catalogue = value as Catalogue;
	return { ...catalogue, servers: catalogue.servers.map((s) => s.replace(/\/+$/, '')) };
}
