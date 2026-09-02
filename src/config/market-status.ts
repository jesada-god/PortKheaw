import { MARKET_SIGNAL_PERSISTENCE } from './signal';

/**
 * THE MARKET STATUS RULE TABLE — one file, one config, no second opinion.
 *
 * ===========================================================================
 * WHAT THIS CARD ANSWERS, AND WHAT IT REFUSES TO
 * ===========================================================================
 * "Is the market pushing forward, losing steam, or going nowhere?" — three
 * answers and no fourth. UPTREND / WEAK / SIDEWAYS is the entire output
 * vocabulary.
 *
 * There is a score inside. It exists because six inputs have to be combined
 * somehow and a weighted sum is the most inspectable way to do it. It IS NOT
 * ALLOWED ON SCREEN, and neither is a confidence percentage. A number like
 * "+3.4" or "72%" reads as a measurement of the market when it is really a
 * measurement of this table — every digit of precision is a claim about the
 * weights below, which are judgement calls, not observations. The card prints
 * the six real prices, the three-way label, and a Thai sentence. Nothing else.
 *
 * ===========================================================================
 * WHY EACH INPUT, AND WHICH WAY IT POINTS
 * ===========================================================================
 * Three inputs say what equities are doing; three say what the money around
 * them is doing. `polarity` is the half that is easy to get backwards and
 * expensive to get wrong, so each one carries its reasoning:
 *
 *   SPX/NDX/DJI  +1  the index rising is the market rising. Uncontroversial.
 *
 *   VIX          -1  the "fear index" — the options market's expectation of how
 *                    much the S&P will move. It rises when traders pay up for
 *                    protection, which is what they do when they are worried.
 *                    VIX UP IS BAD NEWS, which is the opposite of every other
 *                    price on this card.
 *
 *   US10Y        -1  the ten-year Treasury yield. Rising yields make the risk-
 *                    free alternative to owning stocks more attractive and raise
 *                    the discount on future earnings. The relationship is real
 *                    but weaker and less reliable than the other five — a yield
 *                    can rise because growth is strong — which is exactly why it
 *                    carries the SMALLEST weight here rather than being dropped.
 *
 *   DXY          -1  the dollar index. A strengthening dollar tightens global
 *                    financial conditions and cuts the dollar value of overseas
 *                    earnings for US multinationals. Risk-off, by convention and
 *                    by correlation.
 *
 * A reading is turned into a contribution by its own `threshold`, which is a
 * dead band, not a trigger: inside it the input contributes nothing at all. That
 * is what stops six instruments each drifting a hundredth of a percent from
 * summing into a "trend".
 */

/** The three-way answer. There is no fourth value and none may be added. */
export type MarketStatusLabel = 'UPTREND' | 'WEAK' | 'SIDEWAYS';

/** The risk backdrop, shown only as this card's subtitle. */
export type MarketRegime = 'RISK_ON' | 'NEUTRAL' | 'RISK_OFF';

export type MarketStatusInputKey = 'SPX' | 'NDX' | 'DJI' | 'VIX' | 'US10Y' | 'DXY';

/**
 * Which group an input belongs to, because the two groups fail differently.
 *
 * Losing an equity index leaves the card unable to say what the market did at
 * all. Losing VIX or the ten-year leaves it able to say that, but unable to say
 * anything about the risk backdrop — so the label survives and the subtitle does
 * not. See `MARKET_STATUS_AVAILABILITY`.
 */
export type MarketStatusInputGroup = 'equity' | 'risk';

