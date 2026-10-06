// Whether the browser runs stepstr without a JIT, as GrapheneOS's Vanadium does by default. Its WebAssembly then runs in
// an interpreter and a conversion takes several times longer, which the app says while it converts. No API tells, so a
// loop does. Each of its steps depends on the one before, so compiled code needs a few cycles per step on any processor:
// 4 million steps take 5 to 7 ms on a fast laptop in Chromium, Firefox and WebKit alike, and about 30 ms on a slow phone
// core. Interpreted they take over 100 ms even on the laptop, so the loop stops at 60 ms and calls that slow.

const STEPS = 4_000_000;
/** Steps between two looks at the clock: under a few milliseconds even interpreted on a slow phone. */
const BETWEEN = 10_000;
const SLOW_MS = 60;
/**
 * Some browsers coarsen the clock for privacy, to 16 or 100 ms, and then the loop cannot tell a JIT from none. A clock
 * that moves in steps of this or less is fine enough.
 */
const FINE_MS = 5;

/** Times the loop on `now`: true when it ran interpreted, false when compiled, null when the clock is too coarse to tell. */
export function measureJit(now: () => number = () => performance.now()): boolean | null {
	const start = now();
	let last = start;
	let tick = Infinity;
	let x = 1;
	for (let done = 0; done < STEPS; done += BETWEEN) {
		for (let i = 0; i < BETWEEN; i++) {
			x ^= x << 13;
			x ^= x >> 17;
			x ^= x << 5;
		}
		const t = now();
		if (t > last) {
			tick = Math.min(tick, t - last);
			last = t;
		}
		if (t - start > SLOW_MS) return tick <= FINE_MS ? true : null;
	}
	// From 1 this xorshift never reaches 0. Reading x keeps any compiler from dropping the loop as unused.
	return x === 0 ? null : false;
}

let verdict: boolean | null | undefined;

/** Whether this browser runs without a JIT, measured once per page: null when it cannot tell. */
export function jitOff(): boolean | null {
	if (verdict === undefined) verdict = measureJit();
	return verdict;
}
