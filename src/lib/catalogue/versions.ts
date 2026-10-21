// Which file a catalogue model's route opens, and which companion goes in its slot. The catalogue ties each version to
// its STEP file by sha256, so a link to a version opens those bytes or nothing; a version the catalogue does not list
// opens the latest, and the app says so. A companion revision is tied to its files the same way.
import type { FileSource, Source } from '$lib/state/hash';
import type { Catalogue, CatalogueModel, CatalogueVersion, CompanionRevision, CompanionTrack } from './catalogue';

export type CatalogueSource = Extract<Source, { kind: 'catalogue' }>;

/** The slot a version gives its companion. */
export type Slot = NonNullable<CatalogueVersion['slot']>;

/** What the slot shows: the part as in CAD (`possible` when a revision could go there), or a companion revision. */
export type CompanionChoice = { kind: 'cad'; possible: boolean } | { kind: 'revision'; track: CompanionTrack; revision: CompanionRevision; slot: Slot };

export type Resolved = {
	model: CatalogueModel;
	version: CatalogueVersion;
	/** The version the route asked for when the catalogue does not list it, so the latest stands in. */
	missing?: string;
	/** The version's STEP file, pinned to its sha256. */
	file: FileSource;
	companion: CompanionChoice;
	/** The revision the route asked for when the track does not list it, so the latest stands in. */
	companionMissing?: string;
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

/**
 * The companion a version shows. A route without a version shows the newest of everything, the latest revision among
 * them; a route pinned to a version shows its slot as in CAD unless it names a revision, so that new revisions leave
 * the link as it was. `asked` is the route's `b=`: `cad` or a revision id.
 */
export function chooseCompanion(model: CatalogueModel, version: CatalogueVersion, asked: string | undefined, pinned: boolean): { choice: CompanionChoice; missing?: string } {
	const track = model.companions;
	if (!track || !version.slot) return { choice: { kind: 'cad', possible: false } };
	const { slot } = version;
	const wanted = asked ?? (pinned ? 'cad' : (track.latest ?? 'cad'));
	if (wanted === 'cad') return { choice: { kind: 'cad', possible: true } };
	const revision = track.revisions.find((r) => r.id === wanted);
	if (revision) return { choice: { kind: 'revision', track, revision, slot } };
	const latest = track.revisions.find((r) => r.id === track.latest);
	return { choice: latest ? { kind: 'revision', track, revision: latest, slot } : { kind: 'cad', possible: true }, missing: wanted };
}

/** What a pinned route writes for a choice as its `b=`: nothing for the slot as in CAD, which a pinned route shows anyway. */
export const companionParam = (choice: CompanionChoice) => (choice.kind === 'revision' ? choice.revision.id : undefined);

/** A companion revision's zipped STEP file on the catalogue's servers, pinned to its sha256. */
export function companionFile(catalogue: Catalogue, revision: CompanionRevision): FileSource {
	return { kind: 'blob', sha256: revision.step.sha256, ext: 'zip', servers: catalogue.servers, size: revision.step.size };
}

/** The version a catalogue source opens, its STEP file and its companion; null for a model the catalogue does not list. */
export function resolveModel(catalogue: Catalogue, source: CatalogueSource): Resolved | null {
	const model = Object.hasOwn(catalogue.models, source.model) ? catalogue.models[source.model] : undefined;
	if (!model) return null;
	const found = findVersion(model, source.version);
	const version = found ?? model.versions[0];
	const file: FileSource = { kind: 'url', url: version.step.url, sha256: version.step.sha256 };
	const { choice, missing } = chooseCompanion(model, version, source.companion, !!source.version);
	return {
		model,
		version,
		...(source.version && !found ? { missing: source.version } : {}),
		file,
		companion: choice,
		...(missing ? { companionMissing: missing } : {})
	};
}
