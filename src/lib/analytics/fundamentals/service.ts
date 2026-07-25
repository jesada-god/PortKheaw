import 'server-only';
import { MarketDataError } from '../../market-data/errors';
import type { FinancialPeriod } from './types';
import type { FundamentalsProvider, FundamentalsSnapshot } from './provider';
import { validateFundamentalsSnapshot } from './validation';

/**
 * Deterministic primary → secondary fundamentals fallback.
 *
 * The primary (Alpha Vantage) never throws on a throttled dataset: it returns an
 * unusable snapshot (zero periods) carrying per-dataset `datasetErrors`. This
 * service reads that truthful state and, only for eligible temporary failures,
 * asks the configured secondary (FMP) for one complete replacement snapshot. It
 * never merges periods from two providers and never erases a usable primary or a
 * truthful typed failure. Every returned snapshot keeps honest provenance.
 */

const ELIGIBLE_CODES = new Set([
  'rate-limited',
  'timeout',
  'upstream-unavailable',
  'provider-unavailable',
  'invalid-provider-response',
]);
const DEFAULT_COOLDOWN_SECONDS = 60;
const LKG_DATASET = 'financial-statements';
const LKG_SCHEMA_VERSION = 1;
const DAY_MS = 86_400_000;

function financialStatementsFreshness(
  asOf: string | null | undefined,
  now = Date.now(),
): 'fresh' | 'stale' | 'expired' | 'missing' {
  if (!asOf) return 'missing';
  const timestamp = Date.parse(asOf);
  if (!Number.isFinite(timestamp)) return 'missing';
  const age = now - timestamp;
  if (age < -DAY_MS) return 'expired';
  if (age <= 550 * DAY_MS) return 'fresh';
  if (age <= 800 * DAY_MS) return 'stale';
  return 'expired';
}

export interface FundamentalsServiceLog {
  event: string;
  symbol: string;
  primaryProvider?: string;
  providerUsed?: string | null;
  fallbackReason?: string | null;
  errorCode?: string | null;
}

type Logger = (entry: FundamentalsServiceLog) => void;

export interface FundamentalsLkgEntry {
  symbol: string;
  dataset: typeof LKG_DATASET;
  financialPeriods: FinancialPeriod[];
  snapshot: FundamentalsSnapshot;
  provider: string;
  sourceAsOf: string;
  fetchedAt: string;
  validatedAt: string;
  schemaVersion: number;
}

export interface FundamentalsLkgRepository {
  get(symbol: string, dataset: typeof LKG_DATASET): Promise<FundamentalsLkgEntry | null>;
  upsert(entry: FundamentalsLkgEntry): Promise<void>;
}

interface FundamentalsServiceOptions {
  repository?: FundamentalsLkgRepository | null;
  authoritativeFallback?: FundamentalsProvider | null;
}

function defaultLogger(entry: FundamentalsServiceLog): void {
  const payload = { ...entry, timestamp: new Date().toISOString() };
  if (entry.errorCode) console.warn(JSON.stringify(payload));
  else console.info(JSON.stringify(payload));
}

function isUsable(snapshot: FundamentalsSnapshot): boolean {
  return snapshot.periods.length > 0
    && validateFundamentalsSnapshot(snapshot, snapshot.symbol).valid;
}

/** A primary snapshot is fallback-eligible only when it produced no usable real
 * data *and* every dataset that failed did so for an eligible temporary reason.
 * Genuinely-empty filings (no dataset errors) and operator-action faults
 * (unauthorized/not-configured/invalid-symbol) are deliberately excluded. */
function primaryEligibleReason(snapshot: FundamentalsSnapshot): string | null {
  if (isUsable(snapshot)) return null;
  if (snapshot.periods.length > 0) return 'PRIMARY_INVALID_PROVIDER_RESPONSE';
  const codes = Object.values(snapshot.datasetErrors ?? {});
  if (codes.length === 0) return null;
  if (!codes.every((code) => ELIGIBLE_CODES.has(code))) return null;
  const dominant = codes.includes('rate-limited') ? 'rate-limited' : codes[0];
  return `PRIMARY_${dominant.toUpperCase().replaceAll('-', '_')}`;
}

function errorReason(prefix: 'PRIMARY' | 'SECONDARY', error: MarketDataError): string {
  return `${prefix}_${error.code.toUpperCase().replaceAll('-', '_')}`;
}

