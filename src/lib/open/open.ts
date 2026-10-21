// Opening a file up to its converted model: what this device kept of it, its bytes, the conversion. The app puts the
// model on screen. A load counts only while its signal is not aborted, and that signal is the one check: a newer load
// or Cancel aborts it, and from then on it reports no stage and gives no model.
import { ABOUT } from '$lib/about';
import { jitOff } from '$lib/convert/jit';
import type { Converted, ConvertProgress } from '$lib/convert/types';
import type { Host } from '$lib/host/host';
import type { RecentEntry } from '$lib/recent/types';
import { loadSource, type Loaded } from '$lib/source/load';
import { addLocalFile, localFile } from '$lib/source/local';
import { sourceKey, type FileSource } from '$lib/state/hash';

/** What the app shows while a file opens; `note` is a line below the label. */
export type Stage = { label: string; fraction: number | null; note?: string };

/** Said under every stage of a conversion in a browser that runs without a JIT. */
export const NO_JIT = `Heads up: JavaScript JIT is off for this site, so converting takes several times longer. Turning it on in the browser's site settings speeds it up.`;

export type Opened = {
	/** The converted model, or the one kept on this device. */
	model: Omit<Converted, 'ms'>;
	/** The file as loaded: what a link pins and where it can be downloaded. */
	file: Omit<Loaded, 'bytes'>;
	/** The model was kept on this device: nothing was downloaded or converted. */
	kept: boolean;
	/** The file's entry in the recent list, when it has one. */
	seen: RecentEntry | null;
};

/** How long a load waits on the recent list's store: for an entry, and for a kept model or file, which can be large. */
export const QUICK_LOOKUP = 2_000;
export const SLOW_LOOKUP = 15_000;
/** The last few files converted this session stay at hand: going back to one is instant. */
const KEEP_CONVERTED = 3;

/** What a lookup gives within `ms`, or `fallback` when it fails or takes longer: a store slow to answer holds no file up. */
function within<T>(ms: number, lookup: Promise<T> | null | undefined, fallback: NoInfer<T>): Promise<T> {
	if (!lookup) return Promise.resolve(fallback);
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(fallback), ms);
		lookup.then(resolve, () => resolve(fallback)).finally(() => clearTimeout(timer));
	});
}

/** How far a conversion has come, in words. */
function describe(progress: ConvertProgress): Stage {
	const of = progress.total ? ` ${Math.min(progress.done ?? 0, progress.total) + 1} of ${progress.total}` : '';
	const fraction = progress.total ? (progress.done ?? 0) / progress.total : null;
	switch (progress.phase) {
		case 'start':
			return { label: 'Starting the converter', fraction: null };
		case 'read':
			return { label: 'Reading the STEP file', fraction: progress.fraction ?? null };
		case 'transfer':
			return { label: 'Building the shapes', fraction: progress.fraction ?? null };
		case 'plan':
			return { label: `Sizing part${of}`, fraction };
		case 'mesh':
			return { label: `Meshing part${of}`, fraction };
		case 'build':
			return { label: `Preparing part${of}`, fraction };
		case 'geometry':
			return { label: `Measuring part${of}`, fraction };
	}
}

/**
 * Opens files for one app. It remembers the last few conversions, by the sha256 of their bytes. An aborted load rejects
 * with the signal's reason.
 */
export function opener() {
	const converted = new Map<string, Converted>();
	const remember = (sha256: string, model: Converted) => {
		converted.delete(sha256);
		converted.set(sha256, model);
		for (const oldest of converted.keys()) {
			if (converted.size <= KEEP_CONVERTED) break;
			converted.delete(oldest);
		}
	};

	return async function open(host: Host, source: FileSource, name: string | null, onStage: (stage: Stage) => void, signal: AbortSignal): Promise<Opened> {
		const report = (stage: Stage) => {
			if (!signal.aborted) onStage(stage);
		};
		const title = name ?? 'the file';
		// What this device kept of a file pinned to its bytes: its entry, and the model this build's conversion made of
		// it, which shows the file again without downloading or converting it.
		const key = sourceKey(source);
		const pin = source.sha256;
		const store = pin ? host.recent : undefined;
		const [found, kept] = await Promise.all([
			within(QUICK_LOOKUP, store?.entry(key), null),
			within(SLOW_LOOKUP, pin && ABOUT.conversion ? store?.model?.(key, pin, ABOUT.conversion) : null, null)
		]);
		signal.throwIfAborted();
		// A kept model comes with its entry, so the file's name, size and origin never go missing with it.
		const seen = kept?.entry ?? found;
		if (kept && pin) {
			const file = { name: name ?? kept.entry.name, sha256: pin, size: kept.entry.size, download: kept.model.download };
			return { model: kept.model, file, kept: true, seen };
		}

		// Measured before the converter starts loading, whose compiling would slow the measurement down.
		const note = jitOff() ? NO_JIT : undefined;
		host.converter.prepare();
		// A file from this device: its kept bytes are registered again, so loadSource finds them.
		if (source.kind === 'blob' && !localFile(source.sha256) && host.recent?.file) {
			const bytes = await within(SLOW_LOOKUP, host.recent.file(source.sha256), null);
			signal.throwIfAborted();
			if (bytes) addLocalFile(name ?? seen?.name ?? 'model.step', bytes);
		}
		if (source.kind !== 'blob' || !localFile(source.sha256)) report({ label: `Downloading ${title}`, fraction: null });
		const { bytes, ...file } = await loadSource(source, name, host, (fraction) => report({ label: `Downloading ${title}`, fraction }), signal);
		signal.throwIfAborted();
		let model = converted.get(file.sha256);
		if (!model) {
			const converting = (stage: Stage) => report(note ? { ...stage, note } : stage);
			converting({ label: 'Starting the converter', fraction: null });
			model = await host.converter.convert(bytes, file.name, (progress) => converting(describe(progress)), signal);
		}
		// Kept even when the load was overtaken meanwhile: the conversion is done, and opening the file again is instant.
		remember(file.sha256, model);
		signal.throwIfAborted();
		return { model, file, kept: false, seen };
	};
}
