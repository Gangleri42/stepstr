import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { clickedPart, indexParts, shownPart } from './parts';

// The node shapes GLTFLoader gives for the converter's GLB: a body drawn by one primitive is a Mesh with the body's
// extras, a body drawn by several is a Group of Meshes without ids.
const node = <T extends THREE.Object3D>(object: T, extras: Record<string, unknown>, ...children: THREE.Object3D[]) => {
	Object.assign(object.userData, extras);
	if (children.length) object.add(...children);
	return object;
};
const mesh = (extras: Record<string, unknown> = {}) => node(new THREE.Mesh(new THREE.BufferGeometry()), extras);

function assembly() {
	const single = mesh({ id: 'a1', body: true, solid: 0 });
	const pieces = [mesh(), mesh()];
	const several = node(new THREE.Group(), { id: 'b1', body: true, solid: 1 }, ...pieces);
	const left = mesh({ id: 'c1', body: true, solid: 2 });
	const right = mesh({ id: 'c2', body: true, solid: 3 });
	const root = node(
		new THREE.Group(),
		{},
		node(new THREE.Group(), { id: 'a', name: 'Bracket:1', component: 'Bracket' }, single),
		node(new THREE.Group(), { id: 'b', name: 'Plate:2' }, several),
		node(new THREE.Group(), { id: 'c', name: 'Pair' }, left, right)
	);
	return { root, single, pieces, left };
}

describe('part index', () => {
	it('shows an occurrence with one body as one row, and lists the bodies of one with several', () => {
		const { root } = assembly();
		const index = indexParts(root);
		expect(index.roots.map((p) => [p.name, p.children.map((c) => c.id)])).toEqual([
			['Bracket', []],
			['Plate (2)', []],
			['Pair', ['c1', 'c2']]
		]);
	});

	it('keeps a body drawn by one primitive as the part of its mesh, so Measure finds its solid', () => {
		const { root, single } = assembly();
		const index = indexParts(root);
		const body = index.byObject.get(single)!;
		expect(body.id).toBe('a1');
		expect(body.object.userData.solid).toBe(0);
		expect(index.byId.get('a')!.meshes).toEqual([single]);
	});

	it('selects the row the tree shows when such a body is clicked', () => {
		const { root, single } = assembly();
		const index = indexParts(root);
		const body = index.byObject.get(single)!;
		const row = index.roots[0];
		expect(shownPart(body)).toBe(row);
		expect(clickedPart(body)).toBe(row);
	});

	it('finds the body of a mesh inside a body drawn by several primitives', () => {
		const { root, pieces } = assembly();
		const index = indexParts(root);
		for (const piece of pieces) expect(index.byObject.get(piece)!.id).toBe('b1');
		expect(clickedPart(index.byObject.get(pieces[0])!)).toBe(index.roots[1]);
	});

	it('shows a body with siblings as its own row, and a click selects its occurrence', () => {
		const { root, left } = assembly();
		const index = indexParts(root);
		const body = index.byObject.get(left)!;
		expect(shownPart(body)).toBe(body);
		expect(clickedPart(body)).toBe(index.roots[2]);
	});
});
