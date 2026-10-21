import { describe, expect, it } from 'vitest';
import { parseCatalogue, type Catalogue } from './catalogue';
import { fixtureCatalogue, hash } from './fixture';

/** The fixture with one change made, as plain data. */
function changed(change: (catalogue: Record<string, any>) => void): unknown {
	const catalogue = structuredClone(fixtureCatalogue()) as Record<string, any>;
	change(catalogue);
	return catalogue;
}

const refusal = (value: unknown) => {
	try {
		parseCatalogue(value);
	} catch (err) {
		return (err as Error).message;
	}
	throw new Error('the catalogue was taken');
};

describe('a site catalogue', () => {
	it('is taken as written, its servers without a trailing slash', () => {
		const catalogue = fixtureCatalogue();
		expect(parseCatalogue(structuredClone(catalogue))).toEqual(catalogue);
		const slashed = changed((c) => (c.servers = ['https://blossom.example.com/']));
		expect((parseCatalogue(slashed) as Catalogue).servers).toEqual(['https://blossom.example.com']);
	});

	it('is refused when it is not one', () => {
		expect(refusal(null)).toMatch(/catalogue must be an object/);
		expect(refusal([])).toMatch(/catalogue must be an object/);
		expect(refusal(changed((c) => (c.version = 2)))).toMatch(/catalogue.version must be 1/);
		expect(refusal(changed((c) => (c.models = {})))).toMatch(/catalogue.models must name at least one model/);
		expect(refusal(changed((c) => delete c.conversion))).toMatch(/catalogue.conversion is missing/);
	});

	it('names every field it does not know, at any depth', () => {
		const message = refusal(
			changed((c) => {
				c.mirror = 'https://example.com';
				c.models.stand.versions[0].glb = {};
				c.models.clock.companions.revisions[0].slot = null;
			})
		);
		expect(message).toContain('catalogue.mirror is not a catalogue field');
		expect(message).toContain('catalogue.models.stand.versions[0].glb is not a catalogue field');
		expect(message).toContain('catalogue.models.clock.companions.revisions[0].slot is not a catalogue field');
	});

	it('refuses hashes, ids and dates of the wrong shape', () => {
		const message = refusal(
			changed((c) => {
				c.conversion = c.conversion.toUpperCase();
				c.models.lamp.versions[0].step.sha256 = 'abc';
				c.models.lamp.versions[0].files.glb.sha256 = hash('x').slice(1);
				c.models.lamp.versions[1].id = 'bbbbbb';
				c.models.stand.versions[0].commit = 'f'.repeat(40);
				c.models.stand.versions[1].date = 'last week';
				c.models.stand.versions[2].step.size = 0;
			})
		);
		for (const problem of [
			'catalogue.conversion must be 64 lowercase hex digits',
			'catalogue.models.lamp.versions[0].step.sha256 must be 64 lowercase hex digits',
			'catalogue.models.lamp.versions[0].files.glb.sha256 must be 64 lowercase hex digits',
			'catalogue.models.lamp.versions[1].id must be 7 lowercase hex digits',
			'catalogue.models.stand.versions[0].id must begin its commit',
			'catalogue.models.stand.versions[1].date must be an ISO 8601 date',
			'catalogue.models.stand.versions[2].step.size must be a positive integer'
		]) {
			expect(message).toContain(problem);
		}
	});

	it('takes STEP files only from https addresses and files only from http(s) servers', () => {
		expect(refusal(changed((c) => (c.models.lamp.versions[0].step.url = 'http://example.com/lamp.step')))).toMatch(/step.url must be an https URL/);
		expect(refusal(changed((c) => (c.servers = ['ftp://example.com'])))).toMatch(/servers\[0\] must be an http\(s\) server address/);
		expect(refusal(changed((c) => (c.servers = [])))).toMatch(/servers must be a non-empty list/);
	});

	it('refuses a model, version or revision listed twice', () => {
		const message = refusal(
			changed((c) => {
				c.models.stand.versions[2] = { ...c.models.stand.versions[0] };
				c.models.clock.companions.revisions.push(c.models.clock.companions.revisions[0]);
			})
		);
		expect(message).toContain('catalogue.models.stand.versions lists version ccc4444 twice');
		expect(message).toContain('catalogue.models.clock.companions.revisions lists revision eeeeeee twice');
	});

	it('names a version by its commit alone', () => {
		expect(refusal(changed((c) => (c.models.lamp.versions[0].number = 15)))).toContain('catalogue.models.lamp.versions[0].number is not a catalogue field');
	});

	it('keeps model names off the route heads stepstr uses, and digits from going first', () => {
		for (const name of ['b', 'u', 'n', '41', 'Stand', 'st and']) {
			expect(refusal(changed((c) => (c.models[name] = c.models.lamp)))).toContain(`"${name}" must be lowercase letters`);
		}
	});

	it('opens a model it lists and a companion revision it lists', () => {
		expect(refusal(changed((c) => (c.home = 'anvil')))).toMatch(/catalogue.home names no model it lists/);
		expect(refusal(changed((c) => (c.models.clock.companions.latest = '0000000')))).toMatch(/companions.latest names no revision it lists/);
		expect(parseCatalogue(changed((c) => (c.models.clock.companions.latest = null))).models.clock.companions?.latest).toBeNull();
	});

	it('takes finishes of metal and glass, with roughness and opacity from 0 to 1', () => {
		const finishes = [
			{ appearance: 'Chrom - Schwarz', kind: 'metal', roughness: 0.2, parts: ['Shell'] },
			{ appearance: 'Polykarbonat (klar)', kind: 'glass', opacity: 0.4, parts: ['Shell', 'Window'] }
		];
		expect(parseCatalogue(changed((c) => (c.models.lamp.versions[0].finishes = finishes))).models.lamp.versions[0].finishes).toEqual(finishes);
		const message = refusal(
			changed((c) => {
				c.models.lamp.versions[0].finishes = [
					{ appearance: 'Lack', kind: 'paint', parts: ['Shell'] },
					{ appearance: 'Glas', kind: 'glass', opacity: 1.5, parts: [] }
				];
			})
		);
		expect(message).toContain('finishes[0].kind must be metal or glass');
		expect(message).toContain('finishes[1].opacity must be a number from 0 to 1');
		expect(message).toContain('finishes[1].parts must be a non-empty list');
	});

	it("takes a site's notes on a companion track and on each revision, a few short lines of text", () => {
		const track = ['The newest revision is left out: it needs a clock with a deeper case.'];
		const revision = ['Built with its mounting holes filled.', 'The screws are not modelled.'];
		const parsed = parseCatalogue(
			changed((c) => {
				c.models.clock.companions.notes = track;
				c.models.clock.companions.revisions[0].notes = revision;
				c.models.clock.companions.revisions[1].notes = [];
			})
		);
		expect(parsed.models.clock.companions?.notes).toEqual(track);
		expect(parsed.models.clock.companions?.revisions.map((r) => r.notes)).toEqual([revision, []]);

		const message = refusal(
			changed((c) => {
				c.models.clock.companions.notes = 'The newest revision is left out.';
				const [first, second] = c.models.clock.companions.revisions;
				first.notes = ['', 'Two\nlines', 7, 'x'.repeat(301), 'Fine.', 'Fine.'];
				second.notes = Array.from({ length: 9 }, (_, i) => `Note ${i}.`);
			})
		);
		expect(message).toContain('companions.notes must be a list');
		expect(message).toContain('revisions[0].notes[0] must be a non-empty line of text');
		expect(message).toContain('revisions[0].notes[1] must be a non-empty line of text');
		expect(message).toContain('revisions[0].notes[2] must be a non-empty line of text');
		expect(message).toContain('revisions[0].notes[3] must be at most 300 characters');
		expect(message).toContain('revisions[0].notes lists a note twice');
		expect(message).toContain('revisions[1].notes must hold at most 8 notes');
		expect(message).not.toContain('notes[4]');
		// Notes belong to a companion's track and revisions, not to a model's versions.
		expect(refusal(changed((c) => (c.models.lamp.versions[0].notes = ['A note.'])))).toMatch(/versions\[0\]\.notes is not a catalogue field/);
	});

	it('takes a slot with a shift, or none', () => {
		expect(parseCatalogue(changed((c) => (c.models.clock.versions[0].slot = { id: 'a1b2c3', fix: [0, 0.5, -1] }))).models.clock.versions[0].slot).toEqual({ id: 'a1b2c3', fix: [0, 0.5, -1] });
		expect(parseCatalogue(changed((c) => (c.models.clock.versions[0].slot = null))).models.clock.versions[0].slot).toBeNull();
		expect(refusal(changed((c) => (c.models.clock.versions[0].slot = { id: 'a1b2c3', fix: [0, 1] })))).toMatch(/slot.fix must be three numbers/);
	});
});
