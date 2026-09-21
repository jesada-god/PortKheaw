import 'server-only';
import { SharedRequestCache, type CacheResolution } from '@/src/lib/shared-request-cache';
import { recordProviderCall } from '@/src/lib/monitoring/provider-call-meter';
import { MarketDataError } from './errors';
import {
  companyProfileSourceHash,
  createCompanyProfileSnapshotRepository,
  type CompanyProfileSnapshotRepository,
} from './profile-snapshot-repository';
import type { CompanyProfile, ProviderResult } from './types';

/**
 * How old a stored profile may be before it is refreshed, and how long a stored
 * one may still be served while that refresh is failing.
 *
 * These are now measured against the DATABASE row's `fetched_at`, not against
 * an entry in this process's memory — which is the whole point of the snapshot.
 * The numbers are unchanged: a company profile is a fact that moves a few times
 * a year, so a day is fresh and a week of staleness beats an empty card.
 */
export const PROFILE_CACHE_POLICY = {
  freshMs: 24 * 60 * 60_000,
  staleMs: 7 * 24 * 60 * 60_000,
  errorMs: 1_000,
} as const;

/**
 * The in-process layer, and why it is now minutes rather than a day.
 *
 * `SharedRequestCache` used to BE the profile cache, with a 24-hour freshness
 * it could never honour — each instance held its own copy and a cold start had
 * none. With the database holding the snapshot, this layer stops being the
 * cache and becomes what it is actually good at: collapsing the requests one
 * instance handles in the same few minutes into a single read, and
 * single-flighting the concurrent ones.
 *
 * It has to be SHORTER than the snapshot's own freshness, or it would pin a row
 * this instance read once and keep serving it long after the database had a
 * newer one — the same staleness bug in a new place. Five minutes costs at most
 * one cheap indexed `select` per symbol per instance per five minutes, against
 * the provider call it replaces.
 */
const PROFILE_MEMO_POLICY = {
  freshMs: 5 * 60_000,
  staleMs: 15 * 60_000,
  errorMs: 1_000,
} as const;

/**
 * Which policy the in-process layer runs under, decided by whether anything
 * durable is behind it.
 *
 * With a snapshot repository the memo is a five-minute deduplicator and the
 * database owns freshness. WITHOUT one — a local checkout with no service-role
 * key, or a deployment where it has not been set — there is nothing behind this
 * layer at all, and shortening it would quietly delete the one thing that kept
 * a profile on screen through a provider outage: the seven-day stale window.
 *
 * So the fallback is the ORIGINAL policy, unchanged. A deployment without the
 * table behaves exactly as it did before this cache existed, which is the only
 * acceptable answer for a cache that is allowed to be absent.
 */
function memoPolicyFor(snapshots: CompanyProfileSnapshotRepository | null) {
  return snapshots ? PROFILE_MEMO_POLICY : PROFILE_CACHE_POLICY;
}

const DEFAULT_COOLDOWN_SECONDS = 60;

export interface CompanyProfileProvider {
  readonly id: string;
  getCompanyProfile(symbol: string): Promise<ProviderResult<CompanyProfile>>;
}

export interface CompanyProfileResult extends ProviderResult<CompanyProfile> {
  profileStatus: 'fresh' | 'cached' | 'stale';
  providerUsed: string;
  fallbackUsed: boolean;
  cachedAt: string;
  retryAfterSeconds: number;
  reasonCode: string | null;
}

/**
 * What the provider chain answers with: the profile and why the fallback fired.
 * It knows nothing about storage, which is why it is a separate type from the
 * one the cache holds.
 */
interface ProviderChainResult extends ProviderResult<CompanyProfile> {
  reasonCode: string | null;
}

interface ProviderLoadResult extends ProviderChainResult {
  /**
   * When the provider actually answered for this profile — the database row's
   * `fetched_at` when the snapshot served it, the moment of the call when the
   * provider did.
   *
   * This is what makes the snapshot honest. Without it the in-process layer
   * would report a three-hour-old stored profile as "fresh, cached just now",
   * because from that layer's point of view it WAS loaded just now.
   */
  resolvedAt: string;
  /** Whether this resolution cost an upstream call. Drives the cost meter. */
  servedFrom: 'provider' | 'db-snapshot';
}

