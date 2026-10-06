// Build-time data the napplet Vite config generates (see vite.napplet.config.ts).
declare module 'virtual:stepstr' {
	/**
	 * Where the converter comes from: converter.wasm, gzipped and base64-encoded, fetched through the shell (by its hash
	 * from Blossom, or from the dev server) and checked against this sha256 of the text.
	 */
	export const converter: { sha256: string; source: string };
	/** Blossom servers to try for files no link names servers for. */
	export const servers: string[];
	/** The web viewer's origin, for share links. */
	export const webOrigin: string | null;
}
