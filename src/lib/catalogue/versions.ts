// Which file a catalogue model's route opens. The catalogue ties each version to its STEP file by sha256, so a link to
// a version opens those bytes or nothing; a version the catalogue does not list opens the latest, and the app says so.
import type { FileSource, Source } from '$lib/state/hash';
import type { Catalogue, CatalogueModel, CatalogueVersion } from './catalogue';

export type CatalogueSource = Extract<Source, { kind: 'catalogue' }>;

export type Resolved = {
	model: CatalogueModel;
	version: CatalogueVersion;
	/** The version the route asked for when the catalogue does not list it, so the latest stands in. */
	missing?: string;
	/** The version's STEP file, pinned to its sha256. */
	file: FileSource;
};

/** The version a route names: an id the catalogue lists, also when the link spells the commit out longer. */
export function findVersion(model: CatalogueModel, version: string | undefined): CatalogueVersion | undefined {
	// Ids are seven characters, so a shorter version names none.
	if (!version || version.length < 7) return undefined;
	return model.versions.find((v) => version.startsWith(v.id));
}

/** "aaaaaaa · 14 Oct" for the version picker: the id and the commit's day, in UTC. */
export function versionLabel(version: CatalogueVersion) {
	const date = new Date(version.date);
	const day = Number.isNaN(date.getTime()) ? '' : ` · ${date.getUTCDate()} ${date.toLocaleString('en', { month: 'short', timeZone: 'UTC' })}`;
	return `${version.id}${day}`;
}

/** The version a catalogue source opens and its STEP file; null for a model the catalogue does not list. */
export function resolveModel(catalogue: Catalogue, source: CatalogueSource): Resolved | null {
	const model = Object.hasOwn(catalogue.models, source.model) ? catalogue.models[source.model] : undefined;
	if (!model) return null;
	const found = findVersion(model, source.version);
	const version = found ?? model.versions[0];
	const file: FileSource = { kind: 'url', url: version.step.url, sha256: version.step.sha256 };
	return { model, version, ...(source.version && !found ? { missing: source.version } : {}), file };
}