function marketError(cause: unknown): MarketDataError {
  return cause instanceof MarketDataError
    ? cause
    : new MarketDataError(
      'upstream-unavailable',
      'Company profile provider is unavailable',
    );
}

function providerReason(prefix: 'PRIMARY' | 'SECONDARY', error: MarketDataError): string {
  const suffix = error.code.toUpperCase().replaceAll('-', '_');
  return `${prefix}_${suffix === 'UPSTREAM_UNAVAILABLE' ? 'UPSTREAM_UNAVAILABLE' : suffix}`;
}

function canFallback(error: MarketDataError): boolean {
  return new Set([
    'provider-not-configured',
    'rate-limited',
    'timeout',
    'upstream-unavailable',
    'invalid-provider-response',
  ]).has(error.code);
}

function retryAfter(error: MarketDataError): number {
  return error.retryAfterSeconds ?? DEFAULT_COOLDOWN_SECONDS;
}

/**
 * What to call this answer, judged against the age of the profile itself.
 *
 * Both inputs matter and they answer different questions. `resolvedAt` is how
 * old the PROFILE is, which is what a reader deciding whether to trust it cares
 * about, and it now survives a process restart because it comes off the stored
 * row. `state` is how this instance got hold of it, which is the only thing the
 * old code could see.
 *
 * `servedFrom` is the third input and it is what keeps `fresh` meaning what it
 * has always meant here: THIS request went to the provider. A row read out of
 * the snapshot is `cached` even when it was written a second ago, because the
 * badge exists to tell a reader they are looking at a stored answer — and a
 * profile that had just been fetched by a different instance is exactly that.
 * Reporting it as `fresh` would make the snapshot invisible to the UI and to
 * the QA that has to verify it.
 */
function resolutionStatus(
  state: CacheResolution<ProviderLoadResult>['state'],
  value: ProviderLoadResult,
  now: number,
): CompanyProfileResult['profileStatus'] {
  const age = now - Date.parse(value.resolvedAt);
  if (Number.isFinite(age) && age > PROFILE_CACHE_POLICY.freshMs) return 'stale';
  if (state === 'fresh' && value.servedFrom === 'provider') return 'fresh';
  return 'cached';
}

function terminalRetryAfter(
  primary: MarketDataError,
  secondary: MarketDataError,
): number | undefined {
  const waits = [primary, secondary]
    .filter((error) => error.code === 'rate-limited')
    .map(retryAfter);
  return waits.length > 0 ? Math.min(...waits) : undefined;
}

function logProfileResolution(input: {
  symbol: string;
  providerUsed: string | null;
  fallbackReason: string | null;
  cacheState: 'fresh' | 'cached' | 'stale' | 'unavailable';
  cooldownUntil: string | null;
  errorCode: string | null;
}): void {
  const entry = {
    event: 'market_profile_resolved',
    symbol: input.symbol,
    providerUsed: input.providerUsed,
    fallbackReason: input.fallbackReason,
    cacheState: input.cacheState,
    cooldownUntil: input.cooldownUntil,
    errorCode: input.errorCode,
    timestamp: new Date().toISOString(),
  };
  if (input.errorCode) console.warn(JSON.stringify(entry));
  else console.info(JSON.stringify(entry));
}

export class CompanyProfileService {
  private readonly cooldowns = new Map<string, number>();
  /**
   * Symbols whose background refresh is already running.
   *
   * A stale row is served to everybody who asks while one refresh runs behind
   * them. Without this set, a popular symbol going stale would start a provider
   * call per reader — the stampede the snapshot exists to prevent, arriving one
   * layer down.
   */
  private readonly refreshing = new Set<string>();

  constructor(
    private readonly primary: CompanyProfileProvider,
    private readonly secondary: CompanyProfileProvider | null,
    private readonly cache = new SharedRequestCache(),
    private readonly now: () => number = Date.now,
    /**
     * `undefined` means "resolve the real one"; `null` means "this deployment
     * has none". The distinction is what lets a test run the whole read-through
     * with no database while production still gets one by default.
     */
    private readonly snapshots: CompanyProfileSnapshotRepository | null
      = createCompanyProfileSnapshotRepository(),
  ) {}

