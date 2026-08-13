import { createHash } from 'node:crypto';

/**
 * Who is on the other end of a WebSocket, when they are willing to say.
 *
 * The Gateway is a separate Node process with no access to the web app's session
 * cookies, so the only way it can know a connection belongs to an account is for
 * the browser to present its access token. This module is the part that decides
 * whether to believe it.
 *
 * It does not decode the token. It asks Supabase.
 *
 * That is a deliberate trade. Verifying the signature locally would be one fewer
 * round trip, but it would mean this process holding a JWT secret or tracking a
 * JWKS rotation, and getting either wrong fails *open* — a verifier with a stale
 * key or a skipped `alg` check accepts forgeries silently. Asking the auth
 * server that issued the token is the version with no cryptography of our own in
 * it, and its failure mode is "we could not confirm you", which costs an
 * attacker nothing they did not already have and costs an honest reader only the
 * anonymous connection limits.
 *
 * Three properties worth stating:
 *
 *   * **Cached, keyed by a digest.** The same token reconnecting does not
 *     re-ask. What is stored is a SHA-256 of the token, never the token — a
 *     cache of live credentials in a long-running process is a credential store
 *     nobody signed up for.
 *   * **Deduplicated in flight.** Twenty tabs reconnecting after a deploy make
 *     one verification, not twenty.
 *   * **Bounded and short-lived.** The TTL is minutes, so a revoked session
 *     stops counting as a session quickly, and the map has a hard ceiling so a
 *     stream of junk tokens cannot grow it.
 */

export interface VerifiedIdentity {
  userId: string;
}

export interface IdentityVerifierOptions {
  supabaseUrl: string;
  /** The publishable (anon) key — the same one the browser holds. Not a secret. */
  publishableKey: string;
  /** How long a positive verdict is reused. */
  ttlMs?: number;
  /** How long a negative verdict is reused, so junk tokens are not re-asked. */
  negativeTtlMs?: number;
  maxEntries?: number;
  now?: () => number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Abort a verification that the auth server is not answering. */
  timeoutMs?: number;
}

interface CacheEntry {
  identity: VerifiedIdentity | null;
  expiresAt: number;
}

export class IdentityVerifier {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<VerifiedIdentity | null>>();
  private readonly ttlMs: number;
  private readonly negativeTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: IdentityVerifierOptions) {
    this.ttlMs = options.ttlMs ?? 300_000;
    this.negativeTtlMs = options.negativeTtlMs ?? 60_000;
    this.maxEntries = options.maxEntries ?? 5_000;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 4_000;
  }

  /**
   * Resolve a token to an account, or to `null`.
   *
   * `null` covers every unhappy path — expired, forged, revoked, malformed, auth
   * server unreachable — and they are deliberately indistinguishable to the
   * caller. The Gateway's only response to `null` is "treat this connection as
   * anonymous", so distinguishing them would add a way to probe token validity
   * through a market-data socket and change nothing else.
   */
  async verify(token: string): Promise<VerifiedIdentity | null> {
    const key = digest(token);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.identity;

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const request = this.ask(token)
      .then((identity) => {
        this.remember(key, identity);
        return identity;
      })
      .catch(() => {
        // An unreachable auth server is not evidence of a valid session, and it
        // is not evidence of an invalid one either — so it is remembered only
        // briefly, and never as a positive.
        this.remember(key, null);
        return null;
      })
      .finally(() => this.inFlight.delete(key));

    this.inFlight.set(key, request);
    return request;
  }

  private async ask(token: string): Promise<VerifiedIdentity | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.options.supabaseUrl.replace(/\/$/, '')}/auth/v1/user`, {
        headers: {
          apikey: this.options.publishableKey,
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const body = await response.json() as { id?: unknown };
      return typeof body?.id === 'string' && body.id.length > 0 ? { userId: body.id } : null;
    } finally {
      clearTimeout(timer);
    }
  }

  private remember(key: string, identity: VerifiedIdentity | null): void {
    if (this.cache.size >= this.maxEntries) {
      // Drop the oldest insertion rather than sweeping: this runs on a hot path
      // and a full sweep under a junk-token flood is the wrong place to spend.
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, {
      identity,
      expiresAt: this.now() + (identity ? this.ttlMs : this.negativeTtlMs),
    });
  }

  /** Test seam. */
  clear(): void {
    this.cache.clear();
    this.inFlight.clear();
  }
}

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Concurrent connections one *account* may hold, across every address.
 *
 * Lower than the per-address cap, and for a different reason: an address is
 * shared by a whole household or a whole campus, while an account is one person
 * with a phone, a laptop and a few tabs. A number this size never inconveniences
 * that person and does bound the case the address cap cannot see — one account
 * opening sockets from a hundred residential proxies.
 */
export const MAX_CONNECTIONS_PER_USER = 8;
