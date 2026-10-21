import { describe, expect, it } from 'vitest';
import { decode } from '$lib/state/hash';
import { fixtureCatalogue } from './fixture';
import { chooseCompanion, companionFile, companionParam, findVersion, resolveModel, versionLabel, type CatalogueSource } from './versions';

const catalogue = fixtureCatalogue();
const stand = catalogue.models.stand;
const source = (route: string) => decode(route, catalogue).source as CatalogueSource;

describe('which version a route names', () => {
	it('finds a listed id, also from the full commit hash', () => {
		expect(findVersion(stand, '1111111')?.id).toBe('1111111');
		expect(findVersion(stand, 'ccc44440123456789abcdef0123456789abcdef0')?.id).toBe('ccc4444');
	});

	it('finds nothing for an id the catalogue does not list, a number or no version', () => {
		expect(findVersion(stand, 'fffffff')).toBeUndefined();
		expect(findVersion(stand, 'ccc444')).toBeUndefined();
		expect(findVersion(stand, 'ccc4445')).toBeUndefined();
		expect(findVersion(stand, '4444')).toBeUndefined();
		expect(findVersion(stand, '41')).toBeUndefined();
		expect(findVersion(stand, undefined)).toBeUndefined();
	});
});

describe('a version in the picker', () => {
	it('is labelled by id and day, in UTC', () => {
		expect(versionLabel(stand.versions[0])).toBe('ccc4444 · 14 Oct');
		expect(versionLabel({ ...stand.versions[0], date: '2026-10-14T23:30:00-02:00' })).toBe('ccc4444 · 15 Oct');
		expect(versionLabel({ ...stand.versions[0], date: '' })).toBe('ccc4444');
	});
});

describe('the file a catalogue model opens', () => {
	it("is the version's STEP file, pinned to its sha256", () => {
		const resolved = resolveModel(catalogue, source('#/stand@1111111'));
		const { step } = stand.versions[1];
		expect(resolved).toEqual({ model: stand, version: stand.versions[1], file: { kind: 'url', url: step.url, sha256: step.sha256 }, companion: { kind: 'cad', possible: false } });
	});

	it('is the latest without a version', () => {
		expect(resolveModel(catalogue, source('#/stand'))).toMatchObject({ version: { id: 'ccc4444' } });
		expect(resolveModel(catalogue, source('#/stand'))).not.toHaveProperty('missing');
	});

	it('is the latest for a version the catalogue does not list, which it names', () => {
		expect(resolveModel(catalogue, source('#/stand@fffffff?m=a.f1'))).toMatchObject({ version: { id: 'ccc4444' }, missing: 'fffffff' });
		expect(resolveModel(catalogue, source('#/stand@41'))).toMatchObject({ version: { id: 'ccc4444' }, missing: '41' });
	});

	it('is none for a model the catalogue does not list', () => {
		expect(resolveModel(catalogue, { kind: 'catalogue', model: 'anvil' })).toBeNull();
		expect(resolveModel(catalogue, { kind: 'catalogue', model: 'constructor' })).toBeNull();
	});
});

describe('the companion a catalogue model shows', () => {
	const clock = catalogue.models.clock;
	const track = clock.companions!;
	const chosen = (route: string) => {
		const resolved = resolveModel(catalogue, source(route))!;
		const { companion } = resolved;
		return { shown: companion.kind === 'revision' ? companion.revision.id : companion, missing: resolved.companionMissing };
	};

	it('is the latest revision on a route without a version, and the part as in CAD on a pinned one', () => {
		expect(chosen('#/clock')).toEqual({ shown: 'eeeeeee', missing: undefined });
		expect(chosen('#/clock@ddddddd')).toEqual({ shown: { kind: 'cad', possible: true }, missing: undefined });
		expect(resolveModel(catalogue, source('#/clock'))!.companion).toEqual({ kind: 'revision', track, revision: track.revisions[0], slot: { id: 'a1b2c3' } });
	});

	it('is what the route names, either way', () => {
		expect(chosen('#/clock@ddddddd?b=2222222').shown).toBe('2222222');
		expect(chosen('#/clock?b=2222222').shown).toBe('2222222');
		expect(chosen('#/clock?b=cad').shown).toEqual({ kind: 'cad', possible: true });
	});

	it('is the latest for a revision the track does not list, which it names', () => {
		expect(chosen('#/clock@ddddddd?b=abcdef0')).toEqual({ shown: 'eeeeeee', missing: 'abcdef0' });
		const none = chooseCompanion({ ...clock, companions: { ...track, latest: null } }, clock.versions[0], 'abcdef0', true);
		expect(none).toEqual({ choice: { kind: 'cad', possible: true }, missing: 'abcdef0' });
	});

	it('is the part as in CAD where the version has no slot, or one the companion does not line up with', () => {
		expect(chooseCompanion(clock, { ...clock.versions[0], slot: null }, 'eeeeeee', false)).toEqual({ choice: { kind: 'cad', possible: false } });
		expect(chooseCompanion(clock, { ...clock.versions[0], slot: undefined }, undefined, false)).toEqual({ choice: { kind: 'cad', possible: false } });
		expect(chosen('#/stand?b=eeeeeee').shown).toEqual({ kind: 'cad', possible: false });
	});

	it('is written on a pinned route only as a revision, and opens its zipped STEP file by hash', () => {
		expect(companionParam(resolveModel(catalogue, source('#/clock'))!.companion)).toBe('eeeeeee');
		expect(companionParam({ kind: 'cad', possible: true })).toBeUndefined();
		expect(companionFile(catalogue, track.revisions[0])).toEqual({
			kind: 'blob',
			sha256: track.revisions[0].step.sha256,
			ext: 'zip',
			servers: catalogue.servers,
			size: track.revisions[0].step.size
		});
	});
});