  async getCompanyProfile(symbol: string): Promise<CompanyProfileResult> {
    const key = `profile:${symbol}`;
    try {
      const resolution = await this.cache.resolve(
        key,
        () => this.loadThroughSnapshot(symbol),
        memoPolicyFor(this.snapshots),
      );
      const status = resolutionStatus(resolution.state, resolution.value, this.now());
      // The age of the PROFILE, not of this instance's memo of it.
      const cachedAt = resolution.value.resolvedAt;
      const failedRefresh = resolution.error ? marketError(resolution.error) : null;
      const providerUsed = resolution.value.provider ?? this.primary.id;
      const fallbackUsed = providerUsed !== this.primary.id;
      const reasonCode = failedRefresh?.context?.reason
        ?? resolution.value.reasonCode;
      const primaryCooldownUntil = this.cooldowns.get(this.primary.id) ?? 0;
      const cooldownUntil = primaryCooldownUntil > this.now()
        ? new Date(primaryCooldownUntil).toISOString()
        : null;
      const retryAfterSeconds = failedRefresh?.retryAfterSeconds
        ?? (primaryCooldownUntil > this.now()
          ? Math.max(1, Math.ceil((primaryCooldownUntil - this.now()) / 1_000))
          : 0);

      logProfileResolution({
        symbol,
        providerUsed,
        fallbackReason: reasonCode,
        cacheState: status,
        cooldownUntil,
        errorCode: failedRefresh?.code ?? null,
      });

      return {
        ...resolution.value,
        provider: providerUsed,
        providerUsed,
        fallbackUsed,
        profileStatus: status,
        cachedAt,
        retryAfterSeconds,
        reasonCode,
        freshness: {
          ...resolution.value.freshness,
          status: status === 'fresh'
            ? resolution.value.freshness.status
            : status,
          cachedAt,
          maxAgeSeconds: status === 'stale'
            ? DEFAULT_COOLDOWN_SECONDS
            : PROFILE_CACHE_POLICY.freshMs / 1_000,
          staleWhileRevalidateSeconds: PROFILE_CACHE_POLICY.staleMs / 1_000,
        },
      };
    } catch (cause) {
      const error = marketError(cause);
      const primaryCooldownUntil = this.cooldowns.get(this.primary.id) ?? 0;
      logProfileResolution({
        symbol,
        providerUsed: null,
        fallbackReason: error.context?.reason ?? error.code,
        cacheState: 'unavailable',
        cooldownUntil: primaryCooldownUntil > this.now()
          ? new Date(primaryCooldownUntil).toISOString()
          : null,
        errorCode: error.code,
      });
      throw error;
    }
  }

  private providerCooldownError(provider: CompanyProfileProvider): MarketDataError | null {
    const blockedUntil = this.cooldowns.get(provider.id) ?? 0;
    if (blockedUntil <= this.now()) return null;
    return new MarketDataError(
      'rate-limited',
      `${provider.id} is in Retry-After cooldown`,
      Math.max(1, Math.ceil((blockedUntil - this.now()) / 1_000)),
    );
  }

  private async requestProvider(
    provider: CompanyProfileProvider,
    symbol: string,
  ): Promise<ProviderResult<CompanyProfile>> {
    const cooldown = this.providerCooldownError(provider);
    if (cooldown) throw cooldown;
    try {
      return await provider.getCompanyProfile(symbol);
    } catch (cause) {
      const error = marketError(cause);
      if (error.code === 'rate-limited') {
        this.cooldowns.set(
          provider.id,
          this.now() + retryAfter(error) * 1_000,
        );
      }
      throw error;
    }
  }

