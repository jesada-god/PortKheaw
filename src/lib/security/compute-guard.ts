/**
 * Bounds for the endpoints where the cost is in producing the answer, not in
 * serving it.
 *
 * A rate limit answers "how often". It does not answer "how much", and for a
 * Monte Carlo endpoint that gap is the whole attack: 50,000 paths × 366 steps ×
 * 20 legs is roughly four hundred times the work of a default run, and a caller
 * who is comfortably inside every request-per-minute bound can still ask for it
 * on every one of those requests. Entitlement does not close the gap either —
 * being allowed to run a simulation is not the same as being allowed to run the
 * largest one repeatedly.
 *
 * So three separate bounds, each answering a question the others cannot:
 *
 *   * {@link monteCarloWorkUnits} bounds **one request's size**, before any of
 *     it runs.
 *   * {@link ConcurrencyGate} bounds **how many run at once** in this instance,
 *     so a parallel burst sheds instead of queueing behind a blocked event loop.
 *   * {@link ComputeCache} collapses **identical repeated work**, which is what
 *     a retry storm and a stuck client actually generate.
 *
 * Honest about what is not here: there is no timeout around the simulation
 * itself. The compute is synchronous JavaScript, and a timer cannot interrupt
 * synchronous JavaScript — a `Promise.race` against it would resolve the
 * response while the CPU kept burning, which is worse than useless because it
 * hides the load it claims to bound. The size cap is what makes the run short;
 * that is the honest control, and it is enforced before the first path is drawn.
 * {@link withTimeout} exists for the genuinely asynchronous work — provider
 * fan-outs — where a timer does bound something real.
 */

/* ------------------------------- work budget ------------------------------- */

/**
 * The cost of one Monte Carlo request, in units of "one simulated step for one
 * leg". Paths and steps multiply into the path matrix; legs multiply again
 * because every leg is repriced at every retained step.
 */
export function monteCarloWorkUnits(input: {
  paths: number;
  steps: number;
  /** Both portfolios' legs; the endpoint prices the comparison too. */
  legs: number;
}): number {
  return input.paths * input.steps * Math.max(1, input.legs);
}

/**
 * The ceiling, chosen from the shape of real use rather than from a round
 * number: the heaviest run the product's own UI can construct is 50,000 paths
 * over 252 trading days against a four-leg spread and its four-leg comparison —
 * about 100 million units — and this sits above that while refusing the
 * combinations only a script asks for. A request over the line is refused with a
 * 422 naming the three fields that produced it, so a legitimate caller can see
 * what to reduce.
 */
export const MONTE_CARLO_WORK_LIMIT = 250_000_000;

/*
 * There is deliberately no What-If equivalent.
 *
 * That endpoint prices one scenario against at most twenty legs — the schema
 * caps the array — so the largest request it can express is twenty repricings,
 * which is not a cost worth a second gate. A limit that cannot fire is worse
 * than no limit: it reads as protection in a review and provides none. What-If
 * is bounded by its schema, its rate limit, its body cap, the dedupe cache and
 * the concurrency gate.
 */

/* ------------------------------- concurrency ------------------------------- */

/**
 * A counting gate over in-flight expensive work in **this** instance.
 *
 * It sheds rather than queues, and that is the design. A queue in front of
 * synchronous CPU work does not reduce load — it converts a refusal an attacker
 * would have seen immediately into latency every honest caller shares, and then
 * the platform's own request timeout turns the whole backlog into failures at
 * once. Refusing the surplus with a `Retry-After` keeps the instance responsive
 * and tells the caller something true.
 */
export class ConcurrencyGate {
  private active = 0;

  constructor(private readonly limit: number) {}

  /** Reserve a slot, or report that there is none. Always paired with `release`. */
  tryAcquire(): boolean {
    if (this.active >= this.limit) return false;
    this.active += 1;
    return true;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
  }

  get inFlight(): number {
    return this.active;
  }

  /**
   * Run `work` inside a slot, releasing it however the work ends. Returns
   * `'rejected'` rather than throwing when the gate is full, so the caller
   * answers with a 429 instead of a 500.
   */
  async run<T>(work: () => Promise<T> | T): Promise<{ ok: true; value: T } | { ok: false }> {
    if (!this.tryAcquire()) return { ok: false };
    try {
      return { ok: true, value: await work() };
    } finally {
      this.release();
    }
  }
}

/**
 * Two simultaneous simulations per instance.
 *
 * The number is small because the work is synchronous: a second run does not
 * proceed in parallel with the first, it waits for the event loop, and every
 * additional one only adds latency to a queue that is already saturated. Two
 * absorbs the ordinary case of a reader with the tab open twice; the third
 * concurrent request is a client that is not behaving like a browser.
 */
export const SIMULATION_CONCURRENCY = 2;

/* --------------------------------- dedupe ---------------------------------- */

/**
 * A tiny, bounded, per-instance result cache keyed by the exact request body.
 *
 * Safe to share only because the answer depends on nothing but the input: these
 * simulations are pure functions of the numbers posted to them, with an explicit
 * seed, so two callers with byte-identical input are entitled to byte-identical
 * output and neither can learn anything about the other from it. The moment a
 * computation depends on *who* is asking, it must not be cached here — which is
 * why the key is the body and the entitlement gate runs before the lookup, never
 * after.
 *
 * It exists for retry storms and double-submitting clients, so the TTL is short
 * and the capacity is small: this is a way to not do the same work twice in the
 * same few seconds, not a cache anybody should rely on for a hit.
 */
export class ComputeCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly maxEntries = 64,
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    // Refresh recency so a hot key survives eviction.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.value;
  }

  set(key: string, value: T): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * A stable key for a request body.
 *
 * The raw text is hashed rather than stored: a cache key that is the request
 * body is a copy of every position and price a reader posted, sitting in process
 * memory for the length of the TTL. FNV-1a is not a security hash and is not
 * being used as one — a collision here costs a wrong cache hit between two
 * *identical-length* bodies, so the length is mixed into the key as well.
 */
export function computeCacheKey(raw: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${raw.length.toString(36)}:${hash.toString(36)}`;
}

/* --------------------------------- timeout --------------------------------- */

/**
 * Bound genuinely asynchronous work — a provider fan-out, a database read — so a
 * hung upstream cannot hold a function slot until the platform kills it.
 *
 * Deliberately not used around synchronous compute. See the note at the top of
 * this file: racing a timer against blocking JavaScript resolves the promise
 * while the CPU keeps going, which would report a bound that does not exist.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false; reason: 'timeout' }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false; reason: 'timeout' }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), timeoutMs);
  });
  try {
    return await Promise.race([work.then((value) => ({ ok: true as const, value })), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
