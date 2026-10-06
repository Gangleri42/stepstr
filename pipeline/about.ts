// The module virtual:stepstr-about: where stepstr's source lives, the sha256 of the converter the build carries,
// and the conversion id, a hash of the converter with the code and packages that turn its output into a model. A
// model kept on a device is made again when that id changes, so the meshing rule and every pipeline file count.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

export type About = { source: string | null; converter: string | null; conversion: string | null };

const root = fileURLToPath(new URL('..', import.meta.url));
/** The code between the converter and the model, and the packages it calls. */
const CONVERSION_CODE = [
	'converter/loader.js',
	'src/lib/convert/mesh-rule.ts',
	'src/lib/convert/run.ts',
	'src/lib/measure/format.ts',
	'src/lib/pipeline',
	'src/lib/source/sha256.ts'
];
const CONVERSION_PACKAGES = ['@gltf-transform/core', '@noble/hashes', 'meshoptimizer', 'three', 'three-mesh-bvh'];

/** A file, or the TypeScript files under a directory, tests left out: repository paths, in a fixed order. */
function files(path: string): string[] {
	if (!statSync(join(root, path)).isDirectory()) return [path];
	return readdirSync(join(root, path))
		.sort()
		.filter((name) => statSync(join(root, path, name)).isDirectory() || (name.endsWith('.ts') && !name.endsWith('.test.ts')))
		.flatMap((name) => files(posix.join(path, name)));
}

/** The files the conversion hash reads, besides the converter. */
const conversionFiles = () => CONVERSION_CODE.flatMap(files).map((path) => join(root, path));

function conversion(converter: string) {
	const hash = createHash('sha256').update(`converter ${converter}\n`);
	for (const path of CONVERSION_CODE.flatMap(files)) {
		// Line endings as committed, whatever the checkout made of them.
		hash.update(`${path}\n${readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n')}\n`);
	}
	for (const name of CONVERSION_PACKAGES) {
		const { version } = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')) as { version: string };
		hash.update(`${name}@${version}\n`);
	}
	return hash.digest('hex');
}

export function about(wasmPath: string): About {
	const site = JSON.parse(readFileSync(join(root, '.nsite/config.json'), 'utf8')) as { source?: string };
	const converter = existsSync(wasmPath) ? createHash('sha256').update(readFileSync(wasmPath)).digest('hex') : null;
	return { source: site.source ?? null, converter, conversion: converter && conversion(converter) };
}

/** Serves about() as virtual:stepstr-about; the dev server remakes it when the converter or a hashed file changes. */
export function aboutModule(wasmPath: string): Plugin {
	const id = 'virtual:stepstr-about';
	const resolved = `\0${id}`;
	const sources = new Set([wasmPath, ...conversionFiles()]);
	return {
		name: 'stepstr-about',
		resolveId: (source) => (source === id ? resolved : undefined),
		load: (loading) => (loading === resolved ? `export default ${JSON.stringify(about(wasmPath))};` : undefined),
		hotUpdate({ file }) {
			if (!sources.has(file)) return;
			const module = this.environment.moduleGraph.getModuleById(resolved);
			if (module) this.environment.moduleGraph.invalidateModule(module);
			// The page reads the conversion once, as it starts.
			if (this.environment.name === 'client') this.environment.hot.send({ type: 'full-reload' });
		}
	};
}
