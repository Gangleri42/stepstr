<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import mark from '../../brand/icon.svg?raw';
	import { ABOUT } from '$lib/about';
	import type { CompanionRevision, CompanionTrack } from '$lib/catalogue/catalogue';
	import { companionFile, companionParam, resolveModel, versionLabel, type CatalogueSource, type Resolved } from '$lib/catalogue/versions';
	import type { Host, ShareLink } from '$lib/host/host';
	import type { MeasureData } from '$lib/measure/format';
	import { routeFromInput } from '$lib/source/input';
	import { companionStages, opener, type Stage } from '$lib/open/open';
	import { blobUrl } from '$lib/source/blossom';
	import { explainLoadError } from '$lib/source/load';
	import { addLocalFile, localFile } from '$lib/source/local';
	import type { KeptCompanion, KeptModel, RecentEntry } from '$lib/recent/types';
	import { decode, defaultState, encode, sameRef, sourceKey, UP_AXES, type Axis, type FileSource, type MeasureRef, type Source, type UpAxis, type ViewState } from '$lib/state/hash';
	import { theme } from '$lib/theme.svelte';
	import MeasurePanel from '$lib/ui/MeasurePanel.svelte';
	import OpenPanel from '$lib/ui/OpenPanel.svelte';
	import PartTree from '$lib/ui/PartTree.svelte';
	import SectionPanel from '$lib/ui/SectionPanel.svelte';
	import type { MeasureStatus, MeasureTool, Outcome } from '$lib/viewer/measure/tool';
	import type { Part, PartIndex } from '$lib/viewer/parts';
	import { applyVisibility } from '$lib/viewer/parts';
	import { COMPANION_SOURCE, fitCompanion } from '$lib/viewer/companion';
	import { applyFinishes } from '$lib/viewer/finishes';
	import type { NamedView, RenderOptions, Viewer } from '$lib/viewer/scene';
	import type { Object3D } from 'three';
	import { title } from 'virtual:stepstr-site';

	let { host }: { host: Host } = $props();
	// The site's catalogue, if it has one, is there from the start and stays.
	const catalogue = untrack(() => host.catalogue ?? null);

	type Model = { name: string; unit: string; download: string | null; local: boolean; triangles: number; warnings: string[] };

	let canvas: HTMLCanvasElement;
	let viewer = $state.raw<Viewer>();
	let parts = $state.raw<PartIndex | null>(null);
	let view = $state<ViewState>(defaultState());
	let model = $state.raw<Model | null>(null);
	/** The source key of the model on screen, and of the one on its way. */
	let loadedKey = $state<string | null>(null);
	let loadingKey: string | null = null;
	let loadedSource: { source: Source; name: string | null } | null = null;
	let stage = $state<Stage | null>(null);
	let failure = $state<{ message: string; hint?: 'local' | 'web' } | null>(null);
	// A site whose catalogue could not be loaded says so as it starts: its model links open nothing without it.
	let notice = $state(untrack(() => (host.catalogueProblem ? `The site's catalogue could not be loaded (${host.catalogueProblem}), so its models are not listed. Reload to try again.` : '')));
	let openShown = $state(false);
	let dragging = $state(false);
	let panelOpen = $state(true);
	let sectionOpen = $state(false);
	let shareOpen = $state(false);
	let stepOpen = $state(false);
	let copied = $state<string | null>(null);
	let fallback = $state<{ label: string; text: string } | null>(null);
	/** Files viewed before on this device, newest first. */
	let recent = $state.raw<RecentEntry[]>([]);
	let narrow = $state(false);
	/** A touch screen without a mouse: Measure has no hover there. */
	let touch = $state(false);

	// Measure: open while the tool is up or while the view holds measured items (a link can bring them).
	let measureOpen = $state(false);
	let measureTool = $state.raw<MeasureTool | null>(null);
	// Measure takes the data of each GLB in the scene, the model's first.
	let measureData = $state.raw<{ key: string; data: MeasureData[] } | null>(null);
	let measureError = $state('');
	let outcome = $state.raw<Outcome | null>(null);
	let snapping = $state(true);
	let precision = $state(2);
	const measuring = $derived(measureOpen || view.measure.length > 0);
	const measureStatus = $derived<MeasureStatus>(
		measureError ? 'error' : !measureData || measureData.key !== loadedKey ? 'loading' : measureData.data.some((file) => file.solids.some(Boolean)) ? 'ready' : 'unavailable'
	);

	const hidden = $derived(new Set(view.hidden));
	const isolated = $derived(new Set(view.isolated));
	const selectedPart = $derived(view.selected ? (parts?.byId.get(view.selected) ?? null) : null);
	const range = $derived.by((): Record<Axis, [number, number]> => {
		const b = viewer && parts ? viewer.bounds : null;
		return b ? { x: [b.min.x, b.max.x], y: [b.min.y, b.max.y], z: [b.min.z, b.max.z] } : { x: [-100, 100], y: [-100, 100], z: [-100, 100] };
	});
	const showOpen = $derived(openShown || (!view.source && !stage));

	/** The file a source names: a catalogue model's is the STEP file of the version the catalogue resolves it to. */
	function fileOf(source: Source | null): { file: FileSource; listed?: Resolved } | null {
		if (source?.kind !== 'catalogue') return source && { file: source };
		const listed = catalogue && resolveModel(catalogue, source);
		return listed ? { file: listed.file, listed } : null;
	}
	/** The key of the file a source names: two sources with one key show the same file, and its recent entry has it. */
	const keyOf = (source: Source | null) => {
		const found = fileOf(source);
		return found && sourceKey(found.file);
	};
	/** The key of what a source shows: its file, and the companion revision in the file's slot. Another one loads again. */
	const loadKeyOf = (source: Source | null) => {
		const found = fileOf(source);
		const revision = found?.listed && companionParam(found.listed.companion);
		return found && `${sourceKey(found.file)}${revision ? ` with ${revision}` : ''}`;
	};
	/**
	 * A catalogue model's route as shown: the version on screen, and the companion revision in its slot, which a route
	 * pinned to a version must name (it shows the slot as in CAD otherwise).
	 */
	function shownSource({ companion: _, ...source }: CatalogueSource, listed: Resolved): Source {
		const companion = companionParam(listed.companion);
		return { ...source, version: listed.version.id, ...(companion ? { companion } : {}) };
	}
	/**
	 * A route to a catalogue model's newest version, whichever that is when the link is opened, in this view: the parts
	 * and the camera, but no measured items, which name faces of this version's bytes, and no companion revision.
	 */
	const latestRoute = (state: ViewState, model: string) => encode({ ...state, source: { kind: 'catalogue', model }, measure: [] });
	/** The catalogue model the route names, as the catalogue resolves it, for the picker. */
	const picked = $derived(view.source?.kind === 'catalogue' ? (fileOf(view.source)?.listed ?? null) : null);
	/** The companion revision in the slot of the model on screen, and one that was asked for and could not be fitted. */
	let companionShown = $state.raw<{ track: CompanionTrack; revision: CompanionRevision } | null>(null);
	let companionFailed = $state.raw<{ id: string; reason: string } | null>(null);
	/** What a link to a version or a companion revision the catalogue does not list is told: it shows other bytes. */
	function lost({ model, version, missing, companion, companionMissing }: Resolved) {
		const said = missing ? [`The catalogue lists no version ${missing} of ${model.title}, so the latest opened.`] : [];
		if (companionMissing) {
			const label = model.companions?.label ?? 'companion';
			const instead = companion.kind === 'revision' ? `the latest, ${companion.revision.id}, is shown` : `${model.title} ${version.id} shows as in CAD`;
			said.push(`The catalogue lists no ${label} ${companionMissing}, so ${instead}.`);
		}
		return said.join(' ');
	}
	/**
	 * A route to the model on screen names its version and companion as shown, whichever it named; a version or companion
	 * the catalogue does not list is said, and a missing version's measured items go.
	 */
	function pinShown(next: ViewState) {
		const listed = fileOf(next.source)?.listed;
		if (next.source?.kind !== 'catalogue' || !listed) return;
		if (listed.missing || listed.companionMissing) notice = lost(listed);
		if (listed.missing) next.measure = [];
		next.source = shownSource(next.source, listed);
	}

	const CONTEXT_LOST = 'The graphics driver stopped the 3D view. Reload the page; if it stays blank, close the tab and open it again.';
	let contextLost = $state(false);
	const NAMED_VIEWS: [NamedView, string][] = [['iso', 'Iso'], ['front', 'Front'], ['top', 'Top'], ['right', 'Right']];
	const UP_LABELS: Record<UpAxis, string> = { z: 'Z', y: 'Y', x: 'X', '-z': '−Z', '-y': '−Y', '-x': '−X' };

	/**
	 * Development only: ?aa=0&dpr=1&shadow=0&stype=pcf&env=0 override what the viewer asks of the GPU, and ?debug shows
	 * what it got, to find what a device chokes on.
	 */
	function devRenderOptions(defaults: RenderOptions): RenderOptions {
		const query = new URLSearchParams(location.search);
		const number = (key: string, otherwise: number) => (query.has(key) && Number.isFinite(Number(query.get(key))) ? Number(query.get(key)) : otherwise);
		return {
			antialias: query.has('aa') ? query.get('aa') !== '0' : defaults.antialias,
			maxPixelRatio: number('dpr', defaults.maxPixelRatio),
			shadowSize: number('shadow', defaults.shadowSize),
			environment: query.get('env') !== '0',
			shadowType: (['pcf', 'basic'] as const).find((t) => t === query.get('stype')) ?? defaults.shadowType
		};
	}
	/** The bytes as an ArrayBuffer of their own, as the GLB parser takes them. */
	const bufferOf = (bytes: Uint8Array) =>
		(bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer) as ArrayBuffer;
	let homeCamera = '';
	const cameraKey = (camera: ViewState['camera']) => encode({ ...defaultState(), camera });
	/** Reads the list again. Reads can finish out of order: the last one asked for wins. */
	let reads = 0;
	async function refreshRecent() {
		const read = ++reads;
		const list = (await host.recent?.list()) ?? [];
		if (read === reads) recent = list;
	}
	const dataUrl = (blob: Blob) =>
		new Promise<string | null>((resolve) => {
			const reader = new FileReader();
			reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
			reader.onerror = () => resolve(null);
			reader.readAsDataURL(blob);
		});
	/** Entries still being written, by key. Forgetting the entry, clearing the list or a newer visit cancels the write. */
	const arriving = new Map<string, symbol>();
	/** The view each file was last seen in this session, by source key. */
	const lastViews = new Map<string, string>();
	/**
	 * Adds the file on screen to the recent list with a snapshot and, when given, its converted model. Without a
	 * snapshot the entry keeps the picture it had.
	 */
	async function keepRecent(entry: RecentEntry, model?: KeptModel, bytes?: Uint8Array, companion?: KeptCompanion) {
		if (!host.recent) return;
		const ticket = Symbol(entry.key);
		arriving.set(entry.key, ticket);
		// Let the first frames settle before the snapshot; a file opened meanwhile must not be pictured as this one.
		await new Promise((resolve) => setTimeout(resolve, 400));
		const shown = loadedKey === loadKeyOf(view.source) && keyOf(view.source) === entry.key;
		let picture: Blob | null = null;
		try {
			picture = shown ? ((await viewer?.snapshot()) ?? null) : null;
		} catch {
			// A lost context throws; the entry goes in without a picture.
		}
		const thumbnail = picture && (await dataUrl(picture));
		if (arriving.get(entry.key) !== ticket) return;
		arriving.delete(entry.key);
		// Record the latest view, not the opening one; otherwise the list keeps the opening view until the next save.
		const route = shown ? encode(view) : (lastViews.get(entry.key) ?? entry.route);
		const kept = model && ABOUT.conversion ? { conversion: ABOUT.conversion, model, ...(bytes ? { bytes } : {}), ...(companion ? { with: companion } : {}) } : undefined;
		await host.recent.remember({ ...entry, route, thumbnail }, kept);
		await refreshRecent();
	}

	onMount(() => {
		const stopTheme = theme.init(host.theme);
		view = decode(host.initialRoute(), catalogue);
		void refreshRecent();
		const query = matchMedia('(max-width: 760px)');
		narrow = query.matches;
		panelOpen = !narrow;
		query.addEventListener('change', (e) => (narrow = e.matches));
		touch = matchMedia('(pointer: coarse)').matches && !matchMedia('(hover: hover)').matches;

		let disposed = false;
		let instance: Viewer | undefined;
		import('$lib/viewer/scene')
			.then(({ Viewer, defaultRenderOptions }) => {
				if (disposed) return;
				const scene = new Viewer(canvas, import.meta.env.DEV ? devRenderOptions(defaultRenderOptions()) : undefined);
				scene.onContextLost = () => (contextLost = true);
				scene.onContextRestored = () => (contextLost = false);
				scene.onCameraChange = () => {
					if (stage) return;
					const camera = scene.getCamera();
					// The view a model opens with stays out of the link.
					view.camera = cameraKey(camera) === homeCamera ? null : camera;
				};
				scene.onPick = (part) => select(part);
				instance = scene;
				viewer = scene;
				if (import.meta.env.DEV) Object.assign(window, { viewer: scene });
			})
			.catch((err: Error) => {
				// Browsers turn WebGL off for a site for a while after its graphics crashed.
				failure = {
					message: /webgl/i.test(err.message)
						? 'Could not start the 3D view: this browser gives the page no WebGL right now. After a graphics crash browsers block it for a while; close the tab, or the browser, and open it again.'
						: `Could not start the 3D view: ${err.message}`
				};
			});

		const stopRoutes = host.onRoute((route) => {
			if (route === encode(view)) return;
			const next = decode(route, catalogue);
			const sameFile = loadKeyOf(next.source) === loadedKey;
			if (sameFile) pinShown(next);
			view = next;
			openShown = false;
			if (sameFile && next.camera) viewer?.setCamera(next.camera);
		});
		const onHidden = () => document.visibilityState === 'hidden' && saveView();
		document.addEventListener('visibilitychange', onHidden);
		addEventListener('pagehide', saveView);
		return () => {
			disposed = true;
			saveView();
			document.removeEventListener('visibilitychange', onHidden);
			removeEventListener('pagehide', saveView);
			stopRoutes();
			stopTheme();
			instance?.dispose();
		};
	});

	// Load the file whenever the route names another one. Only the newest load may touch the scene: a newer one or Cancel
	// aborts its signal, and it is dropped when its bytes, its conversion or its parse arrive.
	const open = opener();
	let controller: AbortController | null = null;
	$effect(() => {
		const scene = viewer;
		if (!scene) return;
		const source = view.source;
		const found = fileOf(source);
		const key = loadKeyOf(source);
		if (!source || !found || !key || key === loadedKey || key === loadingKey) return;
		untrack(() => load(scene, source, found, key));
	});

	async function load(scene: Viewer, source: Source, { file, listed }: { file: FileSource; listed?: Resolved }, key: string) {
		controller?.abort();
		const { signal } = (controller = new AbortController());
		loadingKey = key;
		failure = null;
		notice = '';
		openShown = false;
		// Measured items name faces of one version's bytes: a link to a version the catalogue does not list loses them.
		if (listed?.missing) view.measure = [];
		// Read once and untracked: the camera and the sliders change the view all the time and must not restart the load.
		const wanted = $state.snapshot(view);
		stage = { label: `Opening ${wanted.name ?? listed?.model.title ?? 'the file'}`, fraction: null };
		const onStage = (next: Stage) => (stage = next);
		let parsed: Object3D | null = null;
		let fitted = false;
		try {
			const opened = await open(host, file, wanted.name, onStage, signal);
			const { model: converted, file: loaded, kept, seen } = opened;
			if (signal.aborted) return;
			// The companion revision for the model's slot: the one kept with the model, or else opened as a model is, from
			// its published files or its STEP file. Whatever goes wrong with it, the model shows with its slot as in CAD.
			const choice = listed?.companion.kind === 'revision' ? listed.companion : null;
			let companion: { model: KeptModel; fresh: boolean } | null = null;
			let misfit = '';
			if (choice && catalogue) {
				try {
					if (opened.with?.sha256 === choice.revision.step.sha256) companion = { model: opened.with.model, fresh: false };
					else {
						const got = await open(host, companionFile(catalogue, choice.revision), null, companionStages(onStage), signal);
						companion = { model: { ...got.model, download: got.file.download }, fresh: true };
					}
					if (signal.aborted) return;
					parsed = (await scene.loader.parseAsync(bufferOf(companion.model.glb), '')).scene;
				} catch (err) {
					if (signal.aborted) return;
					misfit = explainLoadError(err).message;
				}
			}
			if (signal.aborted) return;
			stage = { label: 'Preparing the view', fraction: null };
			// The up axis the link names, before the model is framed.
			scene.setUp(wanted.up, false);
			// The finishes the catalogue gives this version's parts and the companion's, and the companion in its slot, before
			// the model is set up and shown.
			const finishes = listed?.version.finishes;
			const prepare = (root: Object3D) => {
				if (finishes?.length) applyFinishes(root, finishes);
				if (!parsed || !choice) return;
				try {
					const own = choice.revision.finishes;
					if (own?.length) applyFinishes(parsed, own);
					const { label } = choice.track;
					fitCompanion(root, parsed, choice.slot, { name: label, component: `${label} ${choice.revision.id}` });
					fitted = true;
				} catch (err) {
					misfit = err instanceof Error ? err.message : String(err);
				}
			};
			const index = await scene.loadBuffer(bufferOf(converted.glb), () => !signal.aborted, prepare);
			if (!index || signal.aborted) return;

			// Pin the route to the bytes it showed, so its part ids and measurements keep their meaning. A catalogue model's
			// route names the version the catalogue gave, by its id, and the companion revision it asked for, shown or not.
			const shown: Source =
				source.kind === 'catalogue'
					? shownSource(source, listed!)
					: source.kind === 'blob' || source.sha256
						? source
						: { ...source, sha256: loaded.sha256 };
			// loadKeyOf is null only for a null source.
			const shownKey = loadKeyOf(shown) ?? key;
			loadedKey = shownKey;
			loadingKey = null;
			loadedSource = { source: shown, name: wanted.name ?? loaded.name };
			if (shown !== source) view.source = shown;
			if (!view.name) view.name = loaded.name;
			parts = index;
			const local = source.kind === 'blob' && (!!localFile(source.sha256) || !!seen?.local);
			model = {
				name: loaded.name,
				unit: converted.unit,
				download: loaded.download,
				local,
				triangles: converted.triangles,
				warnings: converted.warnings
			};
			measureData = { key: shownKey, data: companion && fitted ? [converted.measure, companion.model.measure] : [converted.measure] };
			companionShown = choice && fitted ? { track: choice.track, revision: choice.revision } : null;
			companionFailed = choice && !fitted ? { id: choice.revision.id, reason: misfit } : null;
			stepOpen = false;
			measureError = '';
			// Which model is on screen, and which companion in its slot, by their GLBs' sha256: for tests and bug reports.
			document.documentElement.dataset.glb = converted.measure.glb;
			if (companion && fitted) document.documentElement.dataset.companion = companion.model.measure.glb;
			else delete document.documentElement.dataset.companion;

			const stale = [...wanted.hidden, ...wanted.isolated, ...(wanted.selected ? [wanted.selected] : [])].filter((id) => !index.byId.has(id));
			// A link to a version or a companion the catalogue does not list opened other bytes than it named: that comes
			// first.
			const said = listed && (listed.missing || listed.companionMissing) ? [lost(listed)] : [];
			if (choice && !fitted) {
				said.push(`${choice.track.label} ${choice.revision.id} could not be fitted: ${misfit.replace(/\.$/, '')}. This is ${listed!.model.title} as in CAD.`);
			}
			// A revision that stands in for the one the link named has other parts: measured items on it would land on them.
			if (listed?.companionMissing && fitted) view.measure = view.measure.filter((ref) => index.byId.get(ref.part)?.object.userData.source !== COMPANION_SOURCE);
			if (stale.length) {
				said.push(`${stale.length} part${stale.length > 1 ? 's' : ''} from this link ${stale.length > 1 ? 'are' : 'is'} not in this file.`);
				view.hidden = view.hidden.filter((id) => index.byId.has(id));
				view.isolated = view.isolated.filter((id) => index.byId.has(id));
				if (view.selected && !index.byId.has(view.selected)) view.selected = null;
			} else if (converted.unit !== 'mm' && converted.unit) {
				said.push(`The file is in ${converted.unit}; stepstr shows and measures in millimetres.`);
			}
			notice = said.join(' ');
			homeCamera = cameraKey(scene.getCamera());
			if (wanted.camera) scene.setCamera(wanted.camera);
			stage = null;
			if (import.meta.env.DEV && new URLSearchParams(location.search).has('debug')) setTimeout(() => (notice = scene.describe()), 1500);
			if (!wanted.camera) view.camera = null;
			const entry: RecentEntry = {
				key: keyOf(shown) ?? shownKey,
				route: encode(view),
				name: view.name ?? loaded.name,
				sha256: loaded.sha256,
				size: loaded.size,
				parts: index.byId.size,
				viewedAt: Date.now(),
				local,
				thumbnail: null
			};
			// A model that came from the kept store is already there, unless a companion came with it that was not. One just
			// opened is kept, with its bytes when the file is from this device, and with the companion in its slot.
			const bytes = local && source.kind === 'blob' ? localFile(source.sha256)?.bytes : undefined;
			const shownCompanion = choice && companion && fitted ? { sha256: choice.revision.step.sha256, model: companion.model } : undefined;
			const keep = !kept || (shownCompanion && companion?.fresh);
			void keepRecent(entry, keep ? { ...converted, download: loaded.download } : undefined, bytes, shownCompanion);
		} catch (err) {
			if (signal.aborted) return;
			loadingKey = null;
			stage = null;
			if (err instanceof DOMException && err.name === 'AbortError') return;
			failure = explainLoadError(err);
			openShown = true;
			// The model on screen stays, so the route and Share go back to it, as after a cancel.
			if (loadedSource) {
				view.source = loadedSource.source;
				view.name = loadedSource.name;
			}
		} finally {
			// A companion parsed and not fitted never reached the scene.
			if (parsed && !fitted) scene.release(parsed);
		}
	}

	/** Stops a load and goes back to what was on screen before. */
	function cancel() {
		controller?.abort();
		loadingKey = null;
		stage = null;
		if (loadedSource) {
			view.source = loadedSource.source;
			view.name = loadedSource.name;
		} else {
			view = { ...defaultState(), edges: view.edges, ortho: view.ortho };
		}
	}

	/** Opens a route. A link or a file keeps the edges and projection on screen; a recent file opens as it was left. */
	function openRoute(route: string, asLeft = false) {
		const next = decode(route, catalogue);
		const sameFile = loadKeyOf(next.source) === loadedKey;
		failure = null;
		openShown = false;
		notice = '';
		if (sameFile) pinShown(next);
		view = asLeft ? next : { ...next, edges: view.edges, ortho: view.ortho };
		// The file on screen stays; its view changes, the camera too.
		if (sameFile && next.camera) viewer?.setCamera(next.camera);
	}
	function openText(text: string) {
		const parsed = routeFromInput(text, host.servers, catalogue);
		if ('error' in parsed) {
			failure = { message: parsed.error };
			openShown = true;
		} else openRoute(parsed.route);
	}
	function openBytes(name: string, bytes: Uint8Array) {
		const sha256 = addLocalFile(name, bytes);
		openRoute(encode({ ...defaultState({ kind: 'blob', sha256, servers: [] }), name }));
	}
	async function openFile(file: File) {
		openBytes(file.name, new Uint8Array(await file.arrayBuffer()));
	}
	async function pickWithHost() {
		try {
			const picked = await host.pickFile?.();
			if (picked) openBytes(picked.name, picked.bytes);
		} catch (err) {
			failure = { message: `The file could not be read: ${err instanceof Error ? err.message : String(err)}` };
		}
	}
	/** A file from the recent list. One from this device opens only where its model or bytes were kept, or are open. */
	function openRecent(entry: RecentEntry) {
		if (entry.local && !entry.kept && !localFile(entry.sha256)) {
			failure = { message: `${entry.name} was opened from this device and is not kept here. Choose it again to open it.`, hint: 'local' };
			openShown = true;
			return;
		}
		openRoute(entry.route, true);
	}
	async function forgetRecent(key: string) {
		arriving.delete(key);
		recent = recent.filter((e) => e.key !== key);
		await host.recent?.forget(key);
		await refreshRecent();
	}
	async function clearRecent() {
		arriving.clear();
		recent = [];
		await host.recent?.clear();
		await refreshRecent();
	}
	function openInWebViewer() {
		const url = host.webViewer?.(encode(view));
		if (url) void host.openExternal(url, 'Open in the web viewer');
	}

	/** A file, a link or a STEP file's text pasted anywhere but a text field. */
	function onPaste(e: ClipboardEvent) {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
		const file = e.clipboardData?.files?.[0];
		if (file) {
			e.preventDefault();
			void openFile(file);
			return;
		}
		const text = e.clipboardData?.getData('text/plain') ?? '';
		if (!text.trim()) return;
		e.preventDefault();
		if (/^\s*ISO-10303-21;/.test(text)) openBytes('pasted.step', new TextEncoder().encode(text));
		else openText(text);
	}
	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		const file = e.dataTransfer?.files?.[0];
		if (file) return void openFile(file);
		const text = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain');
		if (text) openText(text.split('\n').find((line) => line && !line.startsWith('#')) ?? text);
	}

	// Push view state into the scene.
	$effect(() => {
		if (!viewer || !parts) return;
		applyVisibility(parts, hidden, isolated);
		viewer.requestRender();
	});
	$effect(() => {
		if (viewer && parts) viewer.setCuts($state.snapshot(view.cuts));
	});
	$effect(() => {
		if (viewer && parts) viewer.setExplode(view.explode);
	});
	// Measurements are taken on the assembled model.
	$effect(() => {
		if (measuring && view.explode) view.explode = 0;
	});
	$effect(() => {
		if (viewer && parts) viewer.setEdges(view.edges);
	});
	$effect(() => {
		if (viewer && parts) viewer.setOrtho(view.ortho);
	});
	$effect(() => {
		if (viewer && parts) viewer.setUp(view.up);
	});
	$effect(() => {
		if (viewer && parts) viewer.highlight(selectedPart);
	});
	$effect(() => {
		// The desktop panels are 300 px wide plus a 12 px margin.
		viewer?.setInset(panelOpen && !narrow && parts ? 312 : 0, measuring && !narrow ? 312 : 0);
	});
	$effect(() => {
		void theme.dark;
		void theme.colors;
		void measureTool;
		if (!viewer) return;
		const css = getComputedStyle(document.documentElement);
		const token = (name: string) => css.getPropertyValue(name).trim();
		viewer.setPalette({ background: token('--viewport'), edges: token('--edges'), accent: token('--accent'), ground: token('--ground'), measure: token('--measure') });
	});

	// The Measure tool arrives with its first use. After a failure it waits for Retry, which clears the error.
	let toolLoading = false;
	$effect(() => {
		if (!measuring || !viewer || measureTool || toolLoading || measureError) return;
		toolLoading = true;
		const target = viewer;
		import('$lib/viewer/measure/tool')
			.then(({ MeasureTool }) => {
				if (viewer !== target) return;
				const tool = new MeasureTool(target, { change: (refs) => (view.measure = refs), outcome: (o) => (outcome = o) });
				target.setTool(tool);
				measureTool = tool;
				if (import.meta.env.DEV) Object.assign(window, { measure: tool });
			})
			.catch((err: Error) => (measureError = `Could not start Measure: ${err.message}`))
			.finally(() => (toolLoading = false));
	});

	// Push Measure's state into the tool. Items a link brings that this file does not have are dropped, with a notice.
	$effect(() => {
		measureTool?.setActive(measuring);
	});
	$effect(() => {
		const current = measureData && measureData.key === loadedKey ? measureData.data : null;
		const tool = measureTool;
		if (!tool) return;
		tool.setModel(current);
		if (!current) return;
		const refs = untrack(() => $state.snapshot(view.measure));
		const keep = refs.filter((ref) => tool.valid(ref));
		if (keep.length < refs.length) {
			const n = refs.length - keep.length;
			// After what the load said, such as a companion that could not be fitted, which takes its items with it.
			const said = `${n} measured item${n > 1 ? 's' : ''} from this link ${n > 1 ? 'are' : 'is'} not in this file.`;
			const before = untrack(() => notice);
			notice = before ? `${before} ${said}` : said;
			view.measure = keep;
		}
	});
	$effect(() => {
		measureTool?.setSelection($state.snapshot(view.measure));
	});
	$effect(() => {
		measureTool?.setSnapping(snapping);
	});
	$effect(() => {
		measureTool?.setPrecision(precision);
	});

	// Mirror the view into the route (the URL hash on the web) without adding history entries.
	let routeTimer: ReturnType<typeof setTimeout>;
	$effect(() => {
		const route = encode(view);
		clearTimeout(routeTimer);
		routeTimer = setTimeout(() => host.publishRoute(route), 250);
	});
	// A file in the recent list reopens in the view it was left in: a file's view goes into the list once it has been
	// still for a moment, and at once when another file opens or the page is hidden.
	let recentTimer: ReturnType<typeof setTimeout>;
	let unsaved: { key: string; route: string } | null = null;
	function saveView() {
		clearTimeout(recentTimer);
		if (unsaved) void host.recent?.update(unsaved.key, unsaved.route);
		unsaved = null;
	}
	$effect(() => {
		const route = encode(view);
		const key = keyOf(view.source);
		if (!key || !loadedKey || stage || loadKeyOf(view.source) !== loadedKey) {
			saveView();
			return;
		}
		clearTimeout(recentTimer);
		unsaved = { key, route };
		lastViews.set(key, route);
		recentTimer = setTimeout(saveView, 1500);
	});
	// Reread the list whenever the Open panel opens.
	$effect(() => {
		if (showOpen) void untrack(refreshRecent);
	});

	/** A new plane removes the half that faces the camera, so the cut face is in view. */
	function flipFor(axis: Axis) {
		if (!viewer) return false;
		const i = { x: 0, y: 1, z: 2 }[axis];
		const camera = viewer.getCamera();
		return camera.position[i] < camera.target[i];
	}

	function select(part: Part | null) {
		view.selected = part?.id ?? null;
		if (part && narrow) panelOpen = true;
	}
	function toggle(ids: string[], visible: boolean) {
		const set = new Set(view.hidden);
		for (const id of ids) {
			if (visible) set.delete(id);
			else set.add(id);
		}
		view.hidden = [...set];
	}
	function isolate(part: Part) {
		view.isolated = view.isolated.length === 1 && view.isolated[0] === part.id ? [] : [part.id];
		view.hidden = view.hidden.filter((id) => id !== part.id);
	}
	function showAll() {
		view.hidden = [];
		view.isolated = [];
	}
	/** Steps to the next axis that may point up, or with `back` to the one before. */
	function stepUp(back: boolean) {
		const at = UP_AXES.indexOf(view.up);
		view.up = UP_AXES[(at + (back ? UP_AXES.length - 1 : 1)) % UP_AXES.length];
	}
	/** Opens a catalogue model at its latest version; the model on screen at its latest stays as it is. */
	function pickModel(name: string) {
		if (view.source?.kind === 'catalogue' && view.source.model === name && picked?.version === picked?.model.versions[0]) return;
		const next = { ...defaultState({ kind: 'catalogue', model: name }), edges: view.edges, ortho: view.ortho };
		failure = null;
		notice = '';
		if (loadKeyOf(next.source) === loadedKey) pinShown(next);
		view = next;
	}
	/** Another version of the model on screen; "latest" is the newest the catalogue lists. Measured items stay with theirs. */
	function pickVersion(value: string) {
		if (view.source?.kind !== 'catalogue' || !picked) return;
		view.source = { ...view.source, version: value === 'latest' ? picked.model.versions[0].id : value };
		view.measure = [];
		notice = '';
	}
	/**
	 * Another companion revision in the slot, or the part as in CAD, which a route pinned to a version shows unless it names
	 * one. What the link names of the companion on screen goes with it: those parts and faces are not in another revision.
	 */
	function pickCompanion(value: string) {
		if (view.source?.kind !== 'catalogue') return;
		const { companion: _, ...source } = view.source;
		const onCompanion = (id: string) => parts?.byId.get(id)?.object.userData.source === COMPANION_SOURCE;
		view.source = value === 'cad' && source.version ? source : { ...source, companion: value };
		view.hidden = view.hidden.filter((id) => !onCompanion(id));
		view.isolated = view.isolated.filter((id) => !onCompanion(id));
		if (view.selected && onCompanion(view.selected)) view.selected = null;
		view.measure = view.measure.filter((ref) => !onCompanion(ref.part));
		notice = '';
	}
	function openMeasure() {
		measureOpen = true;
		sectionOpen = shareOpen = false;
		if (narrow) panelOpen = false;
	}
	function closeMeasure() {
		measureOpen = false;
		view.measure = [];
	}
	function swapMeasure(from: MeasureRef, to: MeasureRef) {
		view.measure = view.measure.map((ref) => (sameRef(ref, from) ? to : ref));
	}
	/** `group` tells a catalogue model's two sets of links apart: to this version, and to the latest. */
	async function share(link: ShareLink, group?: 'this' | 'latest') {
		fallback = null;
		if (await host.copy(link.text)) {
			copied = group ? `${group} ${link.id}` : link.id;
			setTimeout(() => (copied = null), 1600);
		} else {
			fallback = { label: link.label, text: link.text };
		}
	}
	async function download(url: string, what = 'the STEP file') {
		stepOpen = false;
		if (await host.openExternal(url, `Download ${what}`)) return;
		fallback = { label: 'STEP download', text: url };
		shareOpen = true;
		sectionOpen = false;
	}
	function onKey(e: KeyboardEvent) {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
		if (e.key === 'Escape') {
			if (stage) return cancel();
			if (showOpen && loadedKey) {
				openShown = false;
				return;
			}
			if (measuring && !sectionOpen && !shareOpen && !stepOpen) {
				// First Esc clears the measurement, the next closes the tool.
				if (view.measure.length) view.measure = [];
				else closeMeasure();
				return;
			}
			view.selected = null;
			sectionOpen = shareOpen = stepOpen = false;
		}
		if (e.key === 'f' && !e.metaKey && !e.ctrlKey && !e.altKey) viewer?.fit();
		if (e.key === 'o' && !e.metaKey && !e.ctrlKey && !e.altKey) openShown = true;
		if (e.key.toLowerCase() === 'u' && !e.metaKey && !e.ctrlKey && !e.altKey && parts) stepUp(e.shiftKey);
		// Fusion's key for Measure.
		if (e.key.toLowerCase() === 'i' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat && parts) {
			if (measuring) closeMeasure();
			else openMeasure();
		}
	}
