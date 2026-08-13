/**
 * The abuse model: what a request costs, and how much of it anyone may have.
 *
 * This module is deliberately pure and dependency-free — no `server-only`, no
 * `node:crypto`, no Next import — because the same policy has to be readable
 * from three runtimes that share nothing else: the Edge middleware, a Node route
 * handler, and a Vitest process. A policy that could only be read where it is
 * enforced would drift from the place it is documented.
 *
 * Two layers, and they answer different questions.
 *
 *   * **The burst layer** ({@link BurstLimiter}) lives in one instance's memory
 *     and asks "is this caller hammering *me*, right now". It costs nothing —
 *     no I/O — which is the whole point: it runs *before* the session lookup and
 *     before any provider call, so a flood is refused without ever becoming
 *     database load. It cannot be authoritative, because instances share no
 *     memory.
 *   * **The sustained layer** (`consumeRateLimit`, in `./rate-limit`) lives in
 *     the database and is authoritative across every instance. It costs a round
 *     trip, so it runs second, only for traffic the burst layer already let by.
 *
 * Neither replaces the other. A limiter that is only in-process bounds one
 * lambda; a limiter that is only in the database turns a flood into a bill.
 */

/**
 * The six risk classes. Every guarded surface names one, so a limit is never a
 * number chosen at a call site — it is a class the call site belongs to.
 */
export const ABUSE_CLASSES = [
  /** A — sign-in, sign-up, password reset. Unauthenticated and credential-bearing. */
  'auth',
  /** B — the operator console's reads. Authenticated, admin-only, cheap per call. */
  'admin-read',
  /** C — the operator console's writes. Authenticated, admin-only, consequential. */
  'admin-mutation',
  /** D — simulations and provider-heavy analytics. Authenticated, expensive per call. */
  'expensive',
  /** E — ordinary product API traffic. */
  'api',
  /** F — realtime/WebSocket. Enforced in the Gateway process, not here. */
  'realtime',
] as const;
export type AbuseClass = typeof ABUSE_CLASSES[number];

export interface BurstPolicy {
  /** Requests allowed inside {@link windowMs} from one identity, per instance. */
  limit: number;
  windowMs: number;
}

/**
 * The burst bounds.
 *
 * These are *not* the product's rate limits — the database holds those. They are
 * the point at which one instance stops paying to find out who is calling. Each
 * is set an order of magnitude above what a person on a fast connection
 * generates and well below what a script does, so the only traffic they ever
 * refuse is traffic no browser produced.
 *
 * `realtime` is present for completeness and is not enforced here: a WebSocket
 * is not a request, and its limits live in the Gateway where the connection does.
 */
export const BURST_POLICIES: Readonly<Record<AbuseClass, BurstPolicy>> = {
  auth: { limit: 20, windowMs: 10_000 },
  'admin-read': { limit: 60, windowMs: 10_000 },
  'admin-mutation': { limit: 20, windowMs: 10_000 },
  expensive: { limit: 20, windowMs: 10_000 },
  api: { limit: 200, windowMs: 10_000 },
  realtime: { limit: 0, windowMs: 0 },
};

/**
 * Which class a path belongs to, decided by URL alone.
 *
 * The Edge middleware calls this before it knows who is asking — that ordering
 * is the reason the function may not consult a session. Anything unrecognised is
 * `null`, meaning "not a guarded surface", never a default class: silently
 * bounding every page render at an API rate is how a limiter starts refusing
 * readers.
 */
export function abuseClassForPath(pathname: string, method = 'GET'): AbuseClass | null {
  if (pathname.startsWith('/api/admin/')) {
    return isReadMethod(method) ? 'admin-read' : 'admin-mutation';
  }
  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    // A console *page* is a read; a server action posts to its own page URL, so a
    // POST to an `/admin` path is a mutation and is bounded as one.
    return isReadMethod(method) ? 'admin-read' : 'admin-mutation';
  }
  if (pathname.startsWith('/auth/')) {
    // Only the credential-bearing entry forms. `/auth/callback` is the provider
    // completing an OAuth round trip and must not be bounded with the forms.
    return isAuthFormPath(pathname) ? 'auth' : null;
  }
  if (isExpensiveApiPath(pathname)) return 'expensive';
  if (pathname.startsWith('/api/')) return 'api';
  return null;
}

function isReadMethod(method: string): boolean {
  const verb = method.toUpperCase();
  return verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS';
}

/**
 * The credential-bearing auth surfaces. `/auth/callback`, `/auth/sign-out` and
 * the informational pages are deliberately absent — bounding a callback breaks
 * the sign-in it is completing.
 */
function isAuthFormPath(pathname: string): boolean {
  return pathname === '/auth/sign-in'
    || pathname === '/auth/sign-up'
    || pathname === '/auth/forgot-password'
    || pathname === '/auth/reset-password';
}

/**
 * Routes whose cost is not in serving the response but in producing it: a Monte
 * Carlo run, an options-chain assembly, a provider fan-out, a translation. These
 * are the ones worth spending a class on, because each one an attacker gets is
 * CPU seconds or a provider quota unit they did not pay for.
 */
export const EXPENSIVE_API_PREFIXES: readonly string[] = [
  '/api/option-simulations/compute/',
  '/api/analytics/',
  '/api/market/options/',
  '/api/translate/',
  '/api/news',
];

