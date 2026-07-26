import type { MarketDataError } from '../errors';

/**
 * Per-provider options capability memory.
 *
 * Nexora's Options 429 storm had a single cause: a permanent entitlement refusal
 * was classified as a retryable rate limit, so every page load re-attempted an
 * endpoint the current plan can never serve. This cache is the structural guard
 * against a repeat. An entitlement verdict is remembered for a long window and
 * the provider is skipped outright while it holds — including for user-initiated
 * retries, which must never be able to re-arm an upstream call that is known to
 * be refused.
 */

export type OptionsCapabilityStatus = 'unknown' | 'entitled' | 'entitlement-unavailable' | 'cooling-down';

/** Negative entitlement verdicts are cached at the top of the 15–60 minute band. */
export const ENTITLEMENT_TTL_MS = 30 * 60_000;
/** Positive capability results are re-verified more often so an upgrade is picked up. */
export const ENTITLED_TTL_MS = 15 * 60_000;

/** Error codes that mean "this plan cannot serve options", not "try again later". */
const ENTITLEMENT_CODES = new Set(['forbidden', 'provider-unauthorized', 'provider-not-configured', 'unsupported']);

export function isEntitlementFailure(error: Pick<MarketDataError, 'code'>): boolean {
  return ENTITLEMENT_CODES.has(error.code);
}

interface CapabilityEntry {
  status: OptionsCapabilityStatus;
  /** Epoch ms at which this verdict expires and the provider may be probed again. */
  until: number;
  reason: string | null;
}

export interface OptionsCapabilityReport {
  provider: string;
  status: OptionsCapabilityStatus;
  reason: string | null;
  retryAfterSeconds: number | null;
}

export class OptionsCapabilityCache {
  private readonly entries = new Map<string, CapabilityEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  private live(provider: string): CapabilityEntry | null {
    const entry = this.entries.get(provider);
    if (!entry) return null;
    if (this.now() >= entry.until) {
      this.entries.delete(provider);
      return null;
    }
    return entry;
  }

  /** Record that a provider returned a schema-valid options payload. */
  markEntitled(provider: string): void {
    this.entries.set(provider, { status: 'entitled', until: this.now() + ENTITLED_TTL_MS, reason: null });
  }

  /**
   * Record a permanent plan/entitlement refusal. Retrying cannot succeed until an
   * operator changes the external subscription, so the window is deliberately long.
   */
  markEntitlementUnavailable(provider: string, reason: string): void {
    this.entries.set(provider, { status: 'entitlement-unavailable', until: this.now() + ENTITLEMENT_TTL_MS, reason });
  }

  /** Record a temporary throttle, honouring the provider's Retry-After when present. */
  markCoolingDown(provider: string, retryAfterSeconds: number, reason: string): void {
    this.entries.set(provider, {
      status: 'cooling-down',
      until: this.now() + Math.max(1, retryAfterSeconds) * 1_000,
      reason,
    });
  }

  /** True when the provider must not be contacted right now, for any reason. */
  isBlocked(provider: string): boolean {
    const entry = this.live(provider);
    return entry !== null && entry.status !== 'entitled';
  }

  /** True only for a cached permanent refusal — survives a manual retry. */
  isEntitlementUnavailable(provider: string): boolean {
    return this.live(provider)?.status === 'entitlement-unavailable';
  }

  status(provider: string): OptionsCapabilityStatus {
    return this.live(provider)?.status ?? 'unknown';
  }

  report(provider: string): OptionsCapabilityReport {
    const entry = this.live(provider);
    return {
      provider,
      status: entry?.status ?? 'unknown',
      reason: entry?.reason ?? null,
      retryAfterSeconds: entry && entry.status !== 'entitled'
        ? Math.max(1, Math.ceil((entry.until - this.now()) / 1_000))
        : null,
    };
  }

  /**
   * Clear temporary state for a user-initiated retry. An entitlement verdict is
   * intentionally preserved: a Retry button may not re-arm a refused provider.
   */
  resetRetryable(provider?: string): void {
    const clear = (key: string, entry: CapabilityEntry) => {
      if (entry.status !== 'entitlement-unavailable') this.entries.delete(key);
    };
    if (provider) {
      const entry = this.entries.get(provider);
      if (entry) clear(provider, entry);
      return;
    }
    for (const [key, entry] of [...this.entries]) clear(key, entry);
  }

  clear(): void {
    this.entries.clear();
  }
}
