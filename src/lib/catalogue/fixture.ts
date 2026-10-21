// A catalogue for tests, in the shape a site's builder writes: three models, one with a companion, versions named by
// commit. Its hashes are made up; tests that open files put real ones in.
import type { Catalogue, CatalogueVersion } from './catalogue.ts';

/** 64 hex digits, different for each label. */
export const hash = (label: string) => [...label].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').padEnd(64, '0').slice(0, 64);

const version = (model: string, id: string, date: string): CatalogueVersion => {
	const commit = id.length === 40 ? id : id.padEnd(40, '0');
	return {
		id: id.slice(0, 7),
		commit,
		date,
		subject: `Update the ${model}`,
		step: { sha256: hash(`${model}@${id.slice(0, 7)}`), size: 5053446, url: `https://raw.githubusercontent.com/example/hardware/${commit}/${model}/${model}.step` },
		files: { glb: { sha256: hash(`glb ${model}@${id.slice(0, 7)}`), size: 1200 }, measure: { sha256: hash(`measure ${model}@${id.slice(0, 7)}`), size: 800 } }
	};
};

export function fixtureCatalogue(): Catalogue {
	return {
		version: 1,
		conversion: hash('conversion'),
		servers: ['https://blossom.example.com', 'https://cdn.example.com'],
		home: 'stand',
		models: {
			lamp: {
				title: 'Lamp',
				versions: [version('lamp', 'aaaaaaa', '2026-10-14'), version('lamp', 'bbbbbbbfedcba9876543210fedcba9876543210f', '2026-10-07')]
			},
			stand: {
				title: 'Stand',
				versions: [
					version('stand', 'ccc4444', '2026-10-14'),
					version('stand', '1111111', '2026-10-07'),
					version('stand', '4444aaa', '2026-10-06')
				]
			},
			clock: {
				title: 'Clock',
				versions: [{ ...version('clock', 'ddddddd', '2026-10-01'), slot: { id: 'a1b2c3' } }],
				companions: {
					label: 'Insert',
					source: 'https://github.com/example/hardware',
					latest: 'eeeeeee',
					revisions: [
						{
							id: 'eeeeeee',
							commit: 'eeeeeee'.padEnd(40, '0'),
							date: '2026-09-30',
							subject: 'Shape the insert',
							step: { sha256: hash('insert step'), size: 900000 },
							files: { glb: { sha256: hash('insert glb'), size: 300 }, measure: { sha256: hash('insert measure'), size: 200 } }
						},
						{
							id: '2222222',
							commit: '2222222'.padEnd(40, '0'),
							date: '2026-09-12',
							subject: 'Place the parts',
							step: { sha256: hash('old insert step'), size: 880000 },
							files: { glb: { sha256: hash('old insert glb'), size: 290 }, measure: { sha256: hash('old insert measure'), size: 190 } }
						}
					]
				}
			}
		}
	};
}
