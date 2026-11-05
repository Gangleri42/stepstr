// A companion model fitted into one part of another, such as a part another project makes in the slot left for it (a
// catalogue's companion track). The slot's own parts go, and the companion's go in their place, placed by what both
// models show: their nodes are drawn in the same kind of frame, so a companion that mostly overlaps the part it replaces
// stays where it is drawn, and any other is centred on it. One whose parts stand on the other side of its outline is
// turned over first. Any companion fits any slot this way; only the look tells how well. Its bodies name the second
// file's measurement data (measure/data.ts). Neither model has been drawn yet, so the parts that leave hold nothing on
// the GPU. Only three.js's types are imported, so the app can fit one without loading three.js ahead of the viewer.
import type * as THREE from 'three';
import type { Slot } from '$lib/catalogue/versions';

/** Which file's measurement data a companion's bodies read: the model's is the first. */
export const COMPANION_SOURCE = 1;

/** How a companion went in: where it is drawn, centred on the part it replaces, or turned over and centred. */
export type Placement = 'as drawn' | 'centred' | 'turned';

/** A rigid move as Matrix4.set takes it, row by row. */
type Move = Parameters<THREE.Matrix4['set']>;

/** How much of the smaller outline the other must cover for the two to count as drawn in the same place. */
const SAME_PLACE = 0.8;

/** The boxes of the bodies under `nodes`, in the frame of `frame`. */
function boxesIn(frame: THREE.Object3D, nodes: THREE.Object3D[]) {
	frame.updateWorldMatrix(true, true);
	const toFrame = frame.matrixWorld.clone().invert();
	const boxes: THREE.Box3[] = [];
	for (const node of nodes) {
		node.traverse((object) => {
			const { geometry } = object as THREE.Mesh;
			if (!geometry?.getAttribute('position')) return;
			if (!geometry.boundingBox) geometry.computeBoundingBox();
			const box = geometry.boundingBox!.clone().applyMatrix4(object.matrixWorld.clone().premultiply(toFrame));
			if (!box.isEmpty()) boxes.push(box);
		});
	}
	return boxes;
}

const area = (box: THREE.Box3) => (box.max.x - box.min.x) * (box.max.y - box.min.y);

/** The outline: the body with the widest footprint. */
const outlineOf = (boxes: THREE.Box3[]) => boxes.reduce((widest, box) => (area(box) > area(widest) ? box : widest));

/**
 * The side of the outline most of its bulk stands on: 1 up, -1 down, 0 when nothing stands, as on a part modelled with
 * no more than pads on it. Only what stands taller than the outline is thick counts.
 */
function bulkSide(boxes: THREE.Box3[], outline: THREE.Box3) {
	const thickness = outline.max.z - outline.min.z;
	const middle = (outline.min.z + outline.max.z) / 2;
	let side = 0;
	for (const box of boxes) {
		const height = box.max.z - box.min.z;
		if (box === outline || height <= thickness) continue;
		side += (box.min.z + box.max.z > 2 * middle ? 1 : -1) * area(box) * height;
	}
	return Math.sign(side);
}

/** Rounded to the thousandth, the most any CAD frame here is drawn to: tessellated boxes carry noise below it. */
const exact = (value: number) => Math.round(value * 1000) / 1000 || 0;

/** Where the companion's boxes go in the slot: how, and the move that puts them there. */
function placing(part: THREE.Box3[], companion: THREE.Box3[]): { placement: Placement; move: Move } {
	if (!part.length || !companion.length) return { placement: 'as drawn', move: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
	const a = outlineOf(part);
	const b = outlineOf(companion);
	const sides = bulkSide(part, a) * bulkSide(companion, b);
	const centreX = (a.min.x + a.max.x) / 2;
	const centreY = (a.min.y + a.max.y) / 2;
	const middleX = (b.min.x + b.max.x) / 2;
	const middleY = (b.min.y + b.max.y) / 2;
	if (sides < 0) {
		// A half turn about the page's vertical, the way KiCad flips a board.
		return { placement: 'turned', move: [-1, 0, 0, exact(centreX + middleX), 0, 1, 0, exact(centreY - middleY), 0, 0, -1, exact(a.min.z + b.max.z), 0, 0, 0, 1] };
	}
	const overlap = Math.max(0, Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x)) * Math.max(0, Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y));
	const drawn = overlap >= SAME_PLACE * Math.min(area(a), area(b));
	const [x, y] = drawn ? [0, 0] : [exact(centreX - middleX), exact(centreY - middleY)];
	return { placement: drawn ? 'as drawn' : 'centred', move: [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, exact(a.min.z - b.min.z), 0, 0, 0, 1] };
}

/**
 * Puts the companion `parsed` (a GLB as parsed) into the slot of the model under `root`, names the slot after it, and
 * says how it went in. Throws, changing neither model, when the model has no such slot or the companion's part ids would
 * clash with the model's.
 */
export function fitCompanion(root: THREE.Object3D, parsed: THREE.Object3D, slot: Slot, names: { name: string; component: string }): Placement {
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
	const glbRoot = parsed.children[0];
	const top = glbRoot?.children ?? [];
	let clashes = 0;
	for (const node of top) {
		node.traverse((object) => {
			if (ids.has(object.userData.id as string)) clashes++;
		});
	}
	if (clashes) throw new Error(`${clashes} of its part ids are the model's too`);

	// Its nodes keep their own matrices in the slot's frame; the GLB root, glTF's metres and Y-up, stays out.
	const { placement, move } = placing(boxesIn(holder, holder.children), glbRoot ? boxesIn(glbRoot, top) : []);
	// A Matrix4 from one at hand: three.js is imported for its types only.
	const matrix = holder.matrix.clone().set(...move);
	for (const child of [...holder.children]) holder.remove(child);
	for (const node of [...top]) {
		node.traverse((object) => (object.userData.source = COMPANION_SOURCE));
		node.applyMatrix4(matrix);
		holder.add(node);
	}
	Object.assign(holder.userData, names);
	return placement;
}
