import 'server-only';
import { SharedRequestCache, type CacheResolution } from '@/src/lib/shared-request-cache';
import { MarketDataError } from './errors';
import type { CompanyProfile, ProviderResult } from './types';

export const PROFILE_CACHE_POLICY = {
  freshMs: 24 * 60 * 60_000,
  staleMs: 7 * 24 * 60 * 60_000,
  errorMs: 1_000,
} as const;

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

interface ProviderLoadResult extends ProviderResult<CompanyProfile> {
  reasonCode: string | null;
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

function resolutionStatus(
  state: CacheResolution<ProviderLoadResult>['state'],
): CompanyProfileResult['profileStatus'] {
  if (state === 'cache') return 'cached';
  return state;
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

  constructor(
    private readonly primary: CompanyProfileProvider,
    private readonly secondary: CompanyProfileProvider | null,
    private readonly cache = new SharedRequestCache(),
    private readonly now: () => number = Date.now,
  ) {}

  async getCompanyProfile(symbol: string): Promise<CompanyProfileResult> {
    const key = `profile:${symbol}`;
    try {
      const resolution = await this.cache.resolve(
        key,
        () => this.loadProviders(symbol),
        PROFILE_CACHE_POLICY,
      );
      const status = resolutionStatus(resolution.state);
      const cachedAt = new Date(resolution.storedAt).toISOString();
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

  private async loadProviders(symbol: string): Promise<ProviderLoadResult> {
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
