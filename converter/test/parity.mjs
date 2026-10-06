// Converts a STEP file with converter.wasm and compares the result with the oracle's output for the same file:
// the manifest, every mesh, every measure record and the normals. Prints timings and peak memory; exits 1 on a
// semantic mismatch. test/parity.test.ts runs the same comparison through parity().
//
//   node converter/test/parity.mjs <converter.wasm> <file.step> <oracle dir> [linear mm] [angular rad]
//
// The oracle directory holds manifest.json, m_###.bin and measure.json from converter/oracle/step_to_manifest.py.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { loadConverter } from '../loader.js';

// Numbers computed by OpenCascade on two platforms: equal up to the last bits libm and the optimiser differ in.
const NUMBER_TOLERANCE = 1e-9;
// A circle fitted to a nearly straight B-spline edge has an ill-conditioned centre and radius (kilometres off for
// a millimetre of edge); the arc's points are what matters, and they agree to the recognition tolerance.
const ARC_POINT_TOLERANCE = 1e-3;
// A face's triangles cover its exact area to this fraction at 0.01 mm / 0.3 rad; a face meshed wrong does not.
const AREA_TOLERANCE = 0.02;
const MAX_REPORTS = Number(process.env.PARITY_REPORTS ?? 12);

// The state of one comparison, which parity() resets when it starts.
let failures = [];
let notes = [];
let reported = 0;
let arcsByPoints = 0;
let log = console.log;
function fail(text) {
	failures.push(text);
	if (reported++ < MAX_REPORTS) log(`  MISMATCH ${text}`);
}
const close = (a, b) => Math.abs(a - b) <= NUMBER_TOLERANCE * Math.max(1, Math.abs(a), Math.abs(b));

