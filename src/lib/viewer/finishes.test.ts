// Finishes on trees shaped as the viewer's GLB parses: an occurrence with its component, and under it body nodes, each a
// group of its triangle groups (the body's own colour first) with their edge lines.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Finish } from '$lib/catalogue/catalogue';
import { applyFinishes } from './finishes';

const material = (color: number, extra: THREE.MeshStandardMaterialParameters = {}) =>
	Object.assign(new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0, ...extra }), { userData: { appearance: `cad ${color}`, kind: 'opaque' } });

/** A body of these triangle groups, each followed by its edge lines, in an occurrence of `component`. */
function assembly(bodies: { name: string; component: string; groups: THREE.Material[] }[]) {
	const root = new THREE.Group();
	for (const { name, component, groups } of bodies) {
		const occurrence = new THREE.Group();
		occurrence.userData = { id: `o-${name}`, name: component, component };
		const body = new THREE.Group();
		body.userData = { id: `b-${name}`, name, body: true };
		for (const group of groups) body.add(new THREE.Mesh(new THREE.BufferGeometry(), group), new THREE.LineSegments(new THREE.BufferGeometry()));
		occurrence.add(body);
		root.add(occurrence);
	}
	return root;
}

/** The materials of a body's triangle groups, in order. */
function groups(root: THREE.Object3D, name: string) {
	const meshes: THREE.Mesh[] = [];
	root.traverse((object) => {
		if (object.parent?.userData.name === name && (object as THREE.Mesh).isMesh) meshes.push(object as THREE.Mesh);
	});
	return meshes.map((mesh) => mesh.material as THREE.MeshStandardMaterial);
}

const chrome: Finish = { appearance: 'Chrom - Schwarz', kind: 'metal', parts: ['Shell'] };
const clear: Finish = { appearance: 'Polykarbonat (klar)', kind: 'glass', parts: ['Shell'] };

describe('finishes', () => {
	it('put metal on the body\'s own colour only, a clone in the CAD colour', () => {
		const own = material(0x202020), chip = material(0x111111, { roughness: 0.8 });
		const root = assembly([{ name: 'Shell', component: 'Lamp', groups: [own, chip] }]);
		applyFinishes(root, [chrome]);
		const [first, second] = groups(root, 'Shell');
		expect(first).not.toBe(own);
		expect(first).toMatchObject({ metalness: 1, roughness: 0.5, transparent: false, userData: { appearance: 'Chrom - Schwarz', kind: 'metal' } });
		expect(first.color.getHex()).toBe(0x202020);
		// The face with a colour of its own keeps it, and the material the file had stays as it was.
		expect(second).toBe(chip);
		expect(own).toMatchObject({ metalness: 0, userData: { kind: 'opaque' } });
	});

	it('put glass over the whole body, one tint from its own colour', () => {
		const own = material(0xffffff), seal = material(0x000000);
		const root = assembly([{ name: 'Shell', component: 'Lamp', groups: [own, seal] }]);
		applyFinishes(root, [clear]);
		const [first, second] = groups(root, 'Shell');
		expect(second).toBe(first);
		expect(first).toMatchObject({ metalness: 0, transparent: true, depthWrite: false, userData: { appearance: 'Polykarbonat (klar)', kind: 'glass' } });
		expect(first.color.getHex()).toBe(0xffffff);
	});

	it('give glass an opacity from how dark its tint is, unless the rule says', () => {
		const tinted = (color: number, finish: Finish) => {
			const root = assembly([{ name: 'Shell', component: 'Lamp', groups: [material(color)] }]);
			applyFinishes(root, [finish]);
			return groups(root, 'Shell')[0].opacity;
		};
		expect(tinted(0xffffff, clear)).toBeCloseTo(0.1);
		expect(tinted(0x000000, clear)).toBeCloseTo(0.7);
		// Luminance of the linear colour: mid grey in sRGB is about a fifth.
		expect(tinted(0x808080, clear)).toBeCloseTo(0.1 + 0.6 * (1 - new THREE.Color(0x808080).r), 5);
		expect(tinted(0x000000, { ...clear, opacity: 0.4 })).toBe(0.4);
	});

	it("keep the body's roughness, or the rule's, never smoother than 0.05", () => {
		const rough = (finish: Finish, roughness = 0.5) => {
			const root = assembly([{ name: 'Shell', component: 'Lamp', groups: [material(0x808080, { roughness })] }]);
			applyFinishes(root, [finish]);
			return groups(root, 'Shell')[0].roughness;
		};
		expect(rough(chrome, 0.35)).toBe(0.35);
		expect(rough({ ...chrome, roughness: 0.2 })).toBe(0.2);
		expect(rough({ ...chrome, roughness: 0 })).toBe(0.05);
		expect(rough({ ...clear, roughness: 0.1 })).toBe(0.1);
	});

	it('take the later of two rules for one part', () => {
		const root = assembly([{ name: 'Shell', component: 'Lamp', groups: [material(0x808080)] }]);
		applyFinishes(root, [chrome, clear]);
		expect(groups(root, 'Shell')[0].userData.kind).toBe('glass');
		applyFinishes(root, [clear, chrome]);
		expect(groups(root, 'Shell')[0].userData.kind).toBe('metal');
	});

	it("match the body's name before its component's, whichever rule comes later", () => {
		const shared = material(0x808080);
		const root = assembly([
			{ name: 'Shell', component: 'Lamp', groups: [shared] },
			{ name: 'Screw', component: 'Lamp', groups: [shared] },
			{ name: 'Lid', component: 'Case', groups: [material(0x404040)] }
		]);
		applyFinishes(root, [chrome, { ...clear, parts: ['Lamp'] }]);
		expect(groups(root, 'Shell')[0].userData.kind).toBe('metal');
		expect(groups(root, 'Screw')[0].userData.kind).toBe('glass');
		expect(groups(root, 'Lid')[0].userData.kind).toBe('opaque');
		// The material two bodies shared is still the one the file gave them both.
		expect(shared.userData.kind).toBe('opaque');
	});

	it('share one material among the bodies that take a rule over the same colour', () => {
		const shared = material(0x808080);
		const root = assembly([
			{ name: 'Shell', component: 'Lamp', groups: [shared] },
			{ name: 'Frame', component: 'Lamp', groups: [shared] }
		]);
		applyFinishes(root, [{ ...chrome, parts: ['Shell', 'Frame'] }]);
		expect(groups(root, 'Shell')[0]).toBe(groups(root, 'Frame')[0]);
	});

	it('finish a body whose node is its one mesh', () => {
		const root = new THREE.Group();
		const body = new THREE.Mesh(new THREE.BufferGeometry(), material(0x808080));
		body.userData = { id: 'b', name: 'Shell', body: true };
		root.add(body);
		applyFinishes(root, [chrome]);
		expect((body.material as THREE.MeshStandardMaterial).metalness).toBe(1);
	});
});