function withProvenance(
  snapshot: FundamentalsSnapshot,
  provenance: Pick<FundamentalsSnapshot, 'primaryProvider' | 'providerUsed' | 'fallbackUsed' | 'fallbackReason'>,
): FundamentalsSnapshot {
  return { ...snapshot, ...provenance };
}

export class FundamentalsService implements FundamentalsProvider {
  readonly id: string;
  private readonly cooldowns = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<FundamentalsSnapshot>>();

  constructor(
    private readonly primary: FundamentalsProvider,
    private readonly secondary: FundamentalsProvider | null,
    private readonly now: () => number = Date.now,
    private readonly log: Logger = defaultLogger,
    private readonly options: FundamentalsServiceOptions = {},
  ) {
    this.id = primary.id;
  }

  getConsensusForwardEps(symbol: string) {
    if (!this.primary.getConsensusForwardEps) {
      return Promise.reject(new MarketDataError('unsupported', 'Consensus forward EPS is not supported'));
    }
    return this.primary.getConsensusForwardEps(symbol);
  }

  async getFinancialPeriods(rawSymbol: string, signal?: AbortSignal): Promise<FundamentalsSnapshot> {
    const symbol = rawSymbol.trim().toUpperCase();
    const existing = this.inflight.get(symbol);
    if (existing) return existing;
    const operation = this.resolve(symbol, signal).finally(() => this.inflight.delete(symbol));
    this.inflight.set(symbol, operation);
    return operation;
  }

  private cooldownActive(providerId: string): boolean {
    return (this.cooldowns.get(providerId) ?? 0) > this.now();
  }

  private async resolve(symbol: string, signal?: AbortSignal): Promise<FundamentalsSnapshot> {
    const lkg = await this.readLkg(symbol);
    if (lkg && financialStatementsFreshness(lkg.sourceAsOf, this.now()) === 'fresh') {
      this.log({
        event: 'fundamentals-lkg-used',
        symbol,
        providerUsed: lkg.provider,
        fallbackReason: 'PERSISTENT_LKG_FRESH',
      });
      return this.fromLkg(lkg, 'provider-cached', 'PERSISTENT_LKG_FRESH');
    }

    let primary: FundamentalsSnapshot | null = null;
    let primaryReason: string | null = null;
    try {
      primary = await this.primary.getFinancialPeriods(symbol, signal);
      if (Object.values(primary.diagnostics.cache ?? {}).includes('hit')) {
        this.log({ event: 'fundamentals-cache-used', symbol, primaryProvider: this.primary.id });
      }
      primaryReason = primaryEligibleReason(primary);
      if (!primaryReason) {
        if (isUsable(primary)) {
          const result = withProvenance(primary, {
            primaryProvider: this.primary.id,
            providerUsed: this.primary.id,
            fallbackUsed: false,
            fallbackReason: null,
          });
          await this.writeLkg(symbol, result);
          return { ...result, dataState: this.providerDataState(result) };
        }
        if (lkg) {
          primaryReason = 'PRIMARY_EMPTY';
        } else {
          return withProvenance(primary, {
            primaryProvider: this.primary.id,
            providerUsed: this.primary.id,
            fallbackUsed: false,
            fallbackReason: null,
          });
        }
      }
    } catch (cause) {
      const error = cause instanceof MarketDataError ? cause : new MarketDataError('upstream-unavailable', 'Fundamentals provider failed');
      if (!ELIGIBLE_CODES.has(error.code)) throw error;
      primaryReason = errorReason('PRIMARY', error);
    }

    this.log({ event: 'fundamentals-primary-failed', symbol, primaryProvider: this.primary.id, fallbackReason: primaryReason });

    if (!this.secondary || this.cooldownActive(this.secondary.id)) {
      return this.recoverAfterProviders(
        symbol,
        primary,
        primaryReason,
        this.secondary ? 'SECONDARY_COOLDOWN' : 'SECONDARY_NOT_CONFIGURED',
        lkg,
        signal,
      );
    }

    this.log({ event: 'fundamentals-fallback-started', symbol, primaryProvider: this.primary.id, providerUsed: this.secondary.id, fallbackReason: primaryReason });

    let secondary: FundamentalsSnapshot;
    try {
      secondary = await this.secondary.getFinancialPeriods(symbol, signal);
    } catch (cause) {
      const error = cause instanceof MarketDataError ? cause : new MarketDataError('upstream-unavailable', 'Secondary fundamentals provider failed');
      if (error.code === 'rate-limited') {
        this.cooldowns.set(this.secondary.id, this.now() + (error.retryAfterSeconds ?? DEFAULT_COOLDOWN_SECONDS) * 1_000);
      }
      this.log({ event: 'fundamentals-fallback-failed', symbol, providerUsed: this.secondary.id, fallbackReason: primaryReason, errorCode: error.code });
      return this.recoverAfterProviders(
        symbol,
        primary,
        primaryReason,
        errorReason('SECONDARY', error),
        lkg,
        signal,
        error,
      );
    }

    if (secondary.symbol.trim().toUpperCase() !== symbol) {
      this.log({ event: 'provider-identity-mismatch', symbol, providerUsed: this.secondary.id, errorCode: 'provider-identity-mismatch' });
      return this.recoverAfterProviders(
        symbol, primary, primaryReason, 'SECONDARY_IDENTITY_MISMATCH', lkg, signal,
      );
    }

    if (!isUsable(secondary)) {
      const secondaryCodes = Object.values(secondary.datasetErrors ?? {});
      const secondaryReason = secondaryCodes.includes('rate-limited')
        ? 'SECONDARY_RATE_LIMITED'
        : secondaryCodes.length > 0 ? `SECONDARY_${secondaryCodes[0].toUpperCase().replaceAll('-', '_')}` : 'SECONDARY_INSUFFICIENT_DATA';
      this.log({ event: 'fundamentals-fallback-failed', symbol, providerUsed: this.secondary.id, fallbackReason: primaryReason, errorCode: secondaryReason });
      return this.recoverAfterProviders(
        symbol, primary, primaryReason, secondaryReason, lkg, signal,
      );
    }

    this.log({ event: 'fundamentals-fallback-succeeded', symbol, primaryProvider: this.primary.id, providerUsed: this.secondary.id, fallbackReason: primaryReason });
    const result = withProvenance(secondary, {
      primaryProvider: this.primary.id,
      providerUsed: this.secondary.id,
      fallbackUsed: true,
      fallbackReason: primaryReason,
    });
    await this.writeLkg(symbol, result);
    return { ...result, dataState: this.providerDataState(result) };
  }

