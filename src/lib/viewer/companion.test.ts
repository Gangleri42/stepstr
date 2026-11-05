// A companion fitted into a slot, on trees shaped as the viewer's GLBs parse: a scene, the GLB root, and under it the
// file's nodes, an occurrence with its bodies.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { fitCompanion } from './companion';
import { indexParts } from './parts';

type Bodies = Record<string, [[number, number, number], [number, number, number]]>;

/** A body: a box from `min` to `max` in its occurrence's frame. */
function box(id: string, min: [number, number, number], max: [number, number, number]) {
	const geometry = new THREE.BoxGeometry(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
	geometry.translate((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
	const body = new THREE.Mesh(geometry);
	body.userData = { id, name: id, body: true, solid: 0 };
	return body;
}

/** A parsed GLB: under its root one occurrence per body. */
function glb(prefix: string, bodies: Bodies) {
	const scene = new THREE.Group();
	const root = new THREE.Group();
	// The GLB root carries glTF's metres and Y-up; the viewer drops it for the model, and a companion never takes it.
	root.scale.setScalar(0.001);
	root.rotation.x = -Math.PI / 2;
	for (const [name, [min, max]] of Object.entries(bodies)) {
		const occurrence = new THREE.Group();
		occurrence.userData = { id: `${prefix}${name}`, name, component: name };
		root.add(occurrence.add(box(`${prefix}${name}b`, min, max)));
	}
	scene.add(root);
	return scene;
}

/** A board 100 x 80 x 1.5 at (10..110, -90..-10), a tall cap above it and a low chip below. */
const board = (dx = 0, dy = 0): Bodies => ({
	pcb: [[10 + dx, -90 + dy, 0], [110 + dx, -10 + dy, 1.5]],
	cap: [[20 + dx, -30 + dy, 1.5], [30 + dx, -20 + dy, 26]],
	chip: [[50 + dx, -50 + dy, -1], [55 + dx, -45 + dy, 0]]
});

/** The model: a lid, and a slot at (10, 0, 0), turned about X, holding the board as in CAD. */
function housing(bodies = board()) {
	const root = glb('e', { lid: [[0, 0, 200], [10, 10, 201]] }).children[0];
	root.scale.setScalar(1);
	root.rotation.x = 0;
	const slot = new THREE.Group();
	slot.userData = { id: 'slot', name: 'Tray', component: 'Tray' };
	slot.position.set(10, 0, 0);
	slot.rotation.x = Math.PI / 2;
	for (const [name, [min, max]] of Object.entries(bodies)) {
		const occurrence = new THREE.Group();
		occurrence.userData = { id: `cad${name}`, name, component: name };
		slot.add(occurrence.add(box(`cad${name}b`, min, max)));
	}
	root.add(slot);
	return root;
}

const names = { name: 'Insert', component: 'Insert eeeeeee' };

/** A companion body's box in the slot's frame. */
function inSlot(root: THREE.Object3D, id: string) {
	root.updateMatrixWorld(true);
	const index = indexParts(root);
	const toSlot = index.byId.get('slot')!.object.matrixWorld.clone().invert();
	const found = new THREE.Box3().setFromObject(index.byId.get(id)!.object).applyMatrix4(toSlot);
	const round = (v: THREE.Vector3) => v.toArray().map((n) => Math.round(n * 1000) / 1000 || 0);
	return [round(found.min), round(found.max)];
}

describe('a companion in its slot', () => {
	it("takes the slot's place where it is drawn, its bodies reading the second file", () => {
		const root = housing();
		const insert = glb('k', board());
		expect(fitCompanion(root, insert, { id: 'slot' }, names)).toBe('as drawn');
		const index = indexParts(root);
		expect(index.byId.has('cadpcb')).toBe(false);
		expect(inSlot(root, 'kcapb')).toEqual([[20, -30, 1.5], [30, -20, 26]]);
		expect(index.byId.get('kcapb')!.object.userData).toMatchObject({ source: 1, solid: 0 });
		expect(index.byId.get('kcap')!.object.userData.source).toBe(1);
		// The model's own parts still read the first file.
		expect(index.byId.get('elidb')!.object.userData.source).toBeUndefined();
		expect(index.byId.get('slot')).toMatchObject({ name: 'Insert', component: 'Insert eeeeeee' });
		expect(insert.children[0].children).toEqual([]);
	});

	it('stays where it is drawn when it overlaps, grown or moved a little, with its bottom on the bottom', () => {
		const root = housing();
		const grown: Bodies = { ...board(), pcb: [[10, -90, 0.8], [140, -10, 2.3]], cap: [[20, -30, 2.3], [30, -20, 26.8]] };
		expect(fitCompanion(root, glb('k', grown), { id: 'slot' }, names)).toBe('as drawn');
		expect(inSlot(root, 'kpcbb')).toEqual([[10, -90, 0], [140, -10, 1.5]]);
	});

	it('is centred on the part when it is drawn elsewhere on the page', () => {
		const root = housing();
		expect(fitCompanion(root, glb('k', board(500, 300)), { id: 'slot' }, names)).toBe('centred');
		expect(inSlot(root, 'kpcbb')).toEqual([[10, -90, 0], [110, -10, 1.5]]);
		expect(inSlot(root, 'kcapb')).toEqual([[20, -30, 1.5], [30, -20, 26]]);
	});

	it('counts as drawn in the same place only when it covers most of the smaller outline', () => {
		const near = housing();
		expect(fitCompanion(near, glb('k', board(15)), { id: 'slot' }, names)).toBe('as drawn');
		expect(inSlot(near, 'kpcbb')).toEqual([[25, -90, 0], [125, -10, 1.5]]);
		const off = housing();
		expect(fitCompanion(off, glb('k', board(40)), { id: 'slot' }, names)).toBe('centred');
		expect(inSlot(off, 'kpcbb')).toEqual([[10, -90, 0], [110, -10, 1.5]]);
	});

	it('is turned over and centred when its parts stand on the other side', () => {
		const root = housing();
		// The same board flipped in KiCad and drawn elsewhere: x mirrored on the page, the sides swapped.
		const flipped: Bodies = {
			pcb: [[300, -90, 0], [400, -10, 1.5]],
			cap: [[380, -30, -24.5], [390, -20, 0]],
			chip: [[355, -50, 1.5], [360, -45, 2.5]]
		};
		expect(fitCompanion(root, glb('k', flipped), { id: 'slot' }, names)).toBe('turned');
		expect(inSlot(root, 'kpcbb')).toEqual([[10, -90, 0], [110, -10, 1.5]]);
		expect(inSlot(root, 'kcapb')).toEqual([[20, -30, 1.5], [30, -20, 26]]);
		expect(inSlot(root, 'kchipb')).toEqual([[50, -50, -1], [55, -45, 0]]);
	});

	it('is not turned over for a part with only pads on it', () => {
		const root = housing({ pcb: [[-22, -27, 0], [22, 27, 1.6]], pad: [[-1, -1, -0.05], [1, 1, 0]] });
		const seed: Bodies = { pcb: [[141, -127, 0], [185, -74, 1.5]], chip: [[150, -100, 1.5], [155, -95, 3.5]] };
		expect(fitCompanion(root, glb('k', seed), { id: 'slot' }, names)).toBe('centred');
		expect(inSlot(root, 'kpcbb')).toEqual([[-22, -26.5, 0], [22, 26.5, 1.5]]);
	});

	it('stays where it is drawn when the part has no bodies to go by', () => {
		const root = housing({});
		expect(fitCompanion(root, glb('k', board(500)), { id: 'slot' }, names)).toBe('as drawn');
		expect(inSlot(root, 'kpcbb')).toEqual([[510, -90, 0], [610, -10, 1.5]]);
	});

	it('changes nothing when the model has no such slot, or the ids clash', () => {
		const root = housing();
		const insert = glb('k', board());
		expect(() => fitCompanion(root, insert, { id: 'nowhere' }, names)).toThrow('the model has no part nowhere');
		const twin = glb('e', { lid: [[0, 0, 0], [1, 1, 1]] });
		expect(() => fitCompanion(root, twin, { id: 'slot' }, names)).toThrow('2 of its part ids are the model');
		expect(indexParts(root).byId.has('cadpcb')).toBe(true);
		expect(indexParts(root).byId.get('slot')!.name).toBe('Tray');
		expect(insert.children[0].children).toHaveLength(3);
		expect(twin.children[0].children).toHaveLength(1);
	});

	it('may reuse the ids of the parts it replaces', () => {
		const root = housing();
		const insert = glb('k', board());
		insert.children[0].children[0].children[0].userData.id = 'cadpcbb';
		fitCompanion(root, insert, { id: 'slot' }, names);
		expect(indexParts(root).byId.get('cadpcbb')!.object.userData.source).toBe(1);
	});
});
