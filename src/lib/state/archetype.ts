// The napplet's role, for manifests and intents (NAP-INTENT, napplet/naps ARCHETYPES.md): it displays one 3D model or
// assembly for inspection. No registered archetype covers that yet; `3d-model` is the slug stepstr proposes. A site
// built from stepstr (pipeline/site.ts) can declare another role in the `napplet` section of its config.
const ARCHETYPE = '3d-model';
/** The intent's parameters, as `routeFromPayload` (route.ts) reads them; the manifest advertises them. */
const INTENT_PARAMS = ['url', 'sha256', 'servers', 'name', 'view', 'route'];
/** The shell domains the napplet cannot work without: an intent to say which file, and a way to fetch it. */
const REQUIRES = ['inc', 'resource'];
/** The domains it uses when the shell offers them; each is feature-detected (host/napplet-runtime.ts). */
const OPTIONAL = ['theme', 'link', 'outbox', 'fs', 'storage'];

/** The `napplet` section of a site's .nsite/config.json; what it leaves out is stepstr's own. */
export type NappletConfig = { archetype?: string; topics?: string[]; params?: string[]; requires?: string[]; optional?: string[] };

export type NappletRole = {
	archetype: string;
	/** The NAP-INTENT convention, `napplet:<archetype>/open`. */
	convention: string;
	/** Topics the viewer listens on: the convention itself, and the `<archetype>:open` channel stlstr uses. */
	topics: string[];
	/** What it emits once it listens, for shells that hold an intent until then. */
	ready: string;
	params: string[];
	requires: string[];
	optional: string[];
};

export function nappletRole(napplet: NappletConfig = {}): NappletRole {
	const archetype = napplet.archetype ?? ARCHETYPE;
	const convention = `napplet:${archetype}/open`;
	return {
		archetype,
		convention,
		topics: napplet.topics ?? [convention, `${archetype}:open`],
		ready: `${archetype}:ready`,
		params: napplet.params ?? INTENT_PARAMS,
		requires: napplet.requires ?? REQUIRES,
		optional: napplet.optional ?? OPTIONAL
	};
}
