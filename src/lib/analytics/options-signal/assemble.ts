import { calculateAtmIv } from '@/src/lib/market-data/options/analytics';
import type { OptionContract, OptionsChain } from '@/src/lib/market-data/options/contracts';
import type { OptionsSrResult } from '@/src/lib/analytics/options-sr/types';
import { classifyUsEquitySession } from '@/src/lib/market-data/session';
import { isUsTradingDay } from '@/src/lib/market-data/us-market-calendar';
import { OPTIONS_SIGNAL_CONFIG } from './config';
import { percentileRank } from './indicators';
import type { RealizedVolatilityWindows } from './underlying';
import type {
  EventRiskInput,
  IvPercentilePending,
  IvPricingInput,
  LiquidityInput,
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
  /**
   * The same measurement over several windows, so a short-dated contract is
   * compared against short-dated realized volatility. Optional so an older
   * caller that only has the 1-year figure keeps working.
   */
  realizedVolatilityWindows?: RealizedVolatilityWindows;
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

/**
 * This symbol's own recorded readings, newest-last.
 *
 * A raw IV of 38% or a raw Put/Call of 1.51 says nothing on its own — both are
 * routine on one ticker and an outlier on another. These series are what make
 * them comparable, and they are supplied by the caller (from the signal history)
 * rather than invented here.
 */
export interface OptionsSignalOwnHistory {
  /** Daily ATM implied volatility readings, as decimals. */
  atmIv?: readonly number[];
  /** Daily Put/Call open-interest ratios. */
  putCallRatio?: readonly number[];
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
   * the percentile basis, then to the labelled IV-vs-realized basis.
   */
  ivRank?: { ivRank: number; observations: number };
  /** Recorded readings for this symbol, used for the two percentile bases. */
  ownHistory?: OptionsSignalOwnHistory;
  /**
   * The chain the EXPECTED MOVE is read from, when it is not the nearest one.
   *
   * Every other options-derived factor belongs on the front chain — that is the
   * book whose liquidity, positioning and implied volatility a reader is looking
   * at. The expected move does not: it is the yardstick the confirmed daily
   * support and resistance are measured against, and those are swing levels the
   * card's own SETUP section recommends a 30-60 day contract for. Measuring them
   * against a 0-DTE straddle made "this level is further than the option can
   * reach" fire on 24 of 30 regression tickers; at 30 days it fires on 3.
   *
   * Optional, and falling back to the nearest chain, so a caller that cannot
   * resolve a second expiration degrades to the old behaviour rather than losing
   * the expected move altogether.
   */
  expectedMoveChain?: OptionsChain | null;
  /**
   * The expected move ALREADY DERIVED, when the caller has it without a chain.
   *
   * Two numbers — the ATM straddle price and the DTE it was read at — are the
   * entire contribution of a second chain fetch that otherwise costs a full
   * options snapshot per card. A caller that can serve those two from its own
   * cache passes them here and skips the fetch; the arithmetic downstream is
   * identical either way, because this is exactly what
   * {@link atmStraddleExpectedMove} and {@link chainDte} would have returned.
   *
   * Takes precedence over `expectedMoveChain` when both are supplied.
   */
  expectedMove?: { move: number | null; dte: number | null } | null;
  /**
   * The horizon chain's ATM implied volatility, when the caller has it without
   * a chain — the third number that survives the same fetch as
   * {@link OptionsSignalOptionsInputs.expectedMove}.
   *
   * IV BELONGS ON THE HORIZON CHAIN TOO, and it used to be the one options
   * factor left behind on the front one. The front expiration was two days out
   * on RKLB and priced at 103.4% — a number that is almost entirely the earnings
   * report eight days later, which that contract does not live to see and cannot
   * amortise. The card then compared it against 20-day realized volatility and
   * printed "premium is cheap", while the setup section beside it recommended a
   * 30-60 day contract and the expected move above it was already read at 44
   * days. Three horizons, one paragraph.
   *
   * Unlike liquidity and positioning — which are facts ABOUT the book a reader
   * is looking at, and stay on the front chain — the pricing verdict is a
   * comparison, and a comparison is only worth as much as its two sides sharing
   * a horizon.
   *
   * Takes precedence over the IV of `expectedMoveChain`, which takes precedence
   * over the front chain's. A null or non-positive reading falls back to the
   * front chain rather than losing the factor, and the DTE published alongside
   * says which one was used.
   */
  horizonIv?: { iv: number | null; dte: number | null; asOf?: string | null } | null;
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

const finite = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function median(values: readonly number[]): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function calendarDaysBetween(startDate: string, endDate: string): number | null {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

/** Days to expiration for the chain the options factors were read from. */
export function chainDte(chain: OptionsChain): number | null {
  return calendarDaysBetween(chain.asOf.slice(0, 10), chain.expiration);
}

/**
 * Was the US regular session open at the instant this chain was captured?
 *
 * Both halves matter and neither is enough alone: `classifyUsEquitySession`
 * knows the clock and the weekend but not the holiday calendar, and
 * `isUsTradingDay` knows the holiday calendar but not the hour. A quote taken at
 * 11:00 on Thanksgiving is an after-hours quote in every way that affects a
 * bid-ask spread.
 *
 * `null` when the timestamp cannot be parsed, which stays distinct from `false`:
 * "we do not know when this was quoted" is not "we know the market was shut".
 */
export function marketOpenAt(timestamp: string | null | undefined): boolean | null {
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return null;
  const session = classifyUsEquitySession(timestamp);
  if (session === null) return false;
  return session === 'regular' && isUsTradingDay(timestamp.slice(0, 10));
}

/**
 * Expected move from the real ATM STRADDLE, not from a volatility formula.
 *
 * The straddle is what the market is actually charging for the move to this
 * expiration, so when both ATM legs carry a usable price this is the honest
 * number. It returns `null` rather than substituting a model when they do not.
 */
export function atmStraddleExpectedMove(chain: OptionsChain): number | null {
  const priceOf = (contract: OptionContract): number | null => {
    const mark = finite(contract.mark);
    if (mark !== null && mark > 0) return mark;
    const bid = finite(contract.bid);
    const ask = finite(contract.ask);
    if (bid !== null && ask !== null && ask > 0) return (bid + ask) / 2;
    const last = finite(contract.last);
    return last !== null && last > 0 ? last : null;
  };
  const nearest = (contracts: readonly OptionContract[]) => contracts
    .filter((contract) => contract.expiration === chain.expiration && priceOf(contract) !== null)
    .sort((left, right) => Math.abs(left.strike - chain.spot) - Math.abs(right.strike - chain.spot))[0] ?? null;

  const call = nearest(chain.calls);
  const put = nearest(chain.puts);
  if (!call || !put) return null;
  // Both legs must be struck at the same place, or the sum is not a straddle.
  if (Math.abs(call.strike - put.strike) > Number.EPSILON) return null;
  const move = (priceOf(call) as number) + (priceOf(put) as number);
  return move > 0 ? move : null;
}

/**
 * Risk/Reward anchored to the single accepted underlying price the header and
 * chart already display, using the confirmed daily zones from the server, and
 * carrying the two yardsticks a bare percentage cannot supply: the underlying's
 * own ATR, and what the option market is charging for the move.
 */
export function buildRiskRewardSlot(
  levels: OptionsSignalInputSlot<PriceLevelsInput>,
  acceptedPrice: number | null,
  expectedMove: number | null = null,
  expectedMoveDte: number | null = null,
): OptionsSignalInputSlot<RiskRewardInput> {
  if (levels.status === 'unavailable') return levels as OptionsSignalInputSlot<RiskRewardInput>;
  const accepted = finite(acceptedPrice);
  const price = accepted !== null && accepted > 0 ? accepted : levels.value.close;
  return {
    status: 'available',
    state: levels.state,
    value: {
      price,
      support: levels.value.support,
      resistance: levels.value.resistance,
      atr: levels.value.atr ?? null,
      expectedMove,
      expectedMoveDte,
    },
    provider: levels.provider,
    asOf: levels.asOf,
  };
}

/** Which realized-volatility window a contract of this DTE should be judged against. */
export function realizedWindowForDte(
  dte: number | null,
  windows: RealizedVolatilityWindows | undefined,
  fallback: { value: number; observations: number } | null,
  config = OPTIONS_SIGNAL_CONFIG.iv,
): { value: number; observations: number; windowDays: number } | null {
  const long = windows?.long ?? fallback;
  const pick = (
    measurement: { value: number; observations: number } | null | undefined,
    windowDays: number,
  ) => (measurement && measurement.value > 0 ? { ...measurement, windowDays } : null);

  if (dte !== null && dte < config.shortDatedDteThreshold) {
    const short = dte <= config.nearWindowDteThreshold
      ? pick(windows?.near, config.shortWindows.near) ?? pick(windows?.far, config.shortWindows.far)
      : pick(windows?.far, config.shortWindows.far) ?? pick(windows?.near, config.shortWindows.near);
    if (short) return short;
  }
  return pick(long, config.realizedWindowDays);
}

/** How far this symbol still is from having a publishable IV percentile. */
export function ivPercentilePendingOf(
  history: readonly number[] | undefined,
  config = OPTIONS_SIGNAL_CONFIG.iv,
): IvPercentilePending | null {
  const observations = (history ?? []).filter((value) => Number.isFinite(value)).length;
  if (observations >= config.minimumPercentileObservations) return null;
  return {
    observations,
    required: config.minimumPercentileObservations,
    missingDays: config.minimumPercentileObservations - observations,
  };
}

/**
 * Which chain the implied volatility is READ FROM, and the horizon it was read
 * at, in one place so the two can never be published apart.
 *
 * Order, and every step of it is a fallback rather than a preference:
 *
 *   1. a horizon reading the caller already has (`horizonIv`), which costs
 *      nothing — it is the third number off the same fetch the expected move is
 *      cached from;
 *   2. the horizon CHAIN, when the caller passed one instead;
 *   3. the front chain, which is where this used to live unconditionally.
 *
 * A horizon reading that is missing, zero or negative does not sink the factor:
 * it falls through to the front chain, and the `dte` returned here is what says
 * which one a reader is looking at. That distinction has to reach the card,
 * because "IV 103.4% over two days" and "IV 68.1% over forty-four" are not the
 * same claim about the same stock, and only one of them is on the horizon the
 * rest of the card is written for.
 */
function resolveIvReading(
  options: OptionsSignalOptionsInputs,
  front: OptionsChain | null,
): { iv: number | null; dte: number | null; asOf: string | null; horizon: boolean; reason: string | null } {
  const usable = (value: number | null | undefined): number | null => {
    const number = finite(value ?? null);
    return number !== null && number > 0 ? number : null;
  };

  const preDerived = usable(options.horizonIv?.iv);
  if (preDerived !== null) {
    return {
      iv: preDerived,
      dte: options.horizonIv?.dte ?? null,
      /*
       * The horizon chain's OWN capture time, not the front chain's. It is
       * served from a fifteen-minute cache, so a card that stamped it with the
       * front chain's timestamp would print a fetch time up to fifteen minutes
       * newer than the number underneath it.
       */
      asOf: options.horizonIv?.asOf ?? null,
      horizon: true,
      reason: null,
    };
  }

  const horizonChain = options.expectedMoveChain;
  if (horizonChain) {
    const atm = calculateAtmIv(horizonChain);
    const iv = atm.status === 'available' ? usable(atm.iv) : null;
    if (iv !== null) {
      return { iv, dte: chainDte(horizonChain), asOf: horizonChain.asOf, horizon: true, reason: null };
    }
  }

  const atm = front ? calculateAtmIv(front) : null;
  return {
    iv: atm?.status === 'available' ? usable(atm.iv) : null,
    dte: front ? chainDte(front) : null,
    asOf: null,
    horizon: false,
    reason: atm?.status === 'unavailable' ? atm.reason ?? null : null,
  };
}

/**
 * Options pricing richness from real numbers only.
 *
 * IV Rank is preferred but needs a historical IV series no entitled provider
 * offers. Next is this symbol's OWN IV percentile, which fills itself in one
 * reading at a time — until it does, the card is told how many days are still
 * missing rather than being shown a flat "unavailable". The last basis compares
 * today's real ATM implied volatility with the underlying's own realized
 * volatility over a window matched to the contract's DTE, and is always
 * labelled with the basis and the window it used.
 */
export function buildPricingSlot(
  options: OptionsSignalOptionsInputs,
  realized: { value: number; observations: number } | null,
  windows?: RealizedVolatilityWindows,
): OptionsSignalInputSlot<IvPricingInput> {
  const source = resolveChainSource(options);
  const chain = source.chain;
  const reading = resolveIvReading(options, chain);
  const impliedVolatility = reading.iv;
  const dte = reading.dte;
  /*
   * The IV's own capture time when it came off the horizon chain, the front
   * chain's when it did not. This is what the card prints under "ดึงข้อมูลเมื่อ"
   * for this factor, and a timestamp belonging to a different fetch is a wrong
   * one however small the difference.
   */
  const asOf = reading.asOf ?? source.asOf;

  if (options.ivRank) {
    return {
      status: 'available',
      state: source.state ?? 'DELAYED',
      value: {
        basis: 'iv-rank',
        ivRank: options.ivRank.ivRank,
        impliedVolatility,
        observations: options.ivRank.observations,
        dte,
      },
      provider: chain?.provider ?? null,
      asOf,
    };
  }

  if (!chain || source.state === null) return unavailableSlot('ยังไม่ได้โหลด options chain');
  if (impliedVolatility === null || impliedVolatility <= 0) {
    return unavailableSlot(
      reading.reason ?? 'ผู้ให้บริการไม่ได้ส่ง Implied Volatility ของสัญญาใกล้ราคาปัจจุบัน',
      chain.provider,
      asOf,
    );
  }

  const ivConfig = OPTIONS_SIGNAL_CONFIG.iv;
  const ranked = percentileRank(
    impliedVolatility,
    options.ownHistory?.atmIv ?? [],
    ivConfig.minimumPercentileObservations,
  );
  if (ranked) {
    return {
      status: 'available',
      state: source.state,
      value: {
        basis: 'iv-percentile',
        ivPercentile: ranked.percentile * 100,
        impliedVolatility,
        observations: ranked.observations,
        dte,
      },
      provider: chain.provider,
      asOf,
    };
  }

  const window = realizedWindowForDte(dte, windows, realized);
  if (!window) {
    return unavailableSlot(
      'ไม่มีความผันผวนจริงย้อนหลังพอสำหรับเทียบความแพงของค่าพรีเมียม',
      chain.provider,
      asOf,
    );
  }
  return {
    status: 'available',
    state: source.state,
    value: {
      basis: 'iv-vs-realized',
      impliedVolatility,
      realizedVolatility: window.value,
      ratio: impliedVolatility / window.value,
      observations: window.observations,
      realizedWindowDays: window.windowDays,
      dte,
    },
    provider: chain.provider,
    asOf,
  };
}

/** Put/Call by traded VOLUME on the same chain, when the provider sent volume. */
export function putCallVolumeRatio(chain: OptionsChain | null): number | null {
  if (!chain) return null;
  const total = (contracts: readonly OptionContract[]) => contracts
    .filter((contract) => contract.expiration === chain.expiration && finite(contract.volume) !== null)
    .reduce((sum, contract) => sum + (contract.volume as number), 0);
  const calls = total(chain.calls);
  const puts = total(chain.puts);
  if (calls <= 0) return null;
  return puts / calls;
}

/**
 * Put/Call positioning, taken from the SAME Options S/R computation the chart
 * already runs on this chain, so open interest is never summed twice — plus the
 * two things that make the number mean something: today's traded volume ratio,
 * and where the reading sits inside this symbol's own recent history.
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
  const ranked = percentileRank(
    result.putCallOIRatio,
    options.ownHistory?.putCallRatio ?? [],
    OPTIONS_SIGNAL_CONFIG.sentiment.minimumPercentileObservations,
  );
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
      volumeRatio: putCallVolumeRatio(source.chain),
      ownPercentile: ranked?.percentile ?? null,
      percentileObservations: ranked?.observations
        ?? (options.ownHistory?.putCallRatio ?? []).filter((value) => Number.isFinite(value)).length,
    },
    provider: result.provider,
    asOf: source.staleReason !== null ? source.asOf : result.asOf,
  };
}

/**
 * How tradeable this chain actually is.
 *
 * Judged only on the strikes near the money, because every chain's wings are
 * thin and grading a chain on them would fail every symbol equally. Medians, not
 * means, so one 5,000-lot strike cannot carry an otherwise empty board.
 */
export function buildLiquiditySlot(
  options: OptionsSignalOptionsInputs,
  config = OPTIONS_SIGNAL_CONFIG.liquidity,
): OptionsSignalInputSlot<LiquidityInput> {
  const source = resolveChainSource(options);
  const chain = source.chain;
  if (!chain || source.state === null) return unavailableSlot('ยังไม่ได้โหลด options chain จึงยังประเมินสภาพคล่องไม่ได้');

  const window = chain.spot * config.atmWindowPercent / 100;
  const nearAtm = [...chain.calls, ...chain.puts].filter((contract) => (
    contract.expiration === chain.expiration && Math.abs(contract.strike - chain.spot) <= window
  ));
  if (!nearAtm.length) {
    return unavailableSlot(
      `ไม่มีสัญญาในช่วง ±${config.atmWindowPercent}% ของราคาปัจจุบันให้ประเมิน`,
      chain.provider,
      source.asOf,
    );
  }

  const openInterests = nearAtm.flatMap((contract) => finite(contract.openInterest) === null ? [] : [contract.openInterest as number]);
  const volumes = nearAtm.flatMap((contract) => finite(contract.volume) === null ? [] : [contract.volume as number]);
  const spreads = nearAtm.flatMap((contract) => {
    const bid = finite(contract.bid);
    const ask = finite(contract.ask);
    if (bid === null || ask === null) return [];
    const mid = (bid + ask) / 2;
    return mid > 0 ? [(ask - bid) / mid * 100] : [];
  });

  return {
    status: 'available',
    state: source.state,
    value: {
      medianOpenInterest: median(openInterests),
      medianVolume: median(volumes),
      medianSpreadPercent: median(spreads),
      contractsExamined: nearAtm.length,
      expiration: chain.expiration,
      /*
       * Recorded at CAPTURE time, not read time. A chain fetched at the close
       * and served from cache an hour later was still quoted while the book was
       * open, and the spread in it is still a real cost.
       */
      marketOpenAtCapture: marketOpenAt(source.asOf ?? chain.asOf),
    },
    provider: chain.provider,
    asOf: source.asOf,
  };
}

/** Combine the server context and the browser's options inputs into one engine input. */
export function assembleOptionsSignalInput(
  context: OptionsSignalServerContext,
  options: OptionsSignalOptionsInputs & { acceptedPrice: number | null },
): OptionsSignalInput {
  const source = resolveChainSource(options);
  /*
   * The horizon chain when one was resolved, the front chain otherwise. The DTE
   * that was actually read is published beside the number either way, so the
   * card never implies a horizon it did not measure.
   */
  const expectedMoveSource = options.expectedMoveChain ?? source.chain;
  /*
   * A caller that already holds the two numbers is believed; otherwise they are
   * derived here from whichever chain resolved above. Same arithmetic, one
   * fewer provider request.
   */
  const expectedMove = options.expectedMove
    ?? (expectedMoveSource
      ? { move: atmStraddleExpectedMove(expectedMoveSource), dte: chainDte(expectedMoveSource) }
      : { move: null, dte: null });
  return {
    symbol: context.symbol,
    timeframe: context.timeframe,
    calculatedAt: context.calculatedAt,
    latestCandleAt: context.latestCandleAt,
    finalizedCandles: context.finalizedCandles,
    macro: context.macro,
    trend: context.trend,
    momentum: context.momentum,
    pricing: buildPricingSlot(options, context.realizedVolatility, context.realizedVolatilityWindows),
    sentiment: buildSentimentSlot(options),
    riskReward: buildRiskRewardSlot(
      context.levels,
      options.acceptedPrice,
      expectedMove.move,
      expectedMove.dte,
    ),
    event: context.event,
    liquidity: buildLiquiditySlot(options),
    ivPercentilePending: ivPercentilePendingOf(options.ownHistory?.atmIv),
  };
}
