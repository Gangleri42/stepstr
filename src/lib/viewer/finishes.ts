// Finishes a site's catalogue gives a version's parts, where the CAD colours alone do not show them: metal, or glass.
// The site's builder works out which rules hold for the version; this applies them to the model as parsed. A body takes
// the last rule that names its body name, else the last that names its component.
//
// Metal goes on the body's own colour, which the converter writes as the body's first group of triangles
// (converter/ABI.md), so faces with a colour of their own keep it. Glass is one tint over the whole body. Both mark
// the material with `userData = { appearance, kind }`, as the converter's own metal and glass are marked, so the
// viewer treats it the same: glass reflects as glass (scene.ts), and a cut through it shows no cap (section.ts). Only
// three.js's types are imported, so the app can apply finishes without loading three.js ahead of the viewer.
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
	root.traverse((object) => {
		const { body, name } = object.userData as { body?: boolean; name?: string };
		if (!body) return;
		const component = (object.parent?.userData as { component?: string } | undefined)?.component;
		const finish = byPart.get(name ?? object.name) ?? (component === undefined ? undefined : byPart.get(component));
		const groups = groupsOf(object);
		if (!finish || !groups.length) return;
		const own = material(groups[0].material as THREE.MeshStandardMaterial, finish);
		for (const mesh of finish.kind === 'glass' ? groups : groups.slice(0, 1)) mesh.material = own;
	});
}
