// What a web address was last deployed from. The Pages mirror leaves the site manifest's event id beside the files, so
// a scheduled run can tell with one request whether a newer manifest is waiting, whichever of its files changed.
export const MANIFEST_STAMP = 'manifest-event.txt';

export async function servesManifest(url: string, eventId: string): Promise<boolean> {
	const response = await fetch(`${url}/${MANIFEST_STAMP}`, { signal: AbortSignal.timeout(30_000), cache: 'no-store' }).catch(() => null);
	return !!response?.ok && (await response.text()).trim() === eventId;
}
