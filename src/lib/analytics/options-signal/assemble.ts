import { calculateAtmIv } from '@/src/lib/market-data/options/analytics';
import type { OptionsChain } from '@/src/lib/market-data/options/contracts';
import type { OptionsSrResult } from '@/src/lib/analytics/options-sr/types';
import type {
  EventRiskInput,
  IvPricingInput,
  MacroInput,
  MomentumInput,
  OptionsSignalDataState,
  OptionsSignalInput,
  OptionsSignalInputSlot,
  PriceLevelsInput,
  RiskRewardInput,
  SentimentInput,
  TrendInput,
} from './types';

/**
 * Everything the Options Signal needs that is derived from the daily candle
 * pipeline and the earnings calendar. Computed once on the server, fully
 * serializable, and re-anchored in the browser to the single accepted price.
 */
export interface OptionsSignalServerContext {
  symbol: string;
  timeframe: '1D';
  calculatedAt: string;
  latestCandleAt: string | null;
  finalizedCandles: number;
  macro: OptionsSignalInputSlot<MacroInput>;
  trend: OptionsSignalInputSlot<TrendInput>;
  momentum: OptionsSignalInputSlot<MomentumInput>;
  levels: OptionsSignalInputSlot<PriceLevelsInput>;
  event: OptionsSignalInputSlot<EventRiskInput>;
  /** Annualized realized volatility of the underlying; the IV comparison baseline. */
  realizedVolatility: { value: number; observations: number } | null;
}

/**
 * The last-good chain the browser coordinator kept across a failed refresh.
 * Used ONLY when the live request produced nothing, and always surfaced as
 * `STALE` with the provider and the original fetch time.
 */
export interface OptionsSignalStaleChain {
  chain: OptionsChain;
  result: OptionsSrResult;
  fetchedAt: string;
  reason: string;
}

export interface OptionsSignalOptionsInputs {
  /** The live chain for the nearest expiration, or null when it is not loaded. */
  chain: OptionsChain | null;
  /** The already-computed Options S/R result for the SAME chain (owns Put/Call OI). */
  optionsSr: OptionsSrResult | null;
  /**
   * Stale-if-error fallback. A transient 429/5xx must degrade Put/Call and IV to
   * a labelled STALE reading rather than erasing them, but it may never be
   * mistaken for current data.
   */
  staleFallback?: OptionsSignalStaleChain | null;
  /**
   * A real historical IV Rank, when a provider ever supplies one. No currently
   * entitled provider does, so this stays undefined and the engine falls back to
   * the explicitly-labelled IV-vs-realized basis.
   */
  ivRank?: { ivRank: number; observations: number };
}

/**
 * Resolve which chain the options-derived factors should read.
 *
 * The live chain always wins. A stale fallback is used only when there is no
 * live chain at all, and it forces `STALE` regardless of the status frozen into
 * the cached payload.
 */
function resolveChainSource(options: OptionsSignalOptionsInputs): {
  chain: OptionsChain | null;
  result: OptionsSrResult | null;
  state: Exclude<OptionsSignalDataState, 'UNAVAILABLE'> | null;
  asOf: string | null;
  staleReason: string | null;
} {
  if (options.chain) {
    return {
      chain: options.chain,
      result: options.optionsSr,
      state: dataStateFromChainStatus(options.chain.status),
      asOf: options.chain.asOf,
      staleReason: null,
    };
  }
  const fallback = options.staleFallback;
  if (fallback) {
    return {
      chain: fallback.chain,
      result: fallback.result,
      state: 'STALE',
      asOf: fallback.fetchedAt,
      staleReason: fallback.reason,
    };
  }
  return { chain: null, result: options.optionsSr, state: null, asOf: null, staleReason: null };
}

export function dataStateFromChainStatus(
  status: OptionsChain['status'],
): Exclude<OptionsSignalDataState, 'UNAVAILABLE'> {
  switch (status) {
    case 'live': return 'LIVE';
    case 'delayed':
    case 'cached': return 'DELAYED';
    default: return 'STALE';
  }
}

function unavailableSlot<T>(reason: string, provider: string | null = null, asOf: string | null = null): OptionsSignalInputSlot<T> {
  return { status: 'unavailable', state: 'UNAVAILABLE', reason, provider, asOf };
}

/**
 * Risk/Reward anchored to the single accepted underlying price the header and
 * chart already display, using the confirmed daily zones from the server.
 */