  /**
   * The read-through: database first, provider only when the database cannot
   * answer.
   *
   * ==========================================================================
   * THE THREE CASES, AND WHY THE MIDDLE ONE IS THE IMPORTANT ONE
   * ==========================================================================
   *   HIT, fresh    the row is inside `freshMs`. Served, no provider touched.
   *   HIT, stale    the row is past `freshMs` but inside `staleMs`. Served
   *                 IMMEDIATELY, with one refresh started behind the reader.
   *   MISS          no row, an unparseable row, or one past `staleMs`. The
   *                 provider chain runs and the answer is stored.
   *
   * The stale case is what stops a provider outage from becoming a product
   * outage: nobody waits for a call that is going to fail, and nobody sees an
   * empty card. It is also what stops a daily expiry from becoming a daily
   * latency spike for whoever happens to ask first.
   *
   * ==========================================================================
   * WHAT IS NOT HERE
   * ==========================================================================
   * The provider fallback chain. `loadProviders` — FMP primary, secondary for a
   * missing logo, cooldowns, the reason codes — is called unchanged and is not
   * reimplemented, re-ordered or second-guessed by this method. This layer only
   * decides WHETHER to call it.
   *
   * Every database interaction fails open. A missing table, a revoked key, a
   * network blip: each is caught, logged, and leaves the product doing exactly
   * what it did before this cache existed. A cache that can take the product
   * down is worse than no cache.
   */
  private async loadThroughSnapshot(symbol: string): Promise<ProviderLoadResult> {
    /*
     * No repository, no read-through — and the return is deliberately NOT
     * awaited here.
     *
     * An `await` on this line would push the provider call into a later
     * microtask, which is not a performance detail: `SharedRequestCache`
     * registers the in-flight promise synchronously, so two concurrent callers
     * still collapse into one, but any caller inspecting the provider spy
     * immediately after would see zero calls. Returning the promise keeps the
     * provider invoked in the same tick, exactly as it was before this layer
     * existed.
     */
    if (!this.snapshots) return this.loadFromProvidersAndStore(symbol);

    const stored = await this.readSnapshot(symbol);
    if (stored) {
      const age = this.now() - Date.parse(stored.fetchedAt);
      const withinFresh = Number.isFinite(age) && age <= PROFILE_CACHE_POLICY.freshMs;
      const withinStale = Number.isFinite(age)
        && age <= PROFILE_CACHE_POLICY.freshMs + PROFILE_CACHE_POLICY.staleMs;

      if (withinFresh || withinStale) {
        recordProviderCall({
          provider: this.primary.id,
          operation: 'company-profile',
          source: 'db-snapshot',
          outcome: 'success',
        });
        if (!withinFresh) this.refreshInBackground(symbol);
        return {
          data: stored.profile,
          provider: stored.provider,
          reasonCode: withinFresh ? null : 'SNAPSHOT_STALE_REFRESHING',
          resolvedAt: stored.fetchedAt,
          servedFrom: 'db-snapshot',
          freshness: {
            status: withinFresh ? 'cached' : 'stale',
            asOf: stored.fetchedAt,
            maxAgeSeconds: PROFILE_CACHE_POLICY.freshMs / 1_000,
            cachedAt: stored.fetchedAt,
            staleWhileRevalidateSeconds: PROFILE_CACHE_POLICY.staleMs / 1_000,
          },
        };
      }
    }

    return this.loadFromProvidersAndStore(symbol);
  }

  /** The provider chain, metered, with the answer written back. */
  private async loadFromProvidersAndStore(symbol: string): Promise<ProviderLoadResult> {
    const startedAt = this.now();
    let loaded: Awaited<ReturnType<CompanyProfileService['loadProviders']>>;
    try {
      loaded = await this.loadProviders(symbol);
    } catch (cause) {
      recordProviderCall({
        provider: this.primary.id,
        operation: 'company-profile',
        source: 'provider',
        outcome: 'error',
        durationMs: this.now() - startedAt,
      });
      throw cause;
    }
    recordProviderCall({
      provider: loaded.provider ?? this.primary.id,
      operation: 'company-profile',
      source: 'provider',
      outcome: 'success',
      durationMs: this.now() - startedAt,
    });

    const resolvedAt = new Date(this.now()).toISOString();
    await this.writeSnapshot({
      symbol,
      profile: loaded.data,
      provider: loaded.provider ?? this.primary.id,
      sourceHash: companyProfileSourceHash(loaded.data),
      fetchedAt: resolvedAt,
    });
    return { ...loaded, resolvedAt, servedFrom: 'provider' };
  }

