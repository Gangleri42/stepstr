// The module both Vite configs generate (pipeline/about.ts); read through $lib/about.
declare module 'virtual:stepstr-about' {
	const about: { source: string | null; converter: string | null; conversion: string | null };
	export default about;
}
