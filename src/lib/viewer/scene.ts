import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree, type MeshBVH } from 'three-mesh-bvh';
import type { Camera, Cut, UpAxis } from '$lib/state/hash';
import { Explode } from './explode';
import { gltfLoader } from './gltf';
import { cameraUp, upVector, viewDirection, type NamedView } from './orientation';
import { clickedPart, indexParts, isShown, type Part, type PartIndex } from './parts';
import { Section } from './section';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// The world frame is the CAD file's: millimetres, Z up.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export type Palette = { background: string; edges: string; accent: string; ground: string; measure: string };
export type { NamedView };

/** A point on a shown, uncut surface: the mesh, its body part, and the first corner of the triangle hit. */
export type SurfaceHit = { mesh: THREE.Mesh; part: Part; point: THREE.Vector3; distance: number; vertex: number };

/**
 * Something that takes over the canvas's clicks and draws over the model, such as Measure. While it is active, a click
 * goes to it instead of selecting a part; it runs before every frame and after every render.
 */
export interface CanvasTool {
	readonly active: boolean;
	/** The mouse or pen moved with no button down; null when it left the canvas or a drag began. */
	hover(event: PointerEvent | null): void;
	/** A click or tap that did not drag. */
	click(event: PointerEvent): void;
	/** Before a frame; returns true to have it rendered. `moving` is true while the camera moves. */
	frame(moving: boolean): boolean;
	/** After a render, with the camera as drawn. */
	rendered(): void;
	/** The model is about to be replaced. */
	detach(): void;
	setPalette(palette: Palette): void;
	dispose(): void;
}

type Target = { mesh: THREE.Mesh; part: Part; sphere: THREE.Sphere; inverse: THREE.Matrix4; mirrored: boolean; capped: boolean };

/** What the viewer asks of the GPU. */
export type RenderOptions = {
	antialias: boolean;
	maxPixelRatio: number;
	shadowSize: number;
	environment?: boolean;
	shadowType?: 'pcf' | 'basic';
};

/**
 * Touch screens get no multisampling, a smaller shadow map and plain shadow sampling. At phone pixel densities
 * multisampling hardly shows, yet it is most of a frame's memory. PCF shadows sample the depth map through the GPU's
 * comparison sampler, which makes the PowerVR in the Pixel 10 lose the WebGL context on the first frame; Chromium then
 * refuses WebGL to the whole site until the browser restarts. A PowerVR found on any device gets plain sampling too.
 */
export function defaultRenderOptions(): RenderOptions {
	const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
	return touch
		? { antialias: false, maxPixelRatio: 2, shadowSize: 1024, shadowType: 'basic' }
		: { antialias: true, maxPixelRatio: 2, shadowSize: 2048 };
}

const SHADOW_TYPES = { pcf: THREE.PCFShadowMap, basic: THREE.BasicShadowMap };

/** Whether the GPU is a PowerVR, as far as the browser tells. */
function isPowerVR(gl: WebGLRenderingContext | WebGL2RenderingContext) {
	const named = String(gl.getParameter(gl.RENDERER));
	if (named !== 'WebKit WebGL') return /PowerVR|Imagination/i.test(named);
	const info = gl.getExtension('WEBGL_debug_renderer_info');
	return !!info && /PowerVR|Imagination/i.test(String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)));
}

/** The floor's normal before it is turned square to the up axis: a plane geometry faces +Z. */
const PLANE_NORMAL = new THREE.Vector3(0, 0, 1);

/** Premultiplied output for glass: the body's light scales with alpha, the reflected light does not. */
const glassShader = (shader: THREE.WebGLProgramParametersWithUniforms) => {
	shader.fragmentShader = shader.fragmentShader.replace(
		'#include <opaque_fragment>',
		'gl_FragColor = vec4( totalDiffuse * diffuseColor.a + totalSpecular + totalEmissiveRadiance, diffuseColor.a );'
	);
};

/**
 * Glass keeps its faint opacity, but its reflections stay at full strength instead of fading with it, so clear glass
 * reads as a surface. Clones (the selection tint) do not inherit onBeforeCompile, so they are passed through here too.
 */
