// Finishes a site's catalogue gives a version's parts, where the CAD colours alone do not show them: metal, or glass.
// The site's builder works out which rules hold for the version; this applies them to the model as parsed. A body takes
// the last rule that names its body name, else the last that names its component.
//
// Metal goes on the faces in the body's own colour, so faces with a colour of their own keep it, even one of the same
// name. The GLB marks the triangle group of those faces (`own` in the primitive's extras, which three.js puts on the
// geometry) and says on its root node that it does (`ownFlagged`). In such a file a body whose faces all have colours
// of their own has no marked group and takes no metal, even when no body in the file has one. A GLB without the key
// was made before the mark, so there metal goes on each body's first group, where the converter writes its own colour
// when it has one (converter/ABI.md). Glass is one tint over the whole body. Both mark the material with
// `userData = { appearance, kind }`, as the converter's own metal and glass are marked, so the viewer treats it the
// same: glass reflects as glass (scene.ts), and a cut through it shows no cap (section.ts). Only three.js's types are
// imported, so the app can apply finishes without loading three.js ahead of the viewer.
import type * as THREE from 'three';
import type { Finish } from '$lib/catalogue/catalogue';

/** Below this, a metal reflects the room as a mirror would, which reads as noise on small parts. */
const MIN_ROUGHNESS = 0.05;

/** The meshes of a body's triangle groups, in the order the converter wrote them; its edge lines are not meshes. */
function groupsOf(body: THREE.Object3D): THREE.Mesh[] {
	const meshes = (body as THREE.Mesh).isMesh ? [body] : body.children;
	return meshes.filter((object): object is THREE.Mesh => (object as THREE.Mesh).isMesh && !object.userData.cap);
}

/** Clear glass nearly vanishes and tinted glass stays dark: opacity follows how dark the tint is, unless the rule says. */
const glassOpacity = (color: THREE.Color) => 0.1 + 0.6 * (1 - (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b));

function finished(source: THREE.MeshStandardMaterial, finish: Finish): THREE.MeshStandardMaterial {
	const material = source.clone();
	material.roughness = Math.max(finish.roughness ?? source.roughness, MIN_ROUGHNESS);
	if (finish.kind === 'metal') {
		// Opaque, whatever the CAD colour was.
		material.metalness = 1;
		material.transparent = false;
		material.depthWrite = true;
		material.opacity = 1;
	} else {
		material.metalness = 0;
		material.transparent = true;
		material.depthWrite = false;
		material.opacity = finish.opacity ?? glassOpacity(source.color);
	}
	material.userData = { appearance: finish.appearance, kind: finish.kind };
	return material;
}

/** Gives the bodies under `root` the finishes the rules name for them. */
export function applyFinishes(root: THREE.Object3D, finishes: Finish[]) {
	const byPart = new Map<string, Finish>();
	for (const finish of finishes) for (const part of finish.parts) byPart.set(part, finish);
	// One material per source material and rule, shared by every body that takes the same.
	const made = new Map<Finish, Map<THREE.Material, THREE.MeshStandardMaterial>>();
	const material = (source: THREE.MeshStandardMaterial, finish: Finish) => {
		let forRule = made.get(finish);
		if (!forRule) made.set(finish, (forRule = new Map()));
		let clone = forRule.get(source);
		if (!clone) forRule.set(source, (clone = finished(source, finish)));
		return clone;
	};
	const marked = (mesh: THREE.Mesh) => mesh.geometry.userData.own === true;
	/** Whether the GLB the body came from marks its groups: its root node, above the body, says so. */
	const flagged = (body: THREE.Object3D) => {
		for (let node: THREE.Object3D | null = body; node; node = node.parent) if ('ownFlagged' in node.userData) return true;
		return false;
	};
	root.traverse((object) => {
		const { body, name } = object.userData as { body?: boolean; name?: string };
		if (!body) return;
		const component = (object.parent?.userData as { component?: string } | undefined)?.component;
		const finish = byPart.get(name ?? object.name) ?? (component === undefined ? undefined : byPart.get(component));
		const groups = groupsOf(object);
		if (!finish || !groups.length) return;
		if (finish.kind === 'glass') {
			const tint = material(groups[0].material as THREE.MeshStandardMaterial, finish);
			for (const mesh of groups) mesh.material = tint;
			return;
		}
		const own = flagged(object) ? groups.filter(marked) : groups.slice(0, 1);
		for (const mesh of own) mesh.material = material(mesh.material as THREE.MeshStandardMaterial, finish);
	});
}