</script>

<svelte:window onkeydown={onKey} onpaste={onPaste} />
<svelte:head>
	<title>{model?.name ?? view.name ?? 'Open a STEP file'} · {title}</title>
</svelte:head>

<main
	class:panel-open={panelOpen && !!parts}
	class:measure-open={measuring && !narrow}
	ondragover={(e) => {
		e.preventDefault();
		dragging = true;
	}}
	ondragleave={(e) => {
		if (!e.relatedTarget) dragging = false;
	}}
	ondrop={onDrop}
>
	<canvas bind:this={canvas}></canvas>

	<header>
		<div class="brand">
			<span class="mark" aria-hidden="true">{@html mark}</span>
			<span class="name" class:beside={!!catalogue}>{title}</span>
			{#if catalogue}
				<nav class="models" aria-label="Model">
					{#each Object.entries(catalogue.models) as [name, entry] (name)}
						{@const on = view.source?.kind === 'catalogue' && view.source.model === name}
						<button class:on aria-pressed={on} onclick={() => pickModel(name)}>{entry.title}</button>
					{/each}
				</nav>
			{/if}
			{#if picked}
				<select class="version" aria-label="Version" value={view.source?.kind === 'catalogue' && view.source.version ? picked.version.id : 'latest'} onchange={(e) => pickVersion(e.currentTarget.value)}>
					<option value="latest">latest</option>
					{#each picked.model.versions as version (version.id)}
						<option value={version.id}>{versionLabel(version)}</option>
					{/each}
				</select>
			{:else if model}
				<span class="file" title={model.name}>{model.name}</span>
			{/if}
		</div>
		<div class="actions">
			<button class="pill" onclick={() => ((openShown = !showOpen || !loadedKey), (shareOpen = sectionOpen = stepOpen = false))} title="Open a file (O)">
				<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6.5V15a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 17 15V8a1.5 1.5 0 0 0-1.5-1.5H10L8.5 4.5h-4A1.5 1.5 0 0 0 3 6Z" /></svg>
				<span class="label">Open</span>
			</button>
			{#if model}
				<div class="pop">
					<button class="pill" onclick={() => ((shareOpen = !shareOpen), (sectionOpen = stepOpen = false), (fallback = null))} aria-expanded={shareOpen}>
						<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8.5 11.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1M11.5 8.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1" /></svg>
						<span class="label">Share</span>
					</button>
					{#if shareOpen}
						{@const links = host.shareLinks(encode(view))}
						<div class="menu" role="menu">
							{#if view.source?.kind === 'catalogue'}
								{@const latest = host.shareLinks(latestRoute(view, view.source.model))}
								<p>This version: the link keeps it, with its parts, cuts, explode, camera and measurements.</p>
								{#each links as link (link.id)}
									<button role="menuitem" onclick={() => share(link, 'this')}>{copied === `this ${link.id}` ? 'Copied' : link.label} <small>{link.hint}</small></button>
								{/each}
								<p>Always the latest: the link opens the newest version in this view, without measurements.</p>
								{#each latest as link (link.id)}
									<button role="menuitem" onclick={() => share(link, 'latest')}>{copied === `latest ${link.id}` ? 'Copied' : link.label} <small>{link.hint}</small></button>
								{/each}
							{:else}
								{#if model.local}
									<p>This file is only on this device: a link opens it for someone else once the file is on a Blossom server.</p>
								{:else}
									<p>The link keeps the file, parts, cuts, explode, camera and measurements.</p>
								{/if}
								{#each links as link (link.id)}
									<button role="menuitem" onclick={() => share(link)}>{copied === link.id ? 'Copied' : link.label} <small>{link.hint}</small></button>
								{/each}
							{/if}
							{#if fallback}
								<label class="fallback">
									<small>Copying is not allowed here. {fallback.label}:</small>
									<input type="text" readonly value={fallback.text} onfocus={(e) => e.currentTarget.select()} />
								</label>
							{/if}
						</div>
					{/if}
				</div>
				{#if model.download && companionShown && catalogue}
					{@const url = model.download}
					{@const { track, revision } = companionShown}
					{@const zipped = blobUrl(catalogue.servers[0], revision.step.sha256, 'zip')}
					<div class="pop">
						<button class="pill" onclick={() => ((stepOpen = !stepOpen), (shareOpen = sectionOpen = false))} aria-expanded={stepOpen} title="Download the STEP files">
							<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v10M5.5 8.5 10 13l4.5-4.5M4 16.5h12" /></svg>
							<span class="label">STEP</span>
						</button>
						{#if stepOpen}
							<div class="menu" role="menu">
								<button role="menuitem" onclick={() => download(url)}>{model.name} <small>The model's STEP file</small></button>
								<button role="menuitem" onclick={() => download(zipped, `the ${track.label}'s STEP file`)}>
									{track.label} {revision.id} <small>Its STEP file, zipped, {(revision.step.size / 1e6).toFixed(1)} MB</small>
								</button>
							</div>
						{/if}
					</div>
				{:else if model.download}
					{@const url = model.download}
					<button class="pill" onclick={() => download(url)} title="Download the STEP file">
						<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v10M5.5 8.5 10 13l4.5-4.5M4 16.5h12" /></svg>
						<span class="label">STEP</span>
					</button>
				{/if}
			{/if}
		</div>
	</header>

	{#if panelOpen && parts}
		<aside class="panel" aria-label="Parts">
			<div class="panel-head">
				<h2>Parts</h2>
				{#if view.hidden.length || view.isolated.length}
					<button class="link" onclick={showAll}>Show all</button>
				{/if}
				{#if narrow}
					<button class="link" onclick={() => (panelOpen = false)}>Close</button>
				{/if}
			</div>
			{#if model?.warnings.length}
				<details class="notes">
					<summary>{model.warnings.length} conversion note{model.warnings.length > 1 ? 's' : ''}</summary>
					<ul>
						{#each model.warnings as warning (warning)}
							<li>{warning}</li>
						{/each}
					</ul>
				</details>
			{/if}
			{#if picked?.model.companions && picked.version.slot !== undefined}
				{@const track = picked.model.companions}
				{@const choice = picked.companion}
				{@const revisionNotes = picked.version.slot !== null && choice.kind === 'revision' ? (choice.revision.notes ?? []) : []}
				<div class="notes companion">
					{#if picked.version.slot === null}
						<span class="title">{track.label}</span>
						<span class="warn">The {track.label} does not line up with this version, so it shows as in CAD.</span>
					{:else}
						<label>
							<span class="title">{track.label}</span>
							<select class="version" value={choice.kind === 'revision' ? choice.revision.id : 'cad'} onchange={(e) => pickCompanion(e.currentTarget.value)}>
								<option value="cad">As in CAD</option>
								{#each track.revisions as revision (revision.id)}
									<option value={revision.id}>{versionLabel(revision)}{revision.id === track.latest ? ' · latest' : ''}</option>
								{/each}
							</select>
						</label>
						<span>{choice.kind === 'revision' ? choice.revision.subject || track.source : `The ${track.label} exported with this version`}</span>
						{#if companionFailed && choice.kind === 'revision' && companionFailed.id === choice.revision.id}
							<span class="warn">{companionFailed.id} could not be fitted: {companionFailed.reason}</span>
						{/if}
					{/if}
					{#if track.notes?.length || revisionNotes.length}
						<ul aria-label="Notes on the {track.label}">
							{#each track.notes ?? [] as note (note)}
								<li>{note}</li>
							{/each}
							{#each revisionNotes as note (note)}
								<li>{note}</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/if}
			{#if selectedPart}
				{@const part = selectedPart}
				<div class="selection">
					<div class="sel-name">{part.name}</div>
					{#if part.component && part.component !== part.name}
						<div class="sel-meta">{part.component}</div>
					{/if}
					<div class="sel-actions">
						<button onclick={() => isolate(part)}>{view.isolated.includes(part.id) ? 'Show everything' : 'Show only'}</button>
						<button onclick={() => toggle([part.id], hidden.has(part.id))}>{hidden.has(part.id) ? 'Show' : 'Hide'}</button>
						<button onclick={() => (view.selected = null)}>Deselect</button>
					</div>
				</div>
			{/if}
			<PartTree roots={parts.roots} {hidden} {isolated} selected={view.selected} onToggle={toggle} onSelect={select} onIsolate={isolate} />
		</aside>
	{/if}

	{#if measuring && parts && !(narrow && (panelOpen || sectionOpen))}
		<aside class="card measure-card">
			<MeasurePanel
				{outcome}
				status={measureStatus}
				error={measureError}
				unavailable="No part of this file has exact geometry to measure."
				{snapping}
				{precision}
				{touch}
				onSnapping={(on) => (snapping = on)}
				onPrecision={(decimals) => (precision = decimals)}
				onRemove={(ref) => (view.measure = view.measure.filter((r) => !sameRef(r, ref)))}
				onSwap={swapMeasure}
				onClear={() => (view.measure = [])}
				onClose={closeMeasure}
				onRetry={() => (measureError = '')}
				onFocus={(row) => measureTool?.focus(row)}
				onCopy={(text) => host.copy(text)}
			/>
		</aside>
	{/if}

	{#if parts}
		<div class="dock">
			{#if sectionOpen}
				<div class="card">
					<SectionPanel cuts={view.cuts} {range} {flipFor} onChange={(cuts) => (view.cuts = cuts)} />
				</div>
			{/if}
			<div class="toolbar" role="toolbar" aria-label="View">
				<button class="tool" class:on={panelOpen} onclick={() => (panelOpen = !panelOpen)} aria-pressed={panelOpen} title="Parts">
					<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M6 10h11M9 15h8" /></svg>
					<span>Parts</span>
				</button>
				<span class="sep"></span>
				<button class="tool" onclick={() => viewer?.fit()} title="Fit (F)">
					<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4" /></svg>
					<span>Fit</span>
				</button>
				<div class="views">
					{#each NAMED_VIEWS as [name, label] (name)}
						<button class="tool small" onclick={() => viewer?.fit(name)}>{label}</button>
					{/each}
					<button class="tool small" onclick={(e) => stepUp(e.shiftKey)} title="Which axis of the file points up (U; Shift steps back)">Up {UP_LABELS[view.up]}</button>
				</div>
				<button class="tool small" class:on={view.ortho} onclick={() => (view.ortho = !view.ortho)} aria-pressed={view.ortho} title="Orthographic">Ortho</button>
				<button class="tool small" class:on={view.edges} onclick={() => (view.edges = !view.edges)} aria-pressed={view.edges} title="Edge lines">Edges</button>
				<span class="sep"></span>
				<button class="tool" class:on={sectionOpen || view.cuts.length > 0} onclick={() => ((sectionOpen = !sectionOpen), (shareOpen = false))} aria-expanded={sectionOpen} title="Section">
					<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6.5 10 3l7 3.5v7L10 17l-7-3.5Z" /><path d="M3 10h14" stroke-dasharray="2 2" /></svg>
					<span>Section{view.cuts.length ? ` ${view.cuts.length}` : ''}</span>
				</button>
				<button class="tool" class:on={measuring} onclick={() => (measuring ? closeMeasure() : openMeasure())} aria-pressed={measuring} title="Measure (I)">
					<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 13 13 2.5l4.5 4.5L7 17.5Z" /><path d="M5.5 10l2 2M8 7.5l1.5 1.5M10.5 5l2 2" /></svg>
					<span>Measure</span>
				</button>
				<label class="explode" class:off={measuring} title={measuring ? 'Explode is off while measuring' : 'Explode'}>
					<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7.5" y="7.5" width="5" height="5" rx="1" /><path d="M4 4l2 2M16 4l-2 2M4 16l2-2M16 16l-2-2" /></svg>
					<input type="range" min="0" max="1" step="0.01" bind:value={view.explode} disabled={measuring} aria-label="Explode" />
				</label>
			</div>
		</div>
	{/if}

	{#if showOpen && !stage}
		<OpenPanel
			error={failure}
			{recent}
			onRecent={openRecent}
			onForget={forgetRecent}
			onClearRecent={clearRecent}
			closable={!!loadedKey}
			onText={openText}
			onFile={openFile}
			onPick={host.pickFile ? pickWithHost : undefined}
			onWeb={host.webViewer ? openInWebViewer : undefined}
			onClose={() => ((openShown = false), (failure = null))}
		/>
	{/if}

	{#if stage}
		<div class="loading" role="status">
			<div class="bar"><div class:unknown={stage.fraction === null} style:width="{Math.round((stage.fraction ?? 0.35) * 100)}%"></div></div>
			<span>{stage.label}</span>
			{#if stage.note}
				<p class="note">{stage.note}</p>
			{/if}
			<button class="link" onclick={cancel}>Cancel</button>
		</div>
	{/if}
	{#if dragging}
		<div class="drop" aria-hidden="true">Drop to open</div>
	{/if}
	{#if contextLost}
		<p class="toast" role="alert">{CONTEXT_LOST}</p>
	{:else if notice && !stage}
		<p class="toast" role="status">{notice} <button class="link" onclick={() => (notice = '')}>OK</button></p>
	{/if}
</main>

<style>
	main {
		position: fixed;
		inset: 0;
		overflow: hidden;
	}
	canvas {
		position: absolute;
		inset: 0;
		display: block;
		width: 100%;
		height: 100%;
		touch-action: none;
		outline: none;
	}
	button,
	select {
		font: inherit;
		color: var(--text);
	}
	button:focus-visible,
	select:focus-visible,
	input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
	svg {
		width: 18px;
		height: 18px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
		flex: none;
	}
	.brand,
	.pill,
	.panel,
	.toolbar,
	.card,
	.menu,
	.toast,
	.loading {
		background: var(--surface);
		border: 1px solid var(--line);
		backdrop-filter: blur(16px) saturate(1.4);
		-webkit-backdrop-filter: blur(16px) saturate(1.4);
		box-shadow: var(--shadow);
	}

	/* header */
	header {
		position: absolute;
		top: calc(env(safe-area-inset-top, 0px) + 12px);
		left: max(12px, env(safe-area-inset-left, 0px));
		right: max(12px, env(safe-area-inset-right, 0px));
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 8px;
		pointer-events: none;
		z-index: 3;
	}
	header > * {
		pointer-events: auto;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 6px;
		border-radius: 12px;
		padding: 4px;
		min-width: 0;
	}
	.mark {
		width: 24px;
		height: 24px;
		margin: 0 4px 0 4px;
		flex: none;
	}
	.mark :global(svg) {
		display: block;
		width: 100%;
		height: 100%;
	}
	.name {
		font-weight: 650;
		font-size: 14px;
		letter-spacing: 0.02em;
		padding-right: 4px;
	}
	.models {
		display: flex;
		gap: 2px;
	}
	.models button {
		border: 0;
		background: none;
		padding: 6px 10px;
		border-radius: 8px;
		font-weight: 600;
		font-size: 13px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--muted);
		cursor: pointer;
		white-space: nowrap;
	}
	.models button.on {
		color: var(--text);
		background: var(--hover);
	}
	.version {
		border: 0;
		background: none;
		color: var(--muted);
		padding: 6px 4px;
		border-radius: 8px;
		cursor: pointer;
		font-size: 13px;
		font-variant-numeric: tabular-nums;
		min-width: 0;
		max-width: 150px;
	}
	.file {
		color: var(--muted);
		font-size: 13px;
		padding: 0 8px 0 2px;
		min-width: 0;
		max-width: 320px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.actions {
		display: flex;
		gap: 6px;
		flex: none;
	}
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 38px;
		padding: 0 12px;
		border-radius: 12px;
		cursor: pointer;
		text-decoration: none;
	}
	.pop {
		position: relative;
	}
	.menu {
		position: absolute;
		right: 0;
		top: calc(100% + 6px);
		width: 280px;
		border-radius: 12px;
		padding: 6px;
		display: grid;
		gap: 2px;
	}
	.menu p {
		margin: 6px 8px 8px;
		color: var(--muted);
		font-size: 12px;
	}
	.menu button {
		text-align: left;
		border: 0;
		background: none;
		border-radius: 8px;
		padding: 8px;
		cursor: pointer;
		font-weight: 500;
	}
	.menu button:hover {
		background: var(--hover);
	}
	.menu small {
		display: block;
		color: var(--muted);
		font-weight: 400;
	}
	.fallback {
		display: grid;
		gap: 4px;
		padding: 6px 8px 8px;
	}
	.fallback input {
		font: inherit;
		font-size: 12px;
		color: var(--text);
		background: var(--field);
		border: 1px solid var(--line-strong);
		border-radius: 6px;
		padding: 6px 8px;
		width: 100%;
		box-sizing: border-box;
	}

	/* parts panel */
	.panel {
		position: absolute;
		top: calc(env(safe-area-inset-top, 0px) + 64px);
		left: max(12px, env(safe-area-inset-left, 0px));
		bottom: calc(env(safe-area-inset-bottom, 0px) + 76px);
		width: 300px;
		border-radius: 14px;
		display: flex;
		flex-direction: column;
		z-index: 2;
		overflow: hidden;
	}
	.panel-head {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 14px 8px;
	}
	h2 {
		font-size: 13px;
		font-weight: 600;
		margin: 0 auto 0 0;
		letter-spacing: 0.02em;
	}
	.link {
		border: 0;
		background: none;
		color: var(--accent-text);
		cursor: pointer;
		padding: 2px 4px;
		font-size: 13px;
	}
	.notes {
		margin: 0 12px 8px;
		font-size: 12px;
		color: var(--muted);
	}
	.notes summary {
		cursor: pointer;
		width: fit-content;
	}
	.notes ul {
		margin: 6px 0 0;
		padding-left: 16px;
		max-height: 140px;
		overflow-y: auto;
		overflow-wrap: anywhere;
	}
	.companion {
		display: grid;
		gap: 2px;
		overflow-wrap: anywhere;
	}
	.companion label {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.companion .version {
		flex: 1;
		max-width: none;
	}
	.companion .title {
		color: var(--text);
		font-weight: 600;
	}
	.warn {
		color: var(--accent-text);
	}
	.selection {
		margin: 0 12px 10px;
		padding: 10px 12px;
		border-radius: 10px;
		background: var(--accent-soft);
	}
	.sel-name {
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.sel-meta {
		color: var(--muted);
		font-size: 12px;
		margin-top: 2px;
		overflow-wrap: anywhere;
	}
	.sel-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 8px;
	}
	.sel-actions button {
		border: 1px solid var(--line);
		background: var(--surface-solid);
		border-radius: 8px;
		padding: 4px 10px;
		font-size: 12px;
		cursor: pointer;
	}

	/* bottom dock */
	.dock {
		position: absolute;
		left: 50%;
		bottom: calc(env(safe-area-inset-bottom, 0px) + 12px);
		transform: translateX(-50%);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		max-width: calc(100% - 24px);
		z-index: 3;
	}
	main.panel-open .dock {
		left: calc(50% + 156px);
		max-width: calc(100% - 336px);
	}
	main.measure-open .dock {
		left: calc(50% - 156px);
		max-width: calc(100% - 336px);
	}
	main.panel-open.measure-open .dock {
		left: 50%;
		max-width: calc(100% - 648px);
	}
	.measure-card {
		position: absolute;
		top: calc(env(safe-area-inset-top, 0px) + 64px);
		right: max(12px, env(safe-area-inset-right, 0px));
		width: 300px;
		max-height: calc(100% - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 152px);
		overflow: auto;
		box-sizing: border-box;
		border-radius: 14px;
		padding: 12px;
		z-index: 2;
	}
	.card {
		border-radius: 14px;
		padding: 12px;
		width: min(380px, calc(100vw - 24px));
	}
	.toolbar {
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 4px;
		border-radius: 14px;
		max-width: 100%;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.tool {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: 36px;
		padding: 0 10px;
		border: 0;
		border-radius: 10px;
		background: none;
		cursor: pointer;
		white-space: nowrap;
		flex: none;
	}
	.tool:hover {
		background: var(--hover);
	}
	.tool.on {
		color: var(--accent-text);
		background: var(--accent-soft);
	}
	.tool.small {
		padding: 0 8px;
		font-size: 13px;
	}
	.views {
		display: flex;
		gap: 2px;
	}
	.sep {
		width: 1px;
		height: 22px;
		background: var(--line);
		margin: 0 4px;
		flex: none;
	}
	.explode {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 0 10px 0 8px;
		color: var(--text);
		flex: none;
	}
	.explode input {
		width: 110px;
		accent-color: var(--accent);
	}
	.explode.off {
		opacity: 0.45;
	}
	.tool:disabled {
		opacity: 0.45;
		cursor: default;
	}

	/* status */
	.loading {
		position: absolute;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		border-radius: 12px;
		padding: 14px 18px;
		display: grid;
		gap: 10px;
		justify-items: center;
		color: var(--muted);
		z-index: 4;
	}
	.loading .note {
		margin: 0;
		max-width: 34ch;
		font-size: 12px;
		line-height: 1.45;
		text-align: center;
	}
	.bar {
		width: 200px;
		height: 3px;
		border-radius: 2px;
		background: var(--line);
		overflow: hidden;
	}
	.bar div {
		height: 100%;
		background: var(--accent);
		transition: width 0.15s;
	}
	/* Unknown progress: a band that keeps moving even while the converter holds the page's thread. */
	.bar div.unknown {
		animation: sweep 1.2s ease-in-out infinite;
	}
	@keyframes sweep {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(290%);
		}
	}
	.drop {
		position: absolute;
		inset: 12px;
		border: 2px dashed var(--accent);
		border-radius: 18px;
		display: grid;
		place-items: center;
		font-size: 18px;
		font-weight: 600;
		color: var(--accent-text);
		background: color-mix(in srgb, var(--viewport) 70%, transparent);
		pointer-events: none;
		z-index: 6;
	}
	.toast {
		position: absolute;
		top: calc(env(safe-area-inset-top, 0px) + 64px);
		left: 50%;
		transform: translateX(-50%);
		margin: 0;
		border-radius: 10px;
		padding: 8px 12px;
		z-index: 4;
		max-width: calc(100% - 24px);
	}

	/* phones: the parts panel becomes a bottom sheet above the dock */
	@media (max-width: 760px) {
		.label,
		.views,
		.tool span,
		.name.beside {
			display: none;
		}
		.pill {
			width: 38px;
			padding: 0;
			justify-content: center;
		}
		.panel {
			top: auto;
			left: 8px;
			right: 8px;
			bottom: calc(env(safe-area-inset-bottom, 0px) + 68px);
			width: auto;
			height: 55dvh;
		}
		main.panel-open .dock {
			left: 50%;
			max-width: calc(100% - 16px);
		}
		.measure-card {
			top: calc(env(safe-area-inset-top, 0px) + 58px);
			left: 8px;
			right: 8px;
			width: auto;
			max-height: 42dvh;
		}
		.explode input {
			width: 90px;
		}
	}
	@media (max-width: 480px) {
		.mark {
			display: none;
		}
		.brand {
			gap: 2px;
		}
		.file {
			max-width: 120px;
		}
		.models button {
			padding: 6px 7px;
		}
		.version {
			max-width: 88px;
		}
		.actions {
			gap: 4px;
		}
		.pill {
			width: 34px;
			height: 34px;
		}
		.explode input {
			width: 64px;
		}
		.tool {
			padding: 0 8px;
		}
	}
</style>
