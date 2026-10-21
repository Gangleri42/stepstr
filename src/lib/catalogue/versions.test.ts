import { describe, expect, it } from 'vitest';
import { decode } from '$lib/state/hash';
import { fixtureCatalogue } from './fixture';
import { findVersion, resolveModel, type CatalogueSource } from './versions';

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

describe('the file a catalogue model opens', () => {
	it("is the version's STEP file, pinned to its sha256", () => {
		const resolved = resolveModel(catalogue, source('#/stand@1111111'));
		const { step } = stand.versions[1];
		expect(resolved).toEqual({ model: stand, version: stand.versions[1], file: { kind: 'url', url: step.url, sha256: step.sha256 } });
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