export function buildRiskRewardSlot(
  levels: OptionsSignalInputSlot<PriceLevelsInput>,
  acceptedPrice: number | null,
): OptionsSignalInputSlot<RiskRewardInput> {
  if (levels.status === 'unavailable') return levels as OptionsSignalInputSlot<RiskRewardInput>;
  const price = acceptedPrice !== null && Number.isFinite(acceptedPrice) && acceptedPrice > 0
    ? acceptedPrice
    : levels.value.close;
  return {
    status: 'available',
    state: levels.state,
    value: { price, support: levels.value.support, resistance: levels.value.resistance },
    provider: levels.provider,
    asOf: levels.asOf,
  };
}

/**
 * Options pricing richness from real numbers only.
 *
 * IV Rank is preferred but needs a historical IV series no entitled provider
 * offers; the fallback compares today's real ATM implied volatility with the
 * underlying's own realized volatility and is always labelled with its basis.
 */
export function buildPricingSlot(
  options: OptionsSignalOptionsInputs,
  realized: { value: number; observations: number } | null,
): OptionsSignalInputSlot<IvPricingInput> {
  const source = resolveChainSource(options);
  const chain = source.chain;
  const atm = chain ? calculateAtmIv(chain) : null;
  const impliedVolatility = atm?.status === 'available' ? atm.iv : null;

  if (options.ivRank) {
    return {
      status: 'available',
      state: source.state ?? 'DELAYED',
      value: {
        basis: 'iv-rank',
        ivRank: options.ivRank.ivRank,
        impliedVolatility,
        observations: options.ivRank.observations,
      },
      provider: chain?.provider ?? null,
      asOf: source.asOf,
    };
  }

  if (!chain || source.state === null) return unavailableSlot('ยังไม่ได้โหลด options chain');
  if (impliedVolatility === null || impliedVolatility <= 0) {
    return unavailableSlot(
      atm?.reason ?? 'ผู้ให้บริการไม่ได้ส่ง Implied Volatility ของสัญญาใกล้ราคาปัจจุบัน',
      chain.provider,
      source.asOf,
    );
  }
  if (!realized || realized.value <= 0) {
    return unavailableSlot(
      'ไม่มีความผันผวนจริงย้อนหลังพอสำหรับเทียบความแพงของค่าพรีเมียม',
      chain.provider,
      source.asOf,
    );
  }
  return {
    status: 'available',
    state: source.state,
    value: {
      basis: 'iv-vs-realized',
      impliedVolatility,
      realizedVolatility: realized.value,
      ratio: impliedVolatility / realized.value,
      observations: realized.observations,
    },
    provider: chain.provider,
    asOf: source.asOf,
  };
}

/**
 * Put/Call positioning, taken from the SAME Options S/R computation the chart
 * already runs on this chain, so open interest is never summed twice.
 */
export function buildSentimentSlot(
  options: OptionsSignalOptionsInputs,
): OptionsSignalInputSlot<SentimentInput> {
  const source = resolveChainSource(options);
  const result = source.result;
  if (!result) return unavailableSlot('ยังไม่ได้โหลดข้อมูล Open Interest ของ options');
  if (result.status === 'unavailable') {
    return unavailableSlot(result.message, result.provider, result.asOf);
  }
  if (result.putCallOIRatio === null || !Number.isFinite(result.putCallOIRatio)) {
    return unavailableSlot('คำนวณ Put/Call Ratio ไม่ได้จาก Open Interest ที่ได้รับ', result.provider, result.asOf);
  }
  // A fallback reading is STALE no matter what status the cached payload froze in.
  const state = source.staleReason !== null || result.dataMode === 'STALE' ? 'STALE' : 'DELAYED';
  return {
    status: 'available',
    state,
    value: {
      putCallRatio: result.putCallOIRatio,
      basis: 'open-interest',
      putTotal: result.totalPutOI,
      callTotal: result.totalCallOI,
      expiration: result.expiration,
    },
    provider: result.provider,
    asOf: source.staleReason !== null ? source.asOf : result.asOf,
  };
}

/** Combine the server context and the browser's options inputs into one engine input. */
export function assembleOptionsSignalInput(
  context: OptionsSignalServerContext,
  options: OptionsSignalOptionsInputs & { acceptedPrice: number | null },
): OptionsSignalInput {
  return {
    symbol: context.symbol,
    timeframe: context.timeframe,
    calculatedAt: context.calculatedAt,
    latestCandleAt: context.latestCandleAt,
    finalizedCandles: context.finalizedCandles,
    macro: context.macro,
    trend: context.trend,
    momentum: context.momentum,
    pricing: buildPricingSlot(options, context.realizedVolatility),
    sentiment: buildSentimentSlot(options),
    riskReward: buildRiskRewardSlot(context.levels, options.acceptedPrice),
    event: context.event,
  };
}
