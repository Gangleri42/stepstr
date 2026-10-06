// Which axis of the file points up. The named views, the orbit and the floor are laid out for Z up, as most CAD files
// are modelled; another up axis turns that layout as a whole, so Front, Top and Right keep their meaning relative to it.
import * as THREE from 'three';
import type { UpAxis } from '$lib/state/hash';

export type NamedView = 'iso' | 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

/** Where the camera sits for each view, seen from the target, with Z up. */
const VIEWS: Record<NamedView, [number, number, number]> = {
	iso: [1, -1, 0.75],
	front: [0, -1, 0],
	back: [0, 1, 0],
	left: [-1, 0, 0],
	right: [1, 0, 0],
	top: [0, 0, 1],
	bottom: [0, 0, -1]
};

const Z = new THREE.Vector3(0, 0, 1);

export function upVector(axis: UpAxis) {
	const sign = axis.startsWith('-') ? -1 : 1;
	const name = axis.slice(-1);
	return new THREE.Vector3(name === 'x' ? sign : 0, name === 'y' ? sign : 0, name === 'z' ? sign : 0);
}

/**
 * The rotation that takes the Z-up layout to this up axis: the shortest one, except for -Z, which has no shortest one
 * and takes a half turn about X.
 */
function turnFor(axis: UpAxis) {
	if (axis === '-z') return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
	return new THREE.Quaternion().setFromUnitVectors(Z, upVector(axis));
}

/** Where the camera sits for a named view, seen from the target, as a unit vector. */
export function viewDirection(view: NamedView, axis: UpAxis) {
	return new THREE.Vector3(...VIEWS[view]).normalize().applyQuaternion(turnFor(axis));
}

/** The camera's up for a direction: the up axis, or, looking along it, the side Top and Bottom show at the top. */
export function cameraUp(direction: THREE.Vector3, axis: UpAxis) {
	const along = direction.dot(upVector(axis));
	if (Math.abs(along) <= 0.99) return upVector(axis);
	return new THREE.Vector3(0, along > 0 ? 1 : -1, 0).applyQuaternion(turnFor(axis));
}