  private providerDataState(
    snapshot: FundamentalsSnapshot,
  ): NonNullable<FundamentalsSnapshot['dataState']> {
    const states = Object.values(snapshot.diagnostics.cache ?? {});
    if (states.includes('stale')) return 'provider-stale';
    if (states.length > 0 && states.every((state) => state === 'hit')) return 'provider-cached';
    return snapshot.dataState === 'authoritative-filing'
      ? 'authoritative-filing'
      : 'provider-live';
  }

  private async readLkg(symbol: string): Promise<FundamentalsLkgEntry | null> {
    if (!this.options.repository) return null;
    try {
      const entry = await this.options.repository.get(symbol, LKG_DATASET);
      if (!entry || entry.schemaVersion !== LKG_SCHEMA_VERSION) return null;
      const validation = validateFundamentalsSnapshot(entry.snapshot, symbol);
      if (!validation.valid) {
        this.log({
          event: 'fundamentals-lkg-rejected',
          symbol,
          providerUsed: entry.provider,
          errorCode: validation.reasons.join(','),
        });
        return null;
      }
      return entry;
    } catch {
      this.log({ event: 'fundamentals-lkg-read-failed', symbol, errorCode: 'persistent-cache-read-failed' });
      return null;
    }
  }

  private async writeLkg(symbol: string, snapshot: FundamentalsSnapshot): Promise<void> {
    if (!this.options.repository) return;
    const validation = validateFundamentalsSnapshot(snapshot, symbol);
    if (!validation.valid) {
      this.log({
        event: 'fundamentals-lkg-write-rejected',
        symbol,
        providerUsed: snapshot.providerUsed ?? snapshot.diagnostics.provider,
        errorCode: validation.reasons.join(','),
      });
      return;
    }
    const validatedAt = new Date(this.now()).toISOString();
    try {
      await this.options.repository.upsert({
        symbol,
        dataset: LKG_DATASET,
        financialPeriods: snapshot.periods,
        snapshot,
        provider: snapshot.providerUsed ?? snapshot.diagnostics.provider,
        sourceAsOf: snapshot.asOf,
        fetchedAt: snapshot.fetchedAt,
        validatedAt,
        schemaVersion: LKG_SCHEMA_VERSION,
      });
      this.log({
        event: 'fundamentals-lkg-written',
        symbol,
        providerUsed: snapshot.providerUsed ?? snapshot.diagnostics.provider,
      });
    } catch {
      this.log({ event: 'fundamentals-lkg-write-failed', symbol, errorCode: 'persistent-cache-write-failed' });
    }
  }

