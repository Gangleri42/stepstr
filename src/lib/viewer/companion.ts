// A companion model fitted into one part of another, such as a part another project makes in the slot left for it (a
// catalogue's companion track). The slot's own parts go, and the companion's go in their place: its nodes are in the
// slot's frame, so they keep their own matrices (the companion's root, glTF's metres and Y-up, stays out), shifted by
// `fix` where the site's builder found the export off that frame. Its bodies name the second file's measurement data
// (measure/data.ts). Neither model has been drawn yet, so the parts that leave hold nothing on the GPU. Only three.js's
// types are imported, so the app can fit one without loading three.js ahead of the viewer.
import type * as THREE from 'three';
import type { Slot } from '$lib/catalogue/versions';

/** Which file's measurement data a companion's bodies read: the model's is the first. */
export const COMPANION_SOURCE = 1;

/**
 * Puts the companion `parsed` (a GLB as parsed) into the slot of the model under `root`, and names the slot after it.
 * Throws, changing neither model, when the model has no such slot or the companion's part ids would clash with the
 * model's.
 */
export function fitCompanion(root: THREE.Object3D, parsed: THREE.Object3D, slot: Slot, names: { name: string; component: string }) {
	let holder: THREE.Object3D | undefined;
	root.traverse((object) => {
		if (!holder && object.userData.id === slot.id) holder = object;
	});
	if (!holder) throw new Error(`the model has no part ${slot.id} to fit it into`);
	// The slot's own parts go, so their ids may come back in the companion; every other part keeps its id.
	const ids = new Set<string>();
	const kept = (object: THREE.Object3D) => {
		const { id } = object.userData as { id?: string };
		if (id) ids.add(id);
		if (object !== holder) for (const child of object.children) kept(child);
	};
	kept(root);
	const top = parsed.children[0]?.children ?? [];
	let clashes = 0;
	for (const node of top) {
		node.traverse((object) => {
			if (ids.has(object.userData.id as string)) clashes++;
		});
	}
	if (clashes) throw new Error(`${clashes} of its part ids are the model's too`);

	for (const child of [...holder.children]) holder.remove(child);
	for (const node of [...top]) {
		node.traverse((object) => (object.userData.source = COMPANION_SOURCE));
		if (slot.fix) node.position.set(node.position.x + slot.fix[0], node.position.y + slot.fix[1], node.position.z + slot.fix[2]);
		holder.add(node);
	}
	Object.assign(holder.userData, names);
}
