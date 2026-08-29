/**
 * Per-source gates, owned by the chokepoint (SPEC §16.4).
 *
 * Nominatim's policy is at most 1 request per second with an identifying
 * User-Agent; GLEIF's is 60 per minute. The other three are unbounded beyond
 * the worker's concurrency of 4.
 *
 * **Honest cost, stated rather than discovered:** the limiter is *per process*.
 * The web process and the worker hold separate buckets and can jointly exceed
 * Nominatim's 1/s. A shared bucket would need a lock in Postgres on every
 * geocode, which is a heavier mechanism than the problem — Plants and
 * unresolved rows are the only things geocoded, and they are geocoded once.
 */

type Gate = {
  /** Minimum spacing between two starts, in milliseconds. */
  minIntervalMs: number;
  /** Serialised tail: each caller waits for the previous one plus the spacing. */
  next: Promise<void>;
  lastStart: number;
};

const GATES: Record<string, Gate> = {
  // ≤ 1 req/s, and the SPEC pins concurrency 1 as well — which serialising the
  // tail gives us for free.
  nominatim: { minIntervalMs: 1_000, next: Promise.resolve(), lastStart: 0 },
  // 60/min = one per second on average.
  gleif: { minIntervalMs: 1_000, next: Promise.resolve(), lastStart: 0 },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` behind the source's gate, or immediately when it has none.
 *
 * `now` is injectable so the unit test does not have to spend a real second
 * proving that the gate spaces two calls.
 */
export async function withRateLimit<T>(
  source: string,
  fn: () => Promise<T>,
  now: () => number = Date.now,
): Promise<T> {
  const gate = GATES[source];
  if (!gate) return fn();

  const run = gate.next.then(async () => {
    const wait = gate.lastStart + gate.minIntervalMs - now();
    if (wait > 0) await sleep(wait);
    gate.lastStart = now();
  });
  // Keep the chain alive even if a call rejects, or one failure would wedge the
  // gate shut for the life of the process.
  gate.next = run.catch(() => undefined);

  await run;
  return fn();
}

/** Test seam: forget the spacing so one test cannot slow the next. */
export function resetRateLimitsForTesting(): void {
  for (const gate of Object.values(GATES)) {
    gate.next = Promise.resolve();
    gate.lastStart = 0;
  }
}
