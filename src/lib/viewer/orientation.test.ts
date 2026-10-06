import { describe, expect, it } from 'vitest';
import { UP_AXES } from '$lib/state/hash';
import { cameraUp, upVector, viewDirection } from './orientation';

describe('up axis', () => {
	it('keeps the views it always had with Z up', () => {
		expect(viewDirection('top', 'z').toArray()).toEqual([0, 0, 1]);
		expect(viewDirection('front', 'z').toArray()).toEqual([0, -1, 0]);
		expect(cameraUp(viewDirection('top', 'z'), 'z').toArray()).toEqual([0, 1, 0]);
		expect(cameraUp(viewDirection('iso', 'z'), 'z').toArray()).toEqual([0, 0, 1]);
	});

	it('lays the views out around any axis: Top along it, Front square to it, Iso above', () => {
		for (const axis of UP_AXES) {
			const up = upVector(axis);
			expect(viewDirection('top', axis).distanceTo(up)).toBeLessThan(1e-9);
			expect(viewDirection('bottom', axis).distanceTo(up.clone().negate())).toBeLessThan(1e-9);
			expect(Math.abs(viewDirection('front', axis).dot(up))).toBeLessThan(1e-9);
			expect(viewDirection('iso', axis).dot(up)).toBeGreaterThan(0.4);
			// Looking along the axis, the camera's up lies square to the line of sight.
			expect(Math.abs(cameraUp(viewDirection('top', axis), axis).dot(up))).toBeLessThan(1e-9);
			expect(cameraUp(viewDirection('iso', axis), axis).distanceTo(up)).toBeLessThan(1e-9);
		}
	});

	it('shows a Y-up file the way Y-up CAD does: Front from +Z, Top from +Y', () => {
		expect(viewDirection('front', 'y').distanceTo(upVector('z'))).toBeLessThan(1e-9);
		expect(viewDirection('top', 'y').distanceTo(upVector('y'))).toBeLessThan(1e-9);
	});
});
