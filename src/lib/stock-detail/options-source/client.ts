import { optionsUnavailable, type OptionsSrResult } from '@/src/lib/analytics/options-sr';
import {
  gatedOptionsChainSchema,
  normalizeGatedOptionsChain,
  optionsExpirationsSchema,
  type OptionsChain,
  type OptionsExpirations,
} from '@/src/lib/market-data/options/contracts';
import { classifyOptionsFailure, type OptionsFailureClassification } from './planner';

/**
 * Browser data-source for Options S/R. It reuses the EXISTING Phase 11 options
 * endpoints (`/api/market/options/expirations` and `/api/market/options/chain`)
 * — it never opens a second chain pipeline — and always resolves to a typed
 * {@link OptionsSrResult}, folding HTTP/entitlement failures into a typed
 * unavailable state so a failure isolates cleanly (item 19).
 */

interface Envelope<T> {
  data: T | null;
  error?: { code?: string; message?: string; retryable?: boolean; retryAfterSeconds?: number };
  meta?: { provider?: string | null };
}

export interface ExpirationsOutcome {
  ok: boolean;
  data?: OptionsExpirations | null;
  expirations: string[];
  provider: string | null;
  classification: OptionsFailureClassification | null;
  message: string | null;
  /** Seconds the caller should wait before retrying, when the route supplied a Retry-After (429). */
  retryAfterSeconds: number | null;
}

async function readEnvelope<T>(response: Response): Promise<Envelope<T>> {
  try {
    return (await response.json()) as Envelope<T>;
  } catch {
    return { data: null };
  }
}

/** Load the available non-expired expirations for a symbol (reuses the real route). */
export async function fetchOptionsExpirations(symbol: string, signal: AbortSignal): Promise<ExpirationsOutcome> {
  const query = new URLSearchParams({ symbol });
  const response = await fetch(`/api/market/options/expirations?${query.toString()}`, {
    signal, headers: { Accept: 'application/json' }, cache: 'no-store',
  });
  const payload = await readEnvelope<unknown>(response);
  const retryAfterHeader = Number(response.headers.get('retry-after'));
  const retryAfterSeconds = payload.error?.retryAfterSeconds ?? (Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader : null);
  if (!response.ok || !payload.data) {
    const classification = classifyOptionsFailure(response.status, payload.error?.code);
    return { ok: false, data: null, expirations: [], provider: payload.meta?.provider ?? null, classification, message: payload.error?.message ?? 'Options expirations are unavailable.', retryAfterSeconds };
  }
  const parsed = optionsExpirationsSchema.safeParse(payload.data);
  if (!parsed.success) {
    return { ok: false, data: null, expirations: [], provider: payload.meta?.provider ?? null, classification: classifyOptionsFailure(null, 'invalid-provider-response'), message: 'Options expirations failed validation.', retryAfterSeconds: null };
  }
  const today = new Date().toISOString().slice(0, 10);
  const expirations = [...new Set(parsed.data.expirations.filter((value) => value >= today))].sort();
  return { ok: true, data: parsed.data, expirations, provider: parsed.data.provider, classification: null, message: null, retryAfterSeconds: null };
}

export interface FetchOptionsSrOptions {
  /**
   * Whether this reader's plan includes Options Walls. When false the walls
   * request is never made and the result is a typed `subscription-required`
   * state — the browser does not compute Call Wall, Put Wall or Max Pain for
   * itself, so no locked value exists here to leak.
   */
  wallsEntitled?: boolean;
}

/**
 * Load Options Walls from the entitled server endpoint.
 *
 * The levels are computed on the server, behind `options.analytics.walls`, so a
 * reader without the capability receives a refusal rather than a payload — and
 * the browser never runs the calculation itself.
 */
