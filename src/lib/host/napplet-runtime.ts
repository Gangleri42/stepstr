// What a NIP-5D shell injects as window.napplet. The runtime's prelude installs one object per capability domain the
// manifest declares and the shell grants; a domain the shell lacks is absent, so everything is feature-detected.
// The viewer never posts envelopes itself and never sends the readiness signal: the prelude does both.
import type { NostrEventLike } from '$lib/source/nostr-files';

export type Handle = { close(): void } | (() => void) | void;

export type IncEvent = { topic: string; sender?: string; payload?: unknown };

export type ShellTheme = { colors?: { background?: string; text?: string; primary?: string } };

export type NostrFilter = { ids?: string[]; authors?: string[]; kinds?: number[]; limit?: number } & Record<`#${string}`, string[]>;
type RelayEventResult = { event: NostrEventLike & { id: string; sig: string; created_at: number } };

export interface NappletApi {
	inc?: {
		on(topic: string, handler: (event: IncEvent | unknown) => void): Handle;
		emit(topic: string, payload?: Record<string, string>): unknown;
	};
	resource?: {
		bytes(url: string, options?: { servers?: string[]; signal?: AbortSignal }): Promise<Blob>;
		info?(): Promise<{ schemes: { scheme: string; enabled: boolean }[]; maxBytes?: number }>;
	};
	outbox?: {
		getEvent(id: string, options?: { author?: string; relays?: string[]; timeoutMs?: number }): Promise<{ result?: RelayEventResult; error?: string }>;
		query(filters: NostrFilter | NostrFilter[], options?: { authors?: string[]; relays?: string[]; limit?: number; timeoutMs?: number }): Promise<{ events: RelayEventResult[]; error?: string }>;
	};
	fs?: {
		info?(): Promise<{ limits?: { maxReadBytes?: number } }>;
		pickFile(options?: { accept?: { mime?: string; extension?: string }[]; description?: string }): Promise<{ entries: { path: string; name: string; kind: string; size?: number }[] }>;
		read(path: string, options?: { offset?: number; length?: number }): Promise<{ data: string; bytesRead: number; eof: boolean; size?: number }>;
	};
	theme?: { get(): Promise<ShellTheme>; onChanged(handler: (theme: ShellTheme) => void): Handle };
	/** NAP-STORAGE: string values per key, within a quota the shell sets (512 KB in Kehto's shells). */
	storage?: { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void>; removeItem(key: string): Promise<void> };
	link?: { open(url: string, options?: { label?: string }): Promise<{ status?: string; error?: string } | undefined> };
}

export const napplet = (): NappletApi | null => (globalThis as { napplet?: NappletApi }).napplet ?? null;

/** The domain object when the shell injected it with these methods, else null. */
export function has<K extends keyof NappletApi>(domain: K, ...methods: string[]): NonNullable<NappletApi[K]> | null {
	const api = napplet()?.[domain] as Record<string, unknown> | undefined;
	if (!api || typeof api !== 'object') return null;
	return methods.every((m) => typeof api[m] === 'function') ? (api as NonNullable<NappletApi[K]>) : null;
}

export function close(handle: Handle) {
	if (typeof handle === 'function') handle();
	else handle?.close?.();
}
