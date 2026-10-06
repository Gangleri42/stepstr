// Types for parity.mjs, which test/parity.test.ts imports.

export type ParityOptions = { linear?: number; angular?: number; log?: (line: string) => void };

/** failures empty means parity; notes are the differences parity allows; summary is the JSON line it printed. */
export function parity(
	wasmPath: string,
	stepPath: string,
	oracleDir: string,
	options?: ParityOptions
): Promise<{ failures: string[]; notes: string[]; summary: Record<string, unknown> }>;