function reflectiveGlass(material: THREE.MeshStandardMaterial) {
	if (material.userData.kind !== 'glass' || material.onBeforeCompile === glassShader) return;
	material.blending = THREE.CustomBlending;
	material.blendEquation = THREE.AddEquation;
	material.blendSrc = THREE.OneFactor;
	material.blendDst = THREE.OneMinusSrcAlphaFactor;
	material.onBeforeCompile = glassShader;
	material.customProgramCacheKey = () => 'reflective-glass';
	// A flat pane reflects only a few percent head-on; a stronger room reflection and a faint body make small windows
	// visible.
	material.envMapIntensity = 6;
	material.opacity = Math.max(material.opacity, 0.2);
	material.needsUpdate = true;
}

export class Viewer {
	readonly renderer: THREE.WebGLRenderer;
	readonly scene = new THREE.Scene();
	readonly perspective = new THREE.PerspectiveCamera(30, 1, 1, 10000);
	readonly orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, -10000, 10000);
	camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.perspective;
	controls: OrbitControls;
	readonly section = new Section();
	readonly explode = new Explode();
	parts: PartIndex | null = null;
	model: THREE.Object3D | null = null;
	/** Radius of the model's bounding sphere at load, mm. */
	radius = 100;
	bounds = new THREE.Box3();

	/** Parses the GLB, meshopt-compressed or not. Public so a page can register decoders the app does not ship. */
	readonly loader = gltfLoader();
	/**
	 * Whether a loaded model gets the bounding volume hierarchies that clicks and Measure's pointer pick with. A page
	 * that only shows a model saves building them; a mesh without one is never picked.
	 */
	pickable = true;

	/** Called when the user finishes moving the camera. */
	onCameraChange: () => void = () => {};
	onPick: (part: Part | null) => void = () => {};
	/** The browser dropped the WebGL context (the driver reset it), and gave it back. */
	onContextLost: () => void = () => {};
	onContextRestored: () => void = () => {};

	#dirty = true;
	#axis: UpAxis = 'z';
	#resize: ResizeObserver;
	#light = new THREE.DirectionalLight(0xffffff, 1.2);
	#ground: THREE.Mesh<THREE.PlaneGeometry, THREE.ShadowMaterial>;
	#edges: THREE.LineBasicMaterial[] = [];
	#highlight = new Map<THREE.Material, THREE.MeshStandardMaterial>();
	#highlighted: { mesh: THREE.Mesh; material: THREE.Material }[] = [];
	#accent = new THREE.Color('#e2561b');
	#pointers = new Map<number, { x: number; y: number }>();
	#multiTouch = false;
	#inset = { left: 0, right: 0 };
	#tool: CanvasTool | null = null;
	#targets: Target[] | null = null;
	#raycaster = new THREE.Raycaster();
	#projected = new THREE.Vector3();

	constructor(canvas: HTMLCanvasElement, options: RenderOptions = defaultRenderOptions()) {
		this.renderer = new THREE.WebGLRenderer({ canvas, antialias: options.antialias, powerPreference: 'high-performance' });
		this.renderer.setPixelRatio(Math.min(devicePixelRatio, options.maxPixelRatio));
		this.renderer.toneMapping = THREE.NeutralToneMapping;
		this.renderer.localClippingEnabled = true;
		this.renderer.shadowMap.enabled = options.shadowSize > 0;
		// PCF blurs by the light's shadow.radius; three.js dropped PCFSoftShadowMap and warned on every load.
		const shadowType = options.shadowType ?? (isPowerVR(this.renderer.getContext()) ? 'basic' : 'pcf');
		this.renderer.shadowMap.type = SHADOW_TYPES[shadowType];
		const environment = options.environment ?? true;
		if (environment) this.#environment();
		// three.js keeps a lost context restorable. Once it is back, the environment map, which only ever lived on the GPU,
		// is drawn again; everything else uploads with the next frame. Shadows step down so an unknown GPU that failed on
		// them does not fail again: plain sampling after the first loss, none after the second.
		let losses = 0;
		canvas.addEventListener('webglcontextlost', () => {
			losses++;
			this.onContextLost();
		});
		canvas.addEventListener('webglcontextrestored', () => {
			if (losses >= 2 || this.renderer.shadowMap.type === THREE.BasicShadowMap) {
				this.renderer.shadowMap.enabled = false;
				this.#light.castShadow = false;
			} else this.renderer.shadowMap.type = THREE.BasicShadowMap;
			this.#light.shadow.map?.dispose();
			this.#light.shadow.map = null;
			if (environment) this.#environment();
			this.requestRender();
			this.onContextRestored();
		});

		this.#light.castShadow = options.shadowSize > 0;
		if (options.shadowSize > 0) this.#light.shadow.mapSize.set(options.shadowSize, options.shadowSize);
		this.#light.shadow.radius = 6;
		this.#light.shadow.bias = -0.0005;
		this.scene.add(this.#light, this.#light.target);

		this.#ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.18 }));
		this.#ground.receiveShadow = true;
		this.#ground.raycast = () => {};
		this.scene.add(this.#ground);

		this.perspective.position.set(300, -300, 250);
		this.controls = this.#makeControls();

		// A click is a primary button or one finger that barely moved; a pinch never ends in one. It picks a part, or goes
		// to the active tool.
		canvas.addEventListener('pointerdown', (e) => {
			this.#pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (this.#pointers.size > 1) this.#multiTouch = true;
			this.#tool?.hover(null);
		});
		const release = (e: PointerEvent, cancelled: boolean) => {
			const down = this.#pointers.get(e.pointerId);
			this.#pointers.delete(e.pointerId);
			const multiTouch = this.#multiTouch;
			if (!this.#pointers.size) this.#multiTouch = false;
			if (cancelled || !down || multiTouch || e.button !== 0) return;
			if (Math.hypot(e.clientX - down.x, e.clientY - down.y) >= (e.pointerType === 'touch' ? 10 : 5)) return;
			if (this.#tool?.active) this.#tool.click(e);
			else this.onPick(this.pick(e.clientX, e.clientY));
		};
		canvas.addEventListener('pointerup', (e) => release(e, false));
		canvas.addEventListener('pointercancel', (e) => release(e, true));
		canvas.addEventListener('pointermove', (e) => {
			if (!e.buttons && e.pointerType !== 'touch' && this.#tool?.active) this.#tool.hover(e);
		});
		canvas.addEventListener('pointerleave', () => this.#tool?.hover(null));

		this.#resize = new ResizeObserver(() => this.#fitCanvas());
		this.#resize.observe(canvas);
		this.#fitCanvas();

		// Render on demand: damping keeps controls.update() returning true until the motion settles.
		this.renderer.setAnimationLoop(() => {
			const moving = this.controls.update();
			if (this.#tool?.active && this.#tool.frame(moving)) this.#dirty = true;
			if (!moving && !this.#dirty) return;
			this.#dirty = false;
			this.#placeStage();
			this.renderer.render(this.scene, this.camera);
			if (this.#tool?.active) this.#tool.rendered();
		});
	}

	requestRender() {
		this.#dirty = true;
	}

	/** What the renderer asked for and holds, for debugging on a device. */
	describe() {
		const gl = this.renderer.getContext();
		const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
		const { memory, render } = this.renderer.info;
		const types: Record<number, string> = { [THREE.PCFShadowMap]: 'pcf', [THREE.BasicShadowMap]: 'basic' };
		const type = types[this.renderer.shadowMap.type] ?? '?';
		return `${size.x}×${size.y} px, antialias ${gl.getContextAttributes()?.antialias ? 'on' : 'off'}, shadow ${this.#light.castShadow ? `${this.#light.shadow.mapSize.x} ${type}` : 'off'}, ` +
			`${memory.geometries} geometries, ${memory.textures} textures, ${render.calls} draw calls, max texture ${gl.getParameter(gl.MAX_TEXTURE_SIZE)}`;
	}

	/**
	 * A picture of the model as it is on screen, cropped to what is shown of it and fitted into width × height pixels on
	 * the view's background: for the list of recently viewed files. Null while no model is in.
	 */
	async snapshot(width = 320, height = 240): Promise<Blob | null> {
		if (!this.model) return null;
		// The drawing buffer holds a frame only until the browser shows it: render and copy in one go.
		this.renderer.render(this.scene, this.camera);
		const canvas = this.renderer.domElement;
		const { x0, y0, x1, y1 } = this.#onScreen(canvas.width, canvas.height);
		if (x1 - x0 < 2 || y1 - y0 < 2) return null;
		const picture = document.createElement('canvas');
		Object.assign(picture, { width, height });
		const context = picture.getContext('2d');
		if (!context) return null;
		const background = this.scene.background instanceof THREE.Color ? this.scene.background.getHexString() : 'eceae4';
		context.fillStyle = `#${background}`;
		context.fillRect(0, 0, width, height);
		const scale = Math.min(width / (x1 - x0), height / (y1 - y0));
		const [w, h] = [(x1 - x0) * scale, (y1 - y0) * scale];
		context.drawImage(canvas, x0, y0, x1 - x0, y1 - y0, (width - w) / 2, (height - h) / 2, w, h);
		const encode = (type: string, quality: number) => new Promise<Blob | null>((resolve) => picture.toBlob(resolve, type, quality));
		// WebP is small; a browser that cannot write it gives PNG instead, and JPEG is the smaller of the fallbacks.
		const webp = await encode('image/webp', 0.85);
		return webp?.type === 'image/webp' ? webp : encode('image/jpeg', 0.85);
	}

	/**
	 * Where the shown parts are on a canvas of this many pixels, less what the cuts take away, with a margin; where they
	 * cannot be placed (a corner behind the camera), the part of the canvas no panel covers.
	 */
	#onScreen(width: number, height: number) {
		const scale = width / Math.max(1, this.renderer.domElement.clientWidth);
		const free = { x0: this.#inset.left * scale, y0: 0, x1: width - this.#inset.right * scale, y1: height };
		const box = this.#visibleBounds();
		for (const plane of this.section.planes) {
			// A cut is square to an axis, so the half of a box it keeps is a box.
			const axis = (['x', 'y', 'z'] as const).find((a) => Math.abs(plane.normal[a]) > 0.999);
			if (!axis) continue;
			const at = -plane.constant / plane.normal[axis];
			if (plane.normal[axis] > 0) box.min[axis] = Math.max(box.min[axis], at);
			else box.max[axis] = Math.min(box.max[axis], at);
		}
		if (box.isEmpty()) return free;
		let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
		const corner = new THREE.Vector3();
		for (let i = 0; i < 8; i++) {
			corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(this.camera);
			// Behind the camera a corner projects mirrored, so the box cannot be placed.
			if (Math.abs(corner.z) > 1) return free;
			const x = ((corner.x + 1) / 2) * width, y = ((1 - corner.y) / 2) * height;
			[x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
		}
		const margin = 0.06 * Math.max(x1 - x0, y1 - y0);
		return { x0: Math.max(0, x0 - margin), y0: Math.max(0, y0 - margin), x1: Math.min(width, x1 + margin), y1: Math.min(height, y1 + margin) };
	}

	/** The room light the metal and glass reflect, rendered into a texture on the GPU. */
	#environment() {
		const pmrem = new THREE.PMREMGenerator(this.renderer);
		const room = new RoomEnvironment();
		this.scene.environment?.dispose();
		this.scene.environment = pmrem.fromScene(room, 0.04).texture;
		room.dispose();
		pmrem.dispose();
	}

	/** Hands the canvas's clicks and overlay to a tool (null gives them back). */
	setTool(tool: CanvasTool | null) {
		if (this.#tool && this.#tool !== tool) this.#tool.dispose();
		this.#tool = tool;
		this.requestRender();
	}

	setPalette(palette: Palette) {
		this.scene.background = new THREE.Color(palette.background);
		this.#accent.set(palette.accent);
		for (const material of this.#highlight.values()) material.emissive.copy(this.#accent);
		for (const material of this.#edges) material.color.set(palette.edges);
		this.section.setHatch(palette.edges);
		this.#ground.material.color.set(palette.ground);
		this.#tool?.setPalette(palette);
		this.requestRender();
	}

	/**
	 * Replaces the model with a GLB's bytes and returns its part index. `prepare` may change the parsed model first, such
	 * as its parts' finishes or a part swapped for another model's: it gets the root in the file's frame, and what it
	 * leaves is set up as the file's own nodes and materials would be. When `wanted` turns false meanwhile (a newer request
	 * came in), the parsed model is thrown away, the scene is left alone and null comes back. Nothing on screen changes
	 * before the new model is complete, so a failed load, or a `prepare` that throws, leaves the old one in place.
	 */
	async loadBuffer(buffer: ArrayBuffer, wanted: () => boolean = () => true, prepare?: (root: THREE.Object3D) => void) {
		const model = (await this.loader.parseAsync(buffer, '')).scene;
		if (!wanted()) {
			this.release(model);
			return null;
		}
		// The GLB root carries glTF's metres and Y-up; drop it so node coordinates are the CAD file's again.
		const root = model.children[0];
		root.position.set(0, 0, 0);
		root.quaternion.identity();
		root.scale.set(1, 1, 1);
		if (prepare) {
			try {
				prepare(root);
			} catch (err) {
				this.release(model);
				throw err;
			}
		}
		if (this.model) {
			this.#tool?.detach();
			this.scene.remove(this.model);
			for (const tinted of this.#highlight.values()) tinted.dispose();
			this.release(this.model);
		}
		this.#targets = null;
		this.model = model;

		this.#edges = [];
		this.#highlight.clear();
		this.#highlighted = [];
		const edgeMaterials = new Map<THREE.Material, THREE.LineBasicMaterial>();
		this.model.traverse((object) => {
			const line = object as THREE.LineSegments;
			if (line.isLineSegments) {
				let material = edgeMaterials.get(line.material as THREE.Material);
				if (!material) {
					material = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false });
					edgeMaterials.set(line.material as THREE.Material, material);
					this.#edges.push(material);
				}
				line.material = material;
				line.raycast = () => {};
				line.renderOrder = 1;
				return;
			}
			const mesh = object as THREE.Mesh;
			if (!mesh.isMesh) return;
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			// Instances share their geometry: one BVH serves them all.
			if (this.pickable && !mesh.geometry.boundsTree) mesh.geometry.computeBoundsTree();
			// Surfaces sit a hair behind their edge lines so the lines never flicker.
			const material = mesh.material as THREE.MeshStandardMaterial;
			material.polygonOffset = true;
			material.polygonOffsetFactor = 1;
			material.polygonOffsetUnits = 1;
			reflectiveGlass(material);
		});
		this.scene.add(this.model);
		this.model.updateMatrixWorld(true);

		this.parts = indexParts(root);
		this.section.attach(root);
		this.explode.attach(this.parts);

		this.bounds.setFromObject(root);
		this.radius = this.bounds.getBoundingSphere(new THREE.Sphere()).radius;
		this.#sizeStage();
		this.fit('iso');
		return this.parts;
	}

	/**
	 * Frees a model that leaves the scene, or one parsed that never went in: its geometries and its materials, section
	 * caps included.
	 */
	release(model: THREE.Object3D) {
		const materials = new Set<THREE.Material>();
		model.traverse((object) => {
			const mesh = object as THREE.Mesh;
			mesh.geometry?.dispose();
			if (mesh.material) for (const material of [mesh.material].flat()) materials.add(material);
		});
		for (const material of materials) material.dispose();
	}

	/** The floor's size and the reach of the light's shadow, from the model's size. */
	#sizeStage() {
		this.#ground.scale.set(this.radius * 8, this.radius * 8, 1);
		const shadow = this.#light.shadow.camera;
		shadow.left = shadow.bottom = -this.radius * 1.6;
		shadow.right = shadow.top = this.radius * 1.6;
		shadow.near = this.radius * 0.5;
		shadow.far = this.radius * 6;
		shadow.updateProjectionMatrix();
	}

	/**
	 * The floor lies square to the up axis under the lowest point of what is shown. The light stays on the camera's side
	 * as the view turns about the up axis: turning the model changes the shape of its shadow, not the side it falls on.
	 */
	#placeStage() {
		if (!this.model) return;
		this.camera.updateMatrixWorld();
		this.model.updateMatrixWorld(true);
		const up = upVector(this.#axis);
		const centre = this.bounds.getCenter(new THREE.Vector3());
		// Toward the camera along the floor; looking straight down or up, toward the bottom of the screen.
		const front = this.camera.position.clone().sub(this.controls.target);
		front.addScaledVector(up, -front.dot(up));
		if (front.lengthSq() < 1e-9) front.setFromMatrixColumn(this.camera.matrixWorld, 1).negate();
		front.normalize();
		const right = new THREE.Vector3().crossVectors(up, front);
		let lowest = Infinity;
		const corner = new THREE.Vector3();
		for (const part of this.parts?.byId.values() ?? []) {
			if (part.children.length || !isShown(part)) continue;
			for (const mesh of part.meshes) {
				mesh.geometry.boundingBox ?? mesh.geometry.computeBoundingBox();
				const { min, max } = mesh.geometry.boundingBox!;
				for (let i = 0; i < 8; i++) {
					corner.set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z).applyMatrix4(mesh.matrixWorld);
					lowest = Math.min(lowest, corner.dot(up));
				}
			}
		}
		const height = centre.dot(up);
		if (!Number.isFinite(lowest)) lowest = height - this.radius;
		this.#ground.quaternion.setFromUnitVectors(PLANE_NORMAL, up);
		this.#ground.position.copy(centre).addScaledVector(up, lowest - height - 0.01);
		// Above, toward the camera and a little to the left: with Z up and the Iso view, the light the viewer always had.
		const light = up.multiplyScalar(1.6).addScaledVector(front, 0.6).addScaledVector(right, -0.1);
		this.#light.position.copy(centre).addScaledVector(light, this.radius * 2);
		this.#light.target.position.copy(centre);
	}

	#makeControls() {
		const controls = new OrbitControls(this.camera, this.renderer.domElement);
		controls.enableDamping = true;
		controls.dampingFactor = 0.12;
		controls.screenSpacePanning = true;
		// The camera is reported once it has been still for 300 ms (damping included).
		let settle: ReturnType<typeof setTimeout>;
		controls.addEventListener('change', () => {
			this.requestRender();
			clearTimeout(settle);
			settle = setTimeout(() => this.onCameraChange(), 300);
		});
		// Also on release, in case damping takes long to settle (slow GPUs).
		controls.addEventListener('end', () => this.onCameraChange());
		return controls;
	}

	/**
	 * Which axis of the file points up: the orbit turns about it, the named views and the floor follow it. `refit` shows
	 * the model from Iso again; a caller about to load a model lets the load do that.
	 */
	setUp(axis: UpAxis, refit = true) {
		if (axis === this.#axis) return;
		this.#axis = axis;
		for (const camera of [this.perspective, this.orthographic]) camera.up.copy(upVector(axis));
		// OrbitControls takes its axis from the camera's up when it is made.
		const target = this.controls.target.clone();
		this.controls.dispose();
		this.controls = this.#makeControls();
		this.controls.target.copy(target);
		if (refit) this.fit('iso');
		this.requestRender();
	}

	/** Bounds of what is shown right now: hidden parts left out, explode included. */
	#visibleBounds() {
		const box = new THREE.Box3();
		this.model?.updateMatrixWorld(true);
		for (const part of this.parts?.byId.values() ?? []) {
			if (part.children.length || !isShown(part)) continue;
			for (const mesh of part.meshes) box.expandByObject(mesh);
		}
		return box.isEmpty() ? this.bounds.clone() : box;
	}

	/** Fits what is shown into the free part of the canvas, from a named direction or the current one. */
	fit(view?: NamedView) {
		if (!this.model) return;
		const sphere = this.#visibleBounds().getBoundingSphere(new THREE.Sphere());
		const direction = view ? viewDirection(view, this.#axis) : this.camera.position.clone().sub(this.controls.target).normalize();
		const canvas = this.renderer.domElement;
		const free = canvas.clientWidth - this.#inset.left - this.#inset.right;
		const aspect = Math.max(0.2, free / Math.max(1, canvas.clientHeight));
		const halfV = THREE.MathUtils.degToRad(this.perspective.fov / 2);
		const halfH = Math.atan(Math.tan(halfV) * aspect);
		const distance = sphere.radius / Math.sin(Math.min(halfV, halfH));
		for (const camera of [this.perspective, this.orthographic]) {
			camera.up.copy(cameraUp(direction, this.#axis));
			camera.position.copy(sphere.center).addScaledVector(direction, distance * 1.02);
		}
		this.orthographic.zoom = Math.min(1, aspect) * (this.radius * 1.05) / (sphere.radius * 1.05);
		this.#frustum(this.radius * 1.05);
		this.controls.target.copy(sphere.center);
		this.controls.update();
		this.requestRender();
		this.onCameraChange();
	}

	/** Pixels covered by panels on the left and right: the view centre moves to the middle of what is free. */
	setInset(left: number, right = 0) {
		if (left === this.#inset.left && right === this.#inset.right) return;
		this.#inset = { left, right };
		this.#fitCanvas();
	}

	setOrtho(ortho: boolean) {
		const next = ortho ? this.orthographic : this.perspective;
		if (next === this.camera) return;
		next.position.copy(this.camera.position);
		next.up.copy(this.camera.up);
		if (ortho) {
			// Keep the scale at the orbit target the same.
			const distance = this.camera.position.distanceTo(this.controls.target);
			const halfHeight = distance * Math.tan(THREE.MathUtils.degToRad(this.perspective.fov / 2));
			this.orthographic.zoom = (this.orthographic.top - this.orthographic.bottom) / 2 / halfHeight;
			this.orthographic.updateProjectionMatrix();
		}
		this.camera = next;
		this.controls.object = next;
		this.controls.update();
		this.requestRender();
	}

	getCamera(): Camera {
		const p = this.camera.position, t = this.controls.target;
		const camera: Camera = { position: [p.x, p.y, p.z], target: [t.x, t.y, t.z] };
		if (this.camera === this.orthographic) camera.zoom = this.orthographic.zoom;
		return camera;
	}

	setCamera(camera: Camera) {
		const position = new THREE.Vector3(...camera.position), target = new THREE.Vector3(...camera.target);
		const up = cameraUp(position.clone().sub(target).normalize(), this.#axis);
		for (const c of [this.perspective, this.orthographic]) {
			c.position.copy(position);
			c.up.copy(up);
		}
		if (camera.zoom) this.orthographic.zoom = camera.zoom;
		this.orthographic.updateProjectionMatrix();
		this.controls.target.copy(target);
		this.controls.update();
		this.requestRender();
	}

	setEdges(visible: boolean) {
		for (const material of this.#edges) material.visible = visible;
		this.requestRender();
	}

	setCuts(cuts: Cut[]) {
		this.section.set(cuts);
		for (const [source, tinted] of this.#highlight) tinted.clippingPlanes = source.clippingPlanes;
		this.requestRender();
	}

	setExplode(factor: number) {
		this.explode.set(factor);
		this.#targets = null;
		this.requestRender();
	}

	/** Tints every mesh of the part with the accent colour. */
	highlight(part: Part | null) {
		for (const { mesh, material } of this.#highlighted) mesh.material = material;
		this.#highlighted = [];
		for (const mesh of part?.meshes ?? []) {
			const source = mesh.material as THREE.MeshStandardMaterial;
			let tinted = this.#highlight.get(source);
			if (!tinted) {
				tinted = source.clone();
				tinted.emissive = this.#accent.clone();
				tinted.emissiveIntensity = 0.4;
				reflectiveGlass(tinted);
				this.#highlight.set(source, tinted);
			}
			tinted.clippingPlanes = source.clippingPlanes;
			this.#highlighted.push({ mesh, material: source });
			mesh.material = tinted;
		}
		this.requestRender();
	}

	/** The visible, uncut part under a screen point: the occurrence that owns the body. */
	pick(clientX: number, clientY: number): Part | null {
		const { x, y } = this.canvasPoint({ clientX, clientY });
		const part = this.surfaceAt(x, y)?.part;
		return part ? clickedPart(part) : null;
	}

	/** A pointer position in canvas pixels. */
	canvasPoint(e: { clientX: number; clientY: number }) {
		const rect = this.renderer.domElement.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	}

	/** The world ray through a canvas pixel. */
	rayAt(x: number, y: number, target = new THREE.Ray()) {
		const canvas = this.renderer.domElement;
		const pointer = new THREE.Vector2((x / Math.max(1, canvas.clientWidth)) * 2 - 1, -(y / Math.max(1, canvas.clientHeight)) * 2 + 1);
		this.#raycaster.setFromCamera(pointer, this.camera);
		return target.copy(this.#raycaster.ray);
	}

	/** A world point in canvas pixels, or null when it lies behind the camera. */
	toScreen(point: THREE.Vector3, target = new THREE.Vector2()) {
		const p = this.#projected.copy(point).project(this.camera);
		if (p.z > 1 || p.z < -1) return null;
		const canvas = this.renderer.domElement;
		return target.set(((p.x + 1) / 2) * canvas.clientWidth, ((1 - p.y) / 2) * canvas.clientHeight);
	}

	/**
	 * The shown surface under a canvas pixel. Hits in cut-away space are skipped; the nearest remaining one counts if
	 * it faces the camera. One facing away means the ray entered a cut solid, whose hatched cap covers the pixel, so
	 * nothing is picked there; without a cap (glass), the ray goes on.
	 */
	surfaceAt(x: number, y: number): SurfaceHit | null {
		if (!this.model || !this.parts) return null;
		const ray = this.rayAt(x, y);
		const local = new THREE.Ray();
		const hits: (SurfaceHit & { facing: boolean; capped: boolean })[] = [];
		for (const target of this.#pickTargets()) {
			if (!ray.intersectsSphere(target.sphere) || !isShown(target.part)) continue;
			local.copy(ray).applyMatrix4(target.inverse);
			for (const hit of (target.mesh.geometry.boundsTree as MeshBVH).raycast(local, THREE.DoubleSide)) {
				if (!hit.face) continue;
				const point = hit.point.clone().applyMatrix4(target.mesh.matrixWorld);
				if (!this.section.keeps(point)) continue;
				const facing = hit.face.normal.dot(local.direction) < 0 !== target.mirrored;
				hits.push({ mesh: target.mesh, part: target.part, point, distance: point.distanceTo(ray.origin), vertex: hit.face.a, facing, capped: target.capped });
			}
		}
		hits.sort((a, b) => a.distance - b.distance);
		const cut = this.section.planes.length > 0;
		for (const { facing, capped, ...hit } of hits) {
			if (facing) return hit;
			if (cut && capped) return null;
		}
		return null;
	}

	/** Every pickable mesh with its world bounds, rebuilt when the model or the explode changes. */
	#pickTargets(): Target[] {
		if (this.#targets) return this.#targets;
		this.model?.updateMatrixWorld(true);
		const targets: Target[] = [];
		this.model?.traverse((object) => {
			const mesh = object as THREE.Mesh;
			const part = this.parts?.byObject.get(mesh);
			if (!mesh.isMesh || mesh.userData.cap || !mesh.geometry.boundsTree || !part) return;
			if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
			targets.push({
				mesh,
				part,
				sphere: mesh.geometry.boundingSphere!.clone().applyMatrix4(mesh.matrixWorld),
				inverse: mesh.matrixWorld.clone().invert(),
				mirrored: mesh.matrixWorld.determinant() < 0,
				capped: this.section.hasCap(mesh)
			});
		});
		return (this.#targets = targets);
	}

	#frustum(halfHeight?: number) {
		const canvas = this.renderer.domElement;
		const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
		const h = halfHeight ?? (this.orthographic.top - this.orthographic.bottom) / 2;
		Object.assign(this.orthographic, { left: -h * aspect, right: h * aspect, top: h, bottom: -h });
		this.orthographic.updateProjectionMatrix();
		this.perspective.near = Math.max(0.1, this.radius / 200);
		this.perspective.far = this.radius * 40;
		this.perspective.updateProjectionMatrix();
		const width = canvas.clientWidth, height = canvas.clientHeight;
		const shift = (this.#inset.left - this.#inset.right) / 2;
		for (const camera of [this.perspective, this.orthographic]) {
			if (shift && width && height) camera.setViewOffset(width, height, -shift, 0, width, height);
			else camera.clearViewOffset();
		}
	}

	#fitCanvas() {
		const canvas = this.renderer.domElement;
		const { clientWidth: width, clientHeight: height } = canvas;
		if (!width || !height) return;
		this.renderer.setSize(width, height, false);
		this.perspective.aspect = width / height;
		this.#frustum();
		this.requestRender();
	}

	dispose() {
		this.#tool?.dispose();
		this.#tool = null;
		this.#resize.disconnect();
		this.renderer.setAnimationLoop(null);
		this.controls.dispose();
		this.renderer.dispose();
	}
}
