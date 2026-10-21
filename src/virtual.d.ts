// The module both Vite configs generate (pipeline/about.ts); read through $lib/about.
declare module 'virtual:stepstr-about' {
	const about: { source: string | null; converter: string | null; conversion: string | null };
	export default about;
}

// The site's name, description, servers, napplet role and catalogue, which both Vite configs generate (pipeline/site.ts).
declare module 'virtual:stepstr-site' {
	export const title: string;
	export const description: string;
	export const servers: string[];
	export const role: import('./lib/state/archetype').NappletRole;
	/** The site's catalogue, which the napplet carries; null for a site without one. */
	export const catalogue: import('./lib/catalogue/catalogue').Catalogue | null;
	/** Whether the site has a catalogue, which the web page fetches as catalogue.json. */
	export const hasCatalogue: boolean;
}