export interface MarketStatusInput {
  key: MarketStatusInputKey;
  /**
   * The symbol actually quoted. ALL SIX ARE NOW THE INSTRUMENTS THEMSELVES.
   *
   * The three risk inputs always were: a live probe
   * (`npm run probe:market-status-inputs`) confirmed the provider returns
   * `^VIX`, `^TNX` and `DX-Y.NYB` with plausible values, so no ETF proxy stands
   * in for any of them and no direction has to be inverted to read them.
   *
   * The three equity inputs were SPY, QQQ and DIA — the funds — under labels
   * that named the indices. A card that prints 761.78 under "หุ้นสหรัฐฯ 500 ตัว
   * ใหญ่" is quoting a fund's own order book at a reader who will find 7631.47
   * everywhere else and have no way to tell which figure is wrong. The same
   * probe confirmed `^GSPC`, `^NDX` and `^DJI` come back through the same
   * endpoint with real index levels and a previous close from the completed-
   * daily-candle fallback, so the labels are now true of the numbers under them.
   *
   * Measured over 135 sessions, the index and its fund disagree on the day by a
   * median of 0.02–0.03pp — except on the fund's ex-dividend dates, where SPY
   * printed -0.72% against the index's -0.05%. THAT is the reading this change
   * removes: a distribution is not a market move, and the card was reporting it
   * as one four times a year for SPY and twelve for DIA.
   */
  symbol: string;
  /**
   * The `MARKET_ASSETS` row this input already states, or null.
   *
   * The overview draws two bands: these six, and the asset catalogue under
   * them. Three of the catalogue's rows are the same markets — SPY, QQQ and DIA
   * track the three indices above — so without this the page printed the S&P
   * twice, ten pixels apart, at two different magnitudes.
   *
   * It is a MEANING, not a symbol match, which is exactly why it has to be
   * written down. `SPX` quotes `^GSPC` and covers `SPY`; comparing the two
   * symbols finds nothing in common. The overview reads this to decide which
   * asset rows are still worth drawing — see `assetsOutsideMarketStatus` — so
   * the pairing is stated once here rather than restated as a list in a
   * component that would silently go stale the next time a symbol changes.
   */
  overviewAssetSymbol: string | null;
  group: MarketStatusInputGroup;
  /** Plain Thai, for a reader who does not work on a desk. No ticker. */
  labelTh: string;
  /**
   * Set when `symbol` is a STAND-IN rather than the thing named.
   *
   * Null means the symbol IS the thing, which is now true of all six — the
   * equity rows quote `^GSPC`, `^NDX` and `^DJI` rather than the funds that
   * track them. The field stays because it is the only place the card can admit
   * a substitution, and the day a provider forces one back it must be said on
   * screen rather than recorded in a comment: a reader comparing a fund's price
   * against an index quoted anywhere else finds two figures and no way to tell
   * which is wrong.
   *
   * A non-null value is a CONTRACT WITH THE SCREEN, not a note. Whatever is set
   * here is printed under the label — see `ReadingCell` in
   * `src/components/dashboard/MarketTodaySection.tsx`.
   */
  proxyLabelTh: string | null;
  /**
   * +1 when a rising price is a rising market, -1 when it is the opposite.
   *
   * Getting one of these backwards produces a card that is confidently wrong in
   * the exact conditions it matters most — calling a VIX spike an uptrend — and
   * nothing about the output would look broken. `market-status.polarity.test.ts`
   * pins all six.
   */
  polarity: 1 | -1;
  /**
   * Relative importance in the weighted sum. Unitless; only ratios matter.
   *
   * The S&P leads because it is the broadest. VIX is weighted like a full index
   * because it is the only input that prices expectations rather than reporting
   * them. The ten-year is smallest for the reason given above.
   */
  weight: number;
  /**
   * The dead band, in percent change over the comparison close.
   *
   * Below this an input contributes exactly zero. The bands differ because the
   * instruments do: a 0.15% day on the Dow is nothing, while VIX routinely moves
   * 5% on a quiet afternoon, and using one band for both would make VIX the only
   * input that ever spoke.
   */
  flatBandPercent: number;
  /**
   * Percent change beyond which the input contributes its full weight.
   *
   * Between the two bands the contribution scales linearly. The cap is what
   * stops one instrument having a very bad day from deciding the whole card.
   */
  fullWeightPercent: number;
}

export const MARKET_STATUS_INPUTS: readonly MarketStatusInput[] = [
  {
    key: 'SPX',
    symbol: '^GSPC',
    overviewAssetSymbol: 'SPY',
    group: 'equity',
    labelTh: 'หุ้นสหรัฐฯ 500 ตัวใหญ่',
    proxyLabelTh: null,
    polarity: 1,
    weight: 3,
    flatBandPercent: 0.15,
    fullWeightPercent: 1.5,
  },
  {
    key: 'NDX',
    symbol: '^NDX',
    overviewAssetSymbol: 'QQQ',
    group: 'equity',
    labelTh: 'หุ้นเทคโนโลยี 100 ตัวใหญ่',
    proxyLabelTh: null,
    polarity: 1,
    weight: 2,
    flatBandPercent: 0.15,
    fullWeightPercent: 1.8,
  },
  {
    key: 'DJI',
    symbol: '^DJI',
    overviewAssetSymbol: 'DIA',
    group: 'equity',
    labelTh: 'หุ้นบริษัทขนาดใหญ่ดั้งเดิม',
    proxyLabelTh: null,
    polarity: 1,
    weight: 1,
    flatBandPercent: 0.15,
    fullWeightPercent: 1.5,
  },
  {
    key: 'VIX',
    symbol: '^VIX',
    overviewAssetSymbol: null,
    group: 'risk',
    labelTh: 'ความกังวลของตลาด',
    proxyLabelTh: null,
    polarity: -1,
    weight: 3,
    flatBandPercent: 3,
    fullWeightPercent: 15,
  },
  {
    key: 'US10Y',
    symbol: '^TNX',
    overviewAssetSymbol: null,
    group: 'risk',
    labelTh: 'ผลตอบแทนพันธบัตร 10 ปี',
    proxyLabelTh: null,
    polarity: -1,
    weight: 1,
    flatBandPercent: 1,
    fullWeightPercent: 4,
  },
  {
    key: 'DXY',
    symbol: 'DX-Y.NYB',
    overviewAssetSymbol: null,
    group: 'risk',
    labelTh: 'ค่าเงินดอลลาร์',
    proxyLabelTh: null,
    polarity: -1,
    weight: 2,
    flatBandPercent: 0.3,
    fullWeightPercent: 1.2,
  },
];