export async function fetchOptionsWalls(
  symbol: string,
  expiration: string,
  acceptedPrice: number | null,
  signal: AbortSignal,
): Promise<OptionsSrResult> {
  const query = new URLSearchParams({ symbol, expiration });
  if (acceptedPrice !== null && Number.isFinite(acceptedPrice) && acceptedPrice > 0) {
    query.set('underlyingPrice', String(acceptedPrice));
  }
  const response = await fetch(`/api/market/options/walls?${query.toString()}`, {
    signal, headers: { Accept: 'application/json' }, cache: 'no-store',
  });
  const payload = await readEnvelope<OptionsSrResult>(response);
  if (!response.ok || !payload.data) {
    const classification = classifyOptionsFailure(response.status, payload.error?.code);
    return optionsUnavailable(
      symbol,
      expiration,
      classification.reason,
      payload.error?.message ?? 'Options walls are unavailable.',
      payload.meta?.provider ?? null,
    );
  }
  return payload.data;
}

/**
 * The last successful chain for this symbol+expiration, retained across a
 * failure so a transient 429/5xx degrades analytics to a labelled STALE reading
 * instead of erasing them. Always carries the provider and the exact time the
 * data was fetched, so nothing stale can ever be presented as current.
 */
export interface OptionsChainStaleFallback {
  chain: OptionsChain;
  result: OptionsSrResult;
  /** ISO timestamp of the successful fetch this fallback came from. */
  fetchedAt: string;
  /** Machine-readable reason the live request failed. */
  reason: string;
}

export interface OptionsChainOutcome {
  ok: boolean;
  chain: OptionsChain | null;
  result: OptionsSrResult;
  provider: string | null;
  classification: OptionsFailureClassification | null;
  retryAfterSeconds: number | null;
  /** Present only on a failure that had a usable last-good chain to fall back to. */
  staleFallback?: OptionsChainStaleFallback | null;
}

/**
 * Load one expiration's chain and compute Options S/R. The single accepted
 * underlying price is passed in so options levels derive their distance from the
 * exact same price the header/chart use — never a second, divergent spot.
 */
export async function fetchOptionsChainOutcome(
  symbol: string,
  expiration: string,
  acceptedPrice: number | null,
  signal: AbortSignal,
  options: FetchOptionsSrOptions = {},
): Promise<OptionsChainOutcome> {
  const query = new URLSearchParams({ symbol, expiration });
  const response = await fetch(`/api/market/options/chain?${query.toString()}`, {
    signal, headers: { Accept: 'application/json' }, cache: 'no-store',
  });
  const payload = await readEnvelope<unknown>(response);
  const retryAfterHeader = Number(response.headers.get('retry-after'));
  const retryAfterSeconds = payload.error?.retryAfterSeconds ?? (Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader : null);
  if (!response.ok || !payload.data) {
    const classification = classifyOptionsFailure(response.status, payload.error?.code);
    const provider = payload.meta?.provider ?? null;
    return {
      ok: false,
      chain: null,
      result: optionsUnavailable(symbol, expiration, classification.reason, payload.error?.message ?? 'Options chain is unavailable.', provider),
      provider,
      classification,
      retryAfterSeconds,
    };
  }
  const parsed = gatedOptionsChainSchema.safeParse(payload.data);
  if (!parsed.success) {
    const provider = payload.meta?.provider ?? null;
    const classification = classifyOptionsFailure(null, 'invalid-provider-response');
    return {
      ok: false,
      chain: null,
      result: optionsUnavailable(symbol, expiration, 'chain-unavailable', 'Options chain failed validation.', provider),
      provider,
      classification,
      retryAfterSeconds: null,
    };
  }
  const chain = normalizeGatedOptionsChain(parsed.data);
  const result = options.wallsEntitled === false
    ? optionsUnavailable(
      chain.underlyingSymbol,
      chain.expiration,
      'subscription-required',
      'Options Walls are not included in this plan.',
      chain.provider,
    )
    : await fetchOptionsWalls(chain.underlyingSymbol, chain.expiration, acceptedPrice, signal);
  return { ok: true, chain, result, provider: chain.provider, classification: null, retryAfterSeconds: null };
}

/** Backwards-compatible result-only boundary used by analytics callers/tests. */
export async function fetchOptionsSr(
  symbol: string,
  expiration: string,
  acceptedPrice: number | null,
  signal: AbortSignal,
  options: FetchOptionsSrOptions = {},
): Promise<OptionsSrResult> {
  return (await fetchOptionsChainOutcome(symbol, expiration, acceptedPrice, signal, options)).result;
}