  /**
   * Refresh a stale row without making anybody wait for it.
   *
   * `void`, never awaited, and guarded by `refreshing` so a stale popular
   * symbol costs one provider call rather than one per reader. A failure here
   * is deliberately swallowed: the reader has already been served the stale
   * profile, and the row stays stale so the next request tries again.
   */
  private refreshInBackground(symbol: string): void {
    if (this.refreshing.has(symbol)) return;
    this.refreshing.add(symbol);
    void this.loadFromProvidersAndStore(symbol)
      .catch(() => undefined)
      .finally(() => this.refreshing.delete(symbol));
  }

  private async readSnapshot(symbol: string) {
    if (!this.snapshots) return null;
    try {
      return await this.snapshots.get(symbol);
    } catch (cause) {
      console.warn(JSON.stringify({
        event: 'company_profile_snapshot_read_failed',
        symbol,
        message: cause instanceof Error ? cause.message : 'unknown',
      }));
      return null;
    }
  }

  private async writeSnapshot(
    snapshot: Parameters<CompanyProfileSnapshotRepository['upsert']>[0],
  ): Promise<void> {
    if (!this.snapshots) return;
    try {
      await this.snapshots.upsert(snapshot);
    } catch (cause) {
      console.warn(JSON.stringify({
        event: 'company_profile_snapshot_write_failed',
        symbol: snapshot.symbol,
        message: cause instanceof Error ? cause.message : 'unknown',
      }));
    }
  }

  private async loadProviders(symbol: string): Promise<ProviderChainResult> {
    let primaryError: MarketDataError;
    try {
      const result = await this.requestProvider(this.primary, symbol);
      if (!result.data.logoUrl && this.secondary) {
        try {
          const secondary = await this.requestProvider(this.secondary, symbol);
          if (secondary.data.logoUrl) {
            return {
              ...result,
              data: {
                ...result.data,
                logoUrl: secondary.data.logoUrl,
              },
              provider: `${result.provider ?? this.primary.id}+${secondary.provider ?? this.secondary.id}`,
              reasonCode: 'PRIMARY_LOGO_MISSING',
            };
          }
          return {
            ...result,
            provider: result.provider ?? this.primary.id,
            reasonCode: 'PRIMARY_LOGO_MISSING; SECONDARY_LOGO_MISSING',
          };
        } catch (cause) {
          const secondaryError = marketError(cause);
          return {
            ...result,
            provider: result.provider ?? this.primary.id,
            reasonCode: `PRIMARY_LOGO_MISSING; ${providerReason('SECONDARY', secondaryError)}`,
          };
        }
      }
      return {
        ...result,
        provider: result.provider ?? this.primary.id,
        reasonCode: null,
      };
    } catch (cause) {
      primaryError = marketError(cause);
      if (!canFallback(primaryError)) throw primaryError;
    }

    const primaryReason = providerReason('PRIMARY', primaryError);
    if (!this.secondary) {
      throw new MarketDataError(
        'upstream-unavailable',
        'Company profile is temporarily unavailable',
        primaryError.code === 'rate-limited' ? retryAfter(primaryError) : undefined,
        undefined,
        {
          reason: `${primaryReason}; SECONDARY_PROVIDER_NOT_CONFIGURED`,
          primaryReason,
          fallbackReason: 'SECONDARY_PROVIDER_NOT_CONFIGURED',
          lastAvailableAt: null,
        },
      );
    }

    try {
      const result = await this.requestProvider(this.secondary, symbol);
      return {
        ...result,
        provider: result.provider ?? this.secondary.id,
        reasonCode: primaryReason,
      };
    } catch (cause) {
      const secondaryError = marketError(cause);
      const secondaryReason = providerReason('SECONDARY', secondaryError);
      const bothRateLimited = primaryError.code === 'rate-limited'
        && secondaryError.code === 'rate-limited';
      throw new MarketDataError(
        bothRateLimited ? 'rate-limited' : 'upstream-unavailable',
        'Company profile is temporarily unavailable',
        terminalRetryAfter(primaryError, secondaryError),
        undefined,
        {
          reason: `${primaryReason}; ${secondaryReason}`,
          primaryReason,
          fallbackReason: secondaryReason,
          lastAvailableAt: null,
        },
      );
    }
  }
}