export const MARKET_STATUS_TOTAL_WEIGHT = MARKET_STATUS_INPUTS
  .reduce((sum, input) => sum + input.weight, 0);

/**
 * Where the weighted sum turns into one of the three words.
 *
 * Expressed as a FRACTION OF THE WEIGHT ACTUALLY AVAILABLE, never of the full
 * six. That is the whole of the monotonicity guarantee: when an input drops out
 * its weight leaves both the numerator and the denominator, so a missing input
 * cannot push the ratio further from zero than the readings that remain
 * support. Dividing by the fixed total instead would make every absence read as
 * a step toward SIDEWAYS, and dropping the denominator would let three inputs
 * shout as loudly as six.
 *
 * `weakBelow` is negative and `uptrendAbove` positive, with the gap between them
 * being SIDEWAYS. The band is symmetric so nothing is called an uptrend at a
 * strength that would not be called weak in the other direction.
 */
export const MARKET_STATUS_BANDS = {
  uptrendAbove: 0.25,
  weakBelow: -0.25,
} as const;

/**
 * The regime bands, on the RISK INPUTS ALONE.
 *
 * Risk-on/risk-off is a statement about what money is doing around equities, so
 * reading it off the equity indices would make it a restatement of the label
 * above it rather than a second fact. VIX, the ten-year and the dollar are the
 * three that carry it, which is also why the subtitle disappears when they are
 * missing rather than falling back to the equity readings.
 */
export const MARKET_STATUS_REGIME_BANDS = {
  riskOnAbove: 0.3,
  riskOffBelow: -0.3,
} as const;

/**
 * WHAT HAS TO BE PRESENT FOR THE CARD TO SAY ANYTHING.
 *
 * Two separate gates, because the two groups answer different questions and a
 * single "how many are missing" count would conflate them:
 *
 *   * EVERY equity input is required for a status label. They are the only
 *     inputs that report what the market actually did; with one absent the card
 *     is guessing at the headline from a partial tape, and "หุ้นเทคขึ้น" is not
 *     an answer to "what did the market do". One missing → ข้อมูลไม่ครบ.
 *
 *   * VIX AND the ten-year are required for the regime subtitle. Either one
 *     absent and the subtitle is withheld — the label still prints, because the
 *     equity readings that produce it are all present. The dollar is not on this
 *     list: it is the least load-bearing of the three, and losing it degrades the
 *     regime rather than invalidating it.
 *
 * Nothing is inferred from what is left. A card that guessed would be at its
 * least reliable exactly when a provider was having a bad day.
 */
export const MARKET_STATUS_AVAILABILITY = {
  /** Every input in this group must be readable or the card shows ข้อมูลไม่ครบ. */
  requiredForLabel: ['SPX', 'NDX', 'DJI'] satisfies MarketStatusInputKey[] as MarketStatusInputKey[],
  /** All of these must be readable or the regime subtitle is withheld. */
  requiredForRegime: ['VIX', 'US10Y'] satisfies MarketStatusInputKey[] as MarketStatusInputKey[],
} as const;

/**
 * The hold rule, taken from the Market Signal engine rather than re-chosen.
 *
 * Two bars is the same bet the signal card makes and for the same reason, and a
 * card sitting on the same page reaching a different conclusion about how long a
 * reading must stand would be two answers to one question. `heldLabel` in
 * `src/lib/analytics/persistence-hold.ts` is the shared implementation.
 *
 * There is no ATR exemption here. The signal engine's escape hatch is measured
 * against a bar's own ATR, and this card has no candles — it has six quotes. The
 * equivalent judgement lives in `MARKET_STATUS_EXEMPTION_PERCENT` below.
 */
export const MARKET_STATUS_PERSISTENCE = {
  minDurationBars: MARKET_SIGNAL_PERSISTENCE.minDurationBars,
} as const;

/**
 * The day big enough to skip the wait.
 *
 * Holding yesterday's word through a 2% move in the S&P would publish a reading
 * the tape has already contradicted, which is the one case where waiting is
 * clearly the wrong bet. Measured on the broadest equity input alone, so a VIX
 * spike — which is noisy by nature — cannot trigger it on its own.
 */
export const MARKET_STATUS_EXEMPTION_PERCENT = 2;