export function isExpensiveApiPath(pathname: string): boolean {
  return EXPENSIVE_API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

/**
 * The identity a limit is counted against.
 *
 * Layered on purpose. An address alone is the wrong key — a university NAT and a
 * mobile carrier put thousands of unrelated readers behind one of them, and an
 * attacker with a residential proxy pool has as many as they like. An account id
 * alone is also wrong: the auth surfaces have no account yet, which is exactly
 * where the brute force happens.
 *
 * So both are counted, independently, and the *tighter* answer wins. A signed-in
 * caller is bounded as themselves AND as their address; an anonymous one is
 * bounded by address and, on the auth forms, by the identifier they are trying.
 */
export interface AbuseIdentity {
  userId?: string | null;
  clientAddress?: string | null;
  /**
   * A non-account subject the action is *about* — the email a sign-in is being
   * attempted against. It is what makes credential stuffing from many addresses
   * against one account visible, which an address-keyed limiter cannot see.
   */
  subject?: string | null;
}

/**
 * Expand an identity into the keys a limiter should count, most specific first.
 * Empty only when nothing at all is known, in which case the caller falls back to
 * the shared anonymous bucket — pooled deliberately, so an unattributable flood
 * is bounded in aggregate rather than being unbounded.
 */
export function identityKeys(identity: AbuseIdentity): string[] {
  const keys: string[] = [];
  if (identity.userId) keys.push(`user:${identity.userId}`);
  if (identity.subject) keys.push(`subject:${identity.subject.toLowerCase()}`);
  if (identity.clientAddress) keys.push(`addr:${identity.clientAddress}`);
  return keys.length > 0 ? keys : ['anonymous'];
}

/**
 * The client address, as seen through the platform's proxy.
 *
 * `x-forwarded-for` is a list each hop appends to. A client can send its own
 * value, so every entry but one is forgeable — the *first* is the address the
 * platform itself observed, and is the only one worth reading.
 */
export function clientAddressFromHeaders(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return headers.get('x-real-ip')?.trim() || null;
}

export interface BurstDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

const ALLOWED: BurstDecision = { allowed: true, retryAfterSeconds: 0 };

/**
 * An in-memory sliding-window limiter, bounded in both time and space.
 *
 * The space bound matters as much as the time bound: a limiter keyed by client
 * address, in a long-lived process, with no eviction, is a memory leak that an
 * attacker controls the size of. Windows are pruned on touch and the whole map
 * is swept once it grows past {@link maxKeys}, so the worst case is a fixed
 * ceiling rather than one address per packet.
 */
export class BurstLimiter {
  private readonly windows = new Map<string, number[]>();

  constructor(
    private readonly maxKeys = 20_000,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Charge one request for `key` against `policy`. Returns the refusal *and* how
   * long it stays refused, so the caller can always answer with `Retry-After` —
   * a 429 that does not say when to come back is an invitation to poll.
   */
  consume(key: string, policy: BurstPolicy): BurstDecision {
    if (policy.limit <= 0 || policy.windowMs <= 0) return ALLOWED;
    const t = this.now();
    const cutoff = t - policy.windowMs;

    const hits = this.windows.get(key);
    if (!hits) {
      if (this.windows.size >= this.maxKeys) this.sweep(cutoff);
      this.windows.set(key, [t]);
      return ALLOWED;
    }

    let live = 0;
    for (const hit of hits) if (hit > cutoff) hits[live++] = hit;
    hits.length = live;

    if (live >= policy.limit) {
      // The oldest hit in the window is what has to age out before the next one
      // is allowed, so that — not the whole window — is the honest wait.
      const retryMs = hits[0] + policy.windowMs - t;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1_000)) };
    }
    hits.push(t);
    return ALLOWED;
  }

  /**
   * Charge every key an identity expands to and return the tightest refusal.
   *
   * Every key is charged even after one refuses, on purpose: skipping the rest
   * would let a caller who is already over their account budget spend nothing
   * against their address budget, and rotating the cheap key is how a limiter
   * with an early return gets walked around.
   */
  consumeIdentity(scope: string, identity: AbuseIdentity, policy: BurstPolicy): BurstDecision {
    let worst: BurstDecision = ALLOWED;
    for (const key of identityKeys(identity)) {
      const decision = this.consume(`${scope}|${key}`, policy);
      if (!decision.allowed && decision.retryAfterSeconds > worst.retryAfterSeconds) worst = decision;
    }
    return worst;
  }

  /** Drop every window with nothing live left in it. */
  private sweep(cutoff: number): void {
    for (const [key, hits] of this.windows) {
      const live = hits.filter((hit) => hit > cutoff);
      if (live.length === 0) this.windows.delete(key);
      else this.windows.set(key, live);
    }
    // Still full of live windows — this is a real flood from many sources, and
    // holding unbounded state through it is worse than losing the oldest counts.
    if (this.windows.size >= this.maxKeys) this.windows.clear();
  }

  /** Test seam. */
  reset(): void {
    this.windows.clear();
  }

  get size(): number {
    return this.windows.size;
  }
}

/** The refusal body, in the envelope every route in this product already speaks. */
export function tooManyRequestsBody(retryAfterSeconds: number): {
  data: null;
  error: { code: 'rate-limited'; message: string; retryable: true; retryAfterSeconds: number };
} {
  return {
    data: null,
    error: {
      code: 'rate-limited',
      message: 'คุณส่งคำขอถี่เกินไป กรุณารอสักครู่แล้วลองใหม่อีกครั้ง',
      retryable: true,
      retryAfterSeconds,
    },
  };
}

/**
 * The headers a 429 must carry. `Retry-After` is the contract with well-behaved
 * clients; `no-store` keeps a shared cache from serving one caller's refusal to
 * everybody behind the same edge node.
 */
export function tooManyRequestsHeaders(retryAfterSeconds: number): Record<string, string> {
  return {
    'Retry-After': String(Math.max(1, retryAfterSeconds)),
    'Cache-Control': 'private, no-store',
  };
}
