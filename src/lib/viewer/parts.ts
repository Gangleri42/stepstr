import * as THREE from 'three';

/** One occurrence or body of the assembly, as listed in the part tree. */
export type Part = {
	id: string;
	name: string;
	component: string | null;
	body: boolean;
	fastener: boolean;
	depth: number;
	object: THREE.Object3D;
	parent: Part | null;
	children: Part[];
	/** Every body mesh at or below this part. */
	meshes: THREE.Mesh[];
};

export type PartIndex = { roots: Part[]; byId: Map<string, Part>; byObject: Map<THREE.Object3D, Part> };

/** CAD exports name instances "part:1", "part:2": the first loses its number, the others show as "part (2)". */
function displayName(name: string) {
	return name.replace(/:1$/, '').replace(/:(\d+)$/, ' ($1)');
}

/** Walks the GLB below its root node. Nodes without an id (glTF mesh wrappers) fold into their parent. */
export function indexParts(root: THREE.Object3D): PartIndex {
	const byId = new Map<string, Part>();
	const byObject = new Map<THREE.Object3D, Part>();
	const roots: Part[] = [];

	function visit(object: THREE.Object3D, parent: Part | null) {
		const extras = object.userData as { id?: string; name?: string; component?: string; body?: boolean; fastener?: boolean };
		let part = parent;
		if (extras.id) {
			part = {
				id: extras.id,
				name: displayName(extras.name ?? object.name) || extras.id,
				component: extras.component ?? null,
				body: !!extras.body,
				fastener: !!extras.fastener || !!parent?.fastener,
				depth: parent ? parent.depth + 1 : 0,
				object,
				parent,
				children: [],
				meshes: []
			};
			byId.set(part.id, part);
			(parent ? parent.children : roots).push(part);
		}
		if (part) byObject.set(object, part);
		if ((object as THREE.Mesh).isMesh && part) {
			for (let p: Part | null = part; p; p = p.parent) p.meshes.push(object as THREE.Mesh);
		}
		for (const child of object.children) visit(child, part);
	}
	for (const child of root.children) visit(child, null);

	// A body that is the only child of its occurrence adds nothing to the tree: show the occurrence only. Its meshes
	// still map to the body, whose solid Measure reads; shownPart and clickedPart lead from it to the occurrence.
	for (const part of byId.values()) {
		if (part.children.length === 1 && part.children[0].body && part.children[0].children.length === 0) part.children = [];
	}
	return { roots, byId, byObject };
}

/** Applies hidden and isolated ids: isolation shows only those subtrees (and their ancestors' frames). */
export function applyVisibility(index: PartIndex, hidden: Set<string>, isolated: Set<string>) {
	const isolating = isolated.size > 0;
	const inIsolation = (part: Part) => {
		for (let p: Part | null = part; p; p = p.parent) if (isolated.has(p.id)) return true;
		return false;
	};
	const containsIsolated = (part: Part): boolean => isolated.has(part.id) || part.children.some(containsIsolated);
	for (const part of index.byId.values()) {
		const allowed = !isolating || inIsolation(part) || containsIsolated(part);
		part.object.visible = allowed && !hidden.has(part.id);
	}
}

/** The part the tree shows for a body: its occurrence when the body is that occurrence's only one. */
export function shownPart(body: Part): Part {
	return body.parent && !body.parent.children.includes(body) ? body.parent : body;
}

/** The part a click on the model selects: a body's occurrence, which is a row of the tree whatever it holds. */
export function clickedPart(part: Part): Part {
	return part.body && part.parent ? part.parent : part;
}

/** True when the part and all its ancestors are switched on. */
export function isShown(part: Part): boolean {
	for (let p: Part | null = part; p; p = p.parent) if (!p.object.visible) return false;
	return true;
}