  private fromLkg(
    entry: FundamentalsLkgEntry,
    dataState: 'provider-cached' | 'provider-stale',
    reason: string,
  ): FundamentalsSnapshot {
    const cacheState = dataState === 'provider-stale' ? 'stale' : 'hit';
    return {
      ...entry.snapshot,
      diagnostics: {
        ...entry.snapshot.diagnostics,
        cache: Object.fromEntries(
          Object.keys(entry.snapshot.diagnostics.cache).map((dataset) => [dataset, cacheState]),
        ),
      },
      providerUsed: entry.provider,
      fallbackUsed: true,
      fallbackReason: reason,
      dataState,
    };
  }

  private async recoverAfterProviders(
    symbol: string,
    primary: FundamentalsSnapshot | null,
    primaryReason: string | null,
    secondaryReason: string,
    lkg: FundamentalsLkgEntry | null,
    signal?: AbortSignal,
    thrown?: MarketDataError,
  ): Promise<FundamentalsSnapshot> {
    const lkgFreshness = lkg
      ? financialStatementsFreshness(lkg.sourceAsOf, this.now())
      : 'missing';
    if (lkg && lkgFreshness === 'stale') {
      this.log({
        event: 'fundamentals-lkg-used',
        symbol,
        providerUsed: lkg.provider,
        fallbackReason: `${primaryReason}; ${secondaryReason}; PERSISTENT_LKG_STALE`,
      });
      return this.fromLkg(
        lkg,
        'provider-stale',
        `${primaryReason}; ${secondaryReason}; PERSISTENT_LKG_STALE`,
      );
    }

    const filing = this.options.authoritativeFallback;
    if (filing) {
      this.log({
        event: 'fundamentals-authoritative-fallback-started',
        symbol,
        providerUsed: filing.id,
        fallbackReason: `${primaryReason}; ${secondaryReason}`,
      });
      try {
        const snapshot = await filing.getFinancialPeriods(symbol, signal);
        const validation = validateFundamentalsSnapshot(snapshot, symbol);
        if (validation.valid) {
          const result = withProvenance(snapshot, {
            primaryProvider: this.primary.id,
            providerUsed: filing.id,
            fallbackUsed: true,
            fallbackReason: `${primaryReason}; ${secondaryReason}`,
          });
          await this.writeLkg(symbol, result);
          return { ...result, dataState: 'authoritative-filing' };
        }
        this.log({
          event: 'fundamentals-authoritative-fallback-rejected',
          symbol,
          providerUsed: filing.id,
          errorCode: validation.reasons.join(','),
        });
      } catch (cause) {
        this.log({
          event: 'fundamentals-authoritative-fallback-failed',
          symbol,
          providerUsed: filing.id,
          errorCode: cause instanceof MarketDataError ? cause.code : 'upstream-unavailable',
        });
      }
    }
    return this.primaryOrThrow(symbol, primary, primaryReason, secondaryReason, thrown);
  }

  /** Preserve the truthful primary snapshot when the secondary cannot help. If the
   * primary itself threw an eligible error and produced no snapshot, surface that
   * as a typed failure so the caller reports an honest unavailable/rate-limited
   * state rather than fabricating data. */
  private primaryOrThrow(
    symbol: string,
    primary: FundamentalsSnapshot | null,
    primaryReason: string | null,
    secondaryReason: string,
    thrown?: MarketDataError,
  ): FundamentalsSnapshot {
    const fallbackReason = `${primaryReason ?? 'PRIMARY_UNAVAILABLE'}; ${secondaryReason}`;
    if (primary) {
      return withProvenance(primary, {
        primaryProvider: this.primary.id,
        providerUsed: this.primary.id,
        fallbackUsed: false,
        fallbackReason,
      });
    }
    throw thrown ?? new MarketDataError(
      primaryReason?.includes('RATE_LIMITED') ? 'rate-limited' : 'upstream-unavailable',
      'Fundamentals are temporarily unavailable across all configured providers',
      undefined,
      undefined,
      { reason: fallbackReason },
    );
  }
}
