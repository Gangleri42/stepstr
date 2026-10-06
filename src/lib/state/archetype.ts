// The napplet's role, for manifests and intents (NAP-INTENT, napplet/naps ARCHETYPES.md): it displays one 3D model or
// assembly for inspection. No registered archetype covers that yet; `3d-model` is the slug stepstr proposes.
export const ARCHETYPE = '3d-model';
export const CONVENTION = `napplet:${ARCHETYPE}/open`;
/** Topics the viewer listens on: the convention itself, and the `<archetype>:<action>` channel stlstr uses. */
export const OPEN_TOPICS = [CONVENTION, `${ARCHETYPE}:open`];
export const READY_TOPIC = `${ARCHETYPE}:ready`;
/** The intent's parameters, as `routeFromPayload` (route.ts) reads them; the manifest advertises them. */
export const INTENT_PARAMS = ['url', 'sha256', 'servers', 'name', 'view', 'route'];

/** The shell domains the napplet cannot work without: an intent to say which file, and a way to fetch it. */
export const REQUIRES = ['inc', 'resource'];
/** The domains it uses when the shell offers them; each is feature-detected (host/napplet-runtime.ts). */
export const OPTIONAL = ['theme', 'link', 'outbox', 'fs', 'storage'];
