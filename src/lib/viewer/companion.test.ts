// A companion fitted into a slot, on trees shaped as the viewer's GLBs parse: a scene, the GLB root, and under it the
// file's nodes, an occurrence with its bodies.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { fitCompanion } from './companion';
import { indexParts } from './parts';

/** A parsed GLB: under its root an occurrence for each name, at `at`, each holding one body. */
function parsed(prefix: string, at: [number, number, number] = [0, 0, 0], ...names: string[]) {
	const scene = new THREE.Group();
	const root = new THREE.Group();
	// The GLB root carries glTF's metres; the viewer drops it for the model, and a companion never takes it.
	root.scale.setScalar(0.001);
	for (const name of names) {
		const occurrence = new THREE.Group();
		occurrence.userData = { id: `${prefix}${name}`, name, component: name };
		occurrence.position.fromArray(at);
		const body = new THREE.Mesh(new THREE.BufferGeometry());
		body.userData = { id: `${prefix}${name}b`, name, body: true, solid: 0 };
		root.add(occurrence.add(body));
	}
	scene.add(root);
	return scene;
}

/** The model: a lid, and a slot at (10, 0, 0) holding the part a companion replaces, as in CAD. */
function housing() {
	const root = parsed('e', [0, 0, 0], 'lid').children[0];
	const slot = new THREE.Group();
	slot.userData = { id: 'slot', name: 'Tray', component: 'Tray' };
	slot.position.set(10, 0, 0);
	const cad = new THREE.Mesh(new THREE.BufferGeometry());
	cad.userData = { id: 'cadpart', name: 'Part', body: true, solid: 1 };
	root.add(slot.add(cad));
	root.scale.setScalar(1);
	return root;
}

const names = { name: 'Insert', component: 'Insert eeeeeee' };
const worldOf = (root: THREE.Object3D, id: string) => {
	root.updateMatrixWorld(true);
	return indexParts(root).byId.get(id)!.object.getWorldPosition(new THREE.Vector3()).toArray();
};

describe('a companion in its slot', () => {
	it("takes the slot's place, in the slot's frame and shifted by its fix, its bodies reading the second file", () => {
		const root = housing();
		const insert = parsed('k', [1, 2, 3], 'u1', 'j1');
		fitCompanion(root, insert, { id: 'slot', fix: [0, 0, 5] }, names);
		const index = indexParts(root);
		expect([...index.byId.keys()].sort()).toEqual(['elid', 'elidb', 'ku1', 'ku1b', 'kj1', 'kj1b', 'slot'].sort());
		expect(worldOf(root, 'ku1')).toEqual([11, 2, 8]);
		expect(index.byId.get('ku1b')!.object.userData).toMatchObject({ source: 1, solid: 0 });
		expect(index.byId.get('ku1')!.object.userData.source).toBe(1);
		// The model's own parts still read the first file.
		expect(index.byId.get('elidb')!.object.userData.source).toBeUndefined();
		expect(index.byId.get('slot')).toMatchObject({ name: 'Insert', component: 'Insert eeeeeee' });
		expect(insert.children[0].children).toEqual([]);
	});

	it('keeps its own frame where no fix is needed', () => {
		const root = housing();
		fitCompanion(root, parsed('k', [1, 2, 3], 'u1'), { id: 'slot' }, names);
		expect(worldOf(root, 'ku1')).toEqual([11, 2, 3]);
	});

	it('changes nothing when the model has no such slot, or the ids clash', () => {
		const root = housing();
		const insert = parsed('k', [1, 2, 3], 'u1');
		expect(() => fitCompanion(root, insert, { id: 'nowhere' }, names)).toThrow('the model has no part nowhere');
		const twin = parsed('e', [0, 0, 0], 'lid');
		expect(() => fitCompanion(root, twin, { id: 'slot' }, names)).toThrow('2 of its part ids are the model');
		expect([...indexParts(root).byId.keys()].sort()).toEqual(['cadpart', 'elid', 'elidb', 'slot']);
		expect(indexParts(root).byId.get('slot')!.name).toBe('Tray');
		expect(insert.children[0].children).toHaveLength(1);
		expect(twin.children[0].children).toHaveLength(1);
	});

	it('may reuse the ids of the parts it replaces', () => {
		const root = housing();
		const insert = parsed('k', [0, 0, 0], 'u1');
		insert.children[0].children[0].children[0].userData.id = 'cadpart';
		fitCompanion(root, insert, { id: 'slot' }, names);
		expect(indexParts(root).byId.get('cadpart')!.object.userData.source).toBe(1);
	});
});