/** Exact structural equality, reporting the first difference under `where`. */
function same(expected, actual, where) {
	if (Array.isArray(expected)) {
		if (!Array.isArray(actual) || expected.length !== actual.length) {
			fail(`${where}: expected ${JSON.stringify(expected).slice(0, 80)}, got ${JSON.stringify(actual).slice(0, 80)}`);
			return false;
		}
		return expected.every((v, i) => same(v, actual[i], `${where}[${i}]`));
	}
	if (expected && typeof expected === 'object') {
		if (!actual || typeof actual !== 'object') {
			fail(`${where}: expected an object, got ${JSON.stringify(actual)}`);
			return false;
		}
		const keys = Object.keys(expected);
		const extra = Object.keys(actual).filter((k) => !(k in expected));
		if (extra.length) fail(`${where}: unexpected keys ${extra.join(', ')}`);
		return keys.every((k) => same(expected[k], actual[k], `${where}.${k}`)) && !extra.length;
	}
	if (expected !== actual && !(Number.isNaN(expected) && Number.isNaN(actual))) {
		fail(`${where}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
		return false;
	}
	return true;
}

/** Numbers within tolerance, structure exact. */
function near(expected, actual, where) {
	if (typeof expected === 'number') {
		if (typeof actual !== 'number' || !close(expected, actual)) {
			fail(`${where}: expected ${expected}, got ${actual}`);
			return false;
		}
		return true;
	}
	if (Array.isArray(expected)) {
		if (!Array.isArray(actual) || expected.length !== actual.length) {
			fail(`${where}: expected ${expected.length} entries, got ${Array.isArray(actual) ? actual.length : typeof actual}`);
			return false;
		}
		let ok = true;
		for (let i = 0; i < expected.length; i++) if (!near(expected[i], actual[i], `${where}[${i}]`)) ok = false;
		return ok;
	}
	return same(expected, actual, where);
}

function readOracleMesh(oracleDir, index) {
	const buffer = readFileSync(join(oracleDir, `m_${String(index).padStart(3, '0')}.bin`));
	const bytes = new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
	const header = new Uint32Array(bytes.buffer, 0, 2);
	const [nodes, triangles] = header;
	let at = 8;
	const take = (Type, count) => {
		const array = new Type(bytes.buffer, at, count);
		at += count * Type.BYTES_PER_ELEMENT;
		return array;
	};
	return { nodes, triangles, positions: take(Float32Array, 3 * nodes), indices: take(Uint32Array, 3 * triangles), faceIds: take(Uint32Array, triangles) };
}

const countBy = (array) => {
	const counts = new Map();
	for (const v of array) counts.set(v, (counts.get(v) ?? 0) + 1);
	return counts;
};

/** The triangle area per face id. */
function faceAreas(positions, indices, faceIds) {
	const areas = new Map();
	for (let t = 0; t < faceIds.length; t++) {
		const [a, b, c] = [indices[3 * t], indices[3 * t + 1], indices[3 * t + 2]];
		const ux = positions[3 * b] - positions[3 * a], uy = positions[3 * b + 1] - positions[3 * a + 1], uz = positions[3 * b + 2] - positions[3 * a + 2];
		const vx = positions[3 * c] - positions[3 * a], vy = positions[3 * c + 1] - positions[3 * a + 1], vz = positions[3 * c + 2] - positions[3 * a + 2];
		const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
		areas.set(faceIds[t], (areas.get(faceIds[t]) ?? 0) + area);
	}
	return areas;
}

// BRepMesh decides where to split from floating-point comparisons, so two platforms can mesh a face with a
// different number of triangles: counts are reported, the semantic checks are the face ids, the colour groups,
// each face's area and the normals.
function compareMesh(index, body, mesh, oracle, groups, oracleGroups) {
	const where = `mesh ${index} (${body})`;
	const nodes = mesh.positions.length / 3;
	const triangles = mesh.indices.length / 3;
	if (nodes !== oracle.nodes || triangles !== oracle.triangles) {
		const percent = ((100 * (triangles - oracle.triangles)) / Math.max(1, oracle.triangles)).toFixed(1);
		notes.push(`${where}: ${nodes} nodes / ${triangles} triangles, oracle ${oracle.nodes} / ${oracle.triangles} (${percent}%)`);
	}
	const ours = countBy(mesh.faceIds);
	const theirs = countBy(oracle.faceIds);
	const missing = [...theirs.keys()].filter((id) => !ours.has(id));
	const extra = [...ours.keys()].filter((id) => !theirs.has(id));
	if (missing.length || extra.length) fail(`${where}: face ids missing ${missing.slice(0, 5)} extra ${extra.slice(0, 5)}`);
	else {
		const differing = [...theirs].filter(([id, n]) => ours.get(id) !== n).length;
		if (differing) notes.push(`${where}: ${differing} face(s) with a different triangle count`);
	}
	same(oracleGroups.map((g) => g[0]), groups.map((g) => g[0]), `${where} group appearances`);
	if (nodes === oracle.nodes) {
		let worst = 0;
		for (let i = 0; i < mesh.positions.length; i++) worst = Math.max(worst, Math.abs(mesh.positions[i] - oracle.positions[i]));
		if (worst > 1e-6) notes.push(`${where}: positions differ by up to ${worst.toExponential(2)} mm`);
		if (triangles === oracle.triangles) {
			let differing = 0;
			for (let i = 0; i < mesh.indices.length; i += 3) {
				if (mesh.indices[i] !== oracle.indices[i] || mesh.indices[i + 1] !== oracle.indices[i + 1] || mesh.indices[i + 2] !== oracle.indices[i + 2]) differing++;
			}
			if (differing) notes.push(`${where}: ${differing} triangle(s) indexed differently`);
		}
	}
}

/** Every face's triangles cover its exact area; the oracle's mesh is held to the same standard, for reference. */
function checkAreas(index, body, mesh, oracle, exact) {
	if (!exact) return;
	const where = `mesh ${index} (${body})`;
	const ours = faceAreas(mesh.positions, mesh.indices, mesh.faceIds);
	const theirs = faceAreas(oracle.positions, oracle.indices, oracle.faceIds);
	let bad = 0;
	let oracleBad = 0;
	exact.f.forEach((record, id) => {
		const area = record[1];
		if (area < 1e-6) return;
		const error = Math.abs((ours.get(id) ?? 0) / area - 1);
		const oracleError = Math.abs((theirs.get(id) ?? 0) / area - 1);
		if (oracleError > AREA_TOLERANCE) oracleBad++;
		else if (error > AREA_TOLERANCE) {
			if (bad++ < 3) fail(`${where}: face ${id} meshes to ${(100 * error).toFixed(2)}% off its area of ${area.toFixed(4)} mm² (oracle ${(100 * oracleError).toFixed(2)}%)`);
		}
	});
	if (bad > 3) fail(`${where}: ${bad - 3} more face(s) off their area`);
	if (oracleBad) notes.push(`${where}: ${oracleBad} face(s) where the oracle's own mesh is over ${100 * AREA_TOLERANCE}% off the exact area`);
}

/**
 * Unit normals that agree with the winding of their triangles. Overall a few may not, since the normal at an apex
 * is averaged. Per face most must: a face whose normals point against its winding was given the wrong
 * orientation or location, and fails here however few triangles it has.
 */
function checkNormals(index, body, mesh) {
	const where = `mesh ${index} (${body}) normals`;
	const { positions: p, indices, faceIds, normals: n } = mesh;
	if (!n) {
		fail(`${where}: missing`);
		return { agree: 0, total: 0 };
	}
	let badLength = 0;
	for (let i = 0; i < n.length; i += 3) {
		const length = Math.hypot(n[i], n[i + 1], n[i + 2]);
		if (Math.abs(length - 1) > 1e-3) badLength++;
	}
	if (badLength) fail(`${where}: ${badLength} normal(s) are not unit length`);
	let agree = 0;
	let total = 0;
	const perFace = new Map(); // face id -> [agreeing triangles, triangles]
	for (let t = 0; t < indices.length; t += 3) {
		const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
		const ux = p[3 * b] - p[3 * a], uy = p[3 * b + 1] - p[3 * a + 1], uz = p[3 * b + 2] - p[3 * a + 2];
		const vx = p[3 * c] - p[3 * a], vy = p[3 * c + 1] - p[3 * a + 1], vz = p[3 * c + 2] - p[3 * a + 2];
		const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
		if (nx * nx + ny * ny + nz * nz < 1e-24) continue;
		total++;
		const face = perFace.get(faceIds[t / 3]) ?? [0, 0];
		face[1]++;
		const dot = (v) => nx * n[3 * v] + ny * n[3 * v + 1] + nz * n[3 * v + 2];
		if (dot(a) > 0 && dot(b) > 0 && dot(c) > 0) {
			agree++;
			face[0]++;
		}
		perFace.set(faceIds[t / 3], face);
	}
	const flipped = [...perFace].filter(([, [ok, count]]) => 2 * ok < count);
	if (flipped.length) {
		const [id, [ok, count]] = flipped[0];
		fail(`${where}: ${flipped.length} face(s) point against their winding, e.g. face ${id} on ${count - ok} of ${count} triangles`);
	}
	return { agree, total };
}

const closeAll = (expected, actual) => expected.length === actual.length && expected.every((v, i) => close(v, actual[i]));

/** Start, middle and end of an arc record. */
function arcPoints([, , , cx, cy, cz, nx, ny, nz, rx, ry, rz, radius, sweep]) {
	const yx = ny * rz - nz * ry, yy = nz * rx - nx * rz, yz = nx * ry - ny * rx;
	const at = (t) => {
		const c = Math.cos(t), s = Math.sin(t);
		return [cx + radius * (c * rx + s * yx), cy + radius * (c * ry + s * yy), cz + radius * (c * rz + s * yz)];
	};
	return [at(0), at(sweep / 2), at(sweep)];
}

function compareArc(expected, actual, where) {
	if (closeAll(expected.slice(3), actual.slice(3))) return;
	const ours = arcPoints(actual);
	const theirs = arcPoints(expected);
	const worst = Math.max(...theirs.map((p, i) => Math.hypot(p[0] - ours[i][0], p[1] - ours[i][1], p[2] - ours[i][2])));
	if (worst > ARC_POINT_TOLERANCE) fail(`${where}: arc points differ by ${worst.toExponential(2)} mm (radius ${expected[12]}, got ${actual[12]})`);
	else arcsByPoints++;
}

function compareGeometry(index, body, actual, expected) {
	const where = `geometry ${index} (${body})`;
	if (!actual || !expected) {
		if (actual !== expected) fail(`${where}: ${actual ? 'unexpected record' : 'missing record'}`);
		return;
	}
	near(expected.p, actual.p, `${where}.p`);
	if (expected.e.length !== actual.e.length) {
		fail(`${where}.e: ${expected.e.length} edges, got ${actual.e.length}`);
		return;
	}
	for (let i = 0; i < expected.e.length; i++) {
		const e = expected.e[i];
		const a = actual.e[i];
		if (e === null || a === null) {
			if (e !== a) fail(`${where}.e[${i}]: expected ${JSON.stringify(e)?.slice(0, 60)}, got ${JSON.stringify(a)?.slice(0, 60)}`);
			continue;
		}
		if (!same(e.slice(0, 3), a.slice(0, 3), `${where}.e[${i}]`)) continue;
		if (e[0] === 1) compareArc(e, a, `${where}.e[${i}]`);
		else near(e.slice(3), a.slice(3), `${where}.e[${i}]`);
	}
	if (expected.f.length !== actual.f.length) {
		fail(`${where}.f: ${expected.f.length} faces, got ${actual.f.length}`);
		return;
	}
	for (let i = 0; i < expected.f.length; i++) {
		const f = expected.f[i];
		const a = actual.f[i];
		same(f[0], a[0], `${where}.f[${i}] kind`);
		near(f[1], a[1], `${where}.f[${i}] area`);
		same(f[2], a[2], `${where}.f[${i}] loops`);
		near(f.slice(3), a.slice(3), `${where}.f[${i}] surface`);
	}
}

// The manifest without the matrices, which are compared apart: the oracle's OpenCascade multiplies them with fused
// multiply-add on arm64, and wasm has none, so the smallest entries differ in their last bits.
function manifestView(tree, groupsOf) {
	return {
		doc: tree.doc,
		units: tree.units,
		occurrences: tree.occurrences.map(({ matrix, ...rest }) => rest),
		bodies: tree.bodies,
		// The appearance sequence alone. The groups' triangle counts differ with BRepMesh's floating-point splits, so
		// compareMesh notes them and nothing compares them.
		meshes: tree.meshes.map((m, i) => ({ component: m.component, body: m.body, groups: groupsOf[i].map((g) => g[0]) })),
		fastener_partners: tree.fastener_partners,
		sliders: tree.sliders,
		params: tree.params
	};
}

// ---- run -----------------------------------------------------------------------------------------------------------

/**
 * Converts the STEP file with the converter and compares the result with the oracle's output, printing through `log`.
 * Returns the mismatches (none means parity), the notes on differences parity allows, and the summary it printed.
 */
export async function parity(wasmPath, stepPath, oracleDir, { linear = 0.01, angular = 0.3, log: print = console.log } = {}) {
	failures = [];
	notes = [];
	reported = 0;
	arcsByPoints = 0;
	log = print;

	const times = { instantiate: 0, read: 0, transfer: 0, tree: 0, mesh: 0, geometry: 0 };
	const longest = { mesh: { ms: 0, solid: -1 }, geometry: { ms: 0, solid: -1 } };
	const timed = (label, fn) => {
		const start = performance.now();
		const result = fn();
		const ms = performance.now() - start;
		times[label] += ms;
		return [result, ms];
	};

	const manifest = JSON.parse(readFileSync(join(oracleDir, 'manifest.json'), 'utf8'));
	const measure = JSON.parse(readFileSync(join(oracleDir, 'measure.json'), 'utf8'));
	const step = new Uint8Array(readFileSync(stepPath));

	const t0 = performance.now();
	const converter = await loadConverter(readFileSync(wasmPath), { onOutput: (text) => log(`  [converter] ${text}`) });
	times.instantiate = performance.now() - t0;
	log(`${stepPath.split('/').pop()}: ${(step.length / 1e6).toFixed(1)} MB, deflection ${linear} mm / ${angular} rad`);

	timed('read', () => converter.read(step));
	const [{ solids }] = timed('transfer', () => converter.transfer());
	const [tree] = timed('tree', () => converter.tree());
	log(`  ${solids} solids, ${tree.occurrences.length} occurrences, ${tree.bodies.length} bodies, ${tree.appearance_order.length} appearances, source unit ${tree.source_unit}`);
	if (solids !== manifest.meshes.length) fail(`solid count ${solids}, oracle ${manifest.meshes.length}`);

	const groupsOf = [];
	let triangles = 0;
	let agree = 0;
	let total = 0;
	const count = Math.min(solids, manifest.meshes.length);
	for (let i = 0; i < count; i++) {
		const body = tree.meshes[i]?.body ?? '?';
		const [mesh, meshMs] = timed('mesh', () => converter.mesh(i, linear, angular));
		if (meshMs > longest.mesh.ms) longest.mesh = { ms: meshMs, solid: i };
		triangles += mesh.indices.length / 3;
		groupsOf[i] = mesh.groups.map((g) => [g.appearance < 0 ? null : tree.appearance_order[g.appearance], g.triangles]);
		const oracleMesh = readOracleMesh(oracleDir, i);
		compareMesh(i, body, mesh, oracleMesh, groupsOf[i], manifest.meshes[i].groups);
		const normals = checkNormals(i, body, mesh);
		agree += normals.agree;
		total += normals.total;

		const [geometry, geometryMs] = timed('geometry', () => converter.geometry(i));
		if (geometryMs > longest.geometry.ms) longest.geometry = { ms: geometryMs, solid: i };
		compareGeometry(i, body, geometry, measure.solids[i]);
		checkAreas(i, body, mesh, oracleMesh, geometry);
		if (geometry && geometry.f.length !== tree.meshes[i].faces) fail(`mesh ${i}: faces ${tree.meshes[i].faces} in the tree, ${geometry.f.length} records`);

		// The box comes from the geometry's control points and tolerances; nodes from edge polygons may poke out by
		// a micron.
		const [x0, y0, z0, x1, y1, z1] = tree.meshes[i].bbox;
		const slack = 1e-3;
		const p = mesh.positions;
		let outside = 0;
		for (let k = 0; k < p.length; k += 3) {
			if (p[k] < x0 - slack || p[k] > x1 + slack || p[k + 1] < y0 - slack || p[k + 1] > y1 + slack || p[k + 2] < z0 - slack || p[k + 2] > z1 + slack) outside++;
		}
		if (outside) fail(`mesh ${i} (${body}): ${outside} node(s) outside the tree's bbox`);
		converter.release(i);
	}

	same(manifestView(manifest, manifest.meshes.map((m) => m.groups)), manifestView(tree, groupsOf), 'manifest');
	manifest.occurrences.forEach((occurrence, i) => near(occurrence.matrix, tree.occurrences[i]?.matrix, `manifest.occurrences[${i}].matrix`));
	const appearanceNames = new Set([...Object.keys(manifest.appearances), ...Object.keys(tree.appearances)]);
	for (const name of appearanceNames) same(manifest.appearances[name], tree.appearances[name], `appearances[${name}]`);
	same(Object.keys(tree.appearances), tree.appearance_order, 'appearance_order');
	if (total && agree / total < 0.999) fail(`normals agree with the winding of ${agree} of ${total} triangles`);

	const warnings = converter.warnings();
	for (const warning of warnings) log(`  warning: ${warning}`);
	for (const note of notes.slice(0, MAX_REPORTS)) log(`  note: ${note}`);
	if (notes.length > MAX_REPORTS) log(`  ... ${notes.length - MAX_REPORTS} more notes`);
	if (failures.length > MAX_REPORTS) log(`  ... ${failures.length - MAX_REPORTS} more mismatches`);
	converter.close();

	const ms = Object.fromEntries(Object.entries(times).map(([k, v]) => [k, Math.round(v)]));
	ms.total = ms.read + ms.transfer + ms.tree + ms.mesh + ms.geometry;
	const summary = {
		solids,
		triangles,
		normalsAgree: total ? Number((agree / total).toFixed(5)) : null,
		arcsComparedByPoints: arcsByPoints,
		ms,
		longest: {
			mesh: `${Math.round(longest.mesh.ms)} ms (${tree.meshes[longest.mesh.solid]?.body})`,
			geometry: `${Math.round(longest.geometry.ms)} ms (${tree.meshes[longest.geometry.solid]?.body})`
		},
		peakMemoryMB: Math.round(converter.memoryBytes() / 1048576),
		notes: notes.length,
		mismatches: failures.length
	};
	log(JSON.stringify(summary));
	log(failures.length ? `FAIL: ${failures.length} mismatch(es)` : 'PASS');
	return { failures, notes, summary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [wasmPath, stepPath, oracleDir, linear = '0.01', angular = '0.3'] = process.argv.slice(2);
	if (!oracleDir) {
		console.error('usage: node parity.mjs <converter.wasm> <file.step> <oracle dir> [linear] [angular]');
		process.exit(2);
	}
	const { failures } = await parity(wasmPath, stepPath, oracleDir, { linear: Number(linear), angular: Number(angular) });
	process.exit(failures.length ? 1 : 0);
}
