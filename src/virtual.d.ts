// The module both Vite configs generate (pipeline/about.ts); read through $lib/about.
declare module 'virtual:stepstr-about' {
	const about: { source: string | null; converter: string | null; conversion: string | null };
	export default about;
}

// The site's .nsite/config.json, which the web build generates (pipeline/site.ts).
declare module 'virtual:stepstr-site' {
	const site: { servers: string[] };
	export default site;
}
