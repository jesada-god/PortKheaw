import type { OptionContract, OptionsChain } from '@/src/lib/market-data/options/contracts';
import { optionIntrinsicValue, optionMarketQuote } from '@/src/lib/market-data/quote-model';

/**
 * Pure presentation model for the Options Chain panel.
 *
 * Nothing here invents a value: every field either comes from the provider's
 * contract or is derived by an existing, already-tested calculation
 * (`optionMarketQuote`, `optionIntrinsicValue`). A field the provider did not
 * supply renders as {@link UNAVAILABLE} — never as 0, never as a guess.
 *
 * The virtual-window helper lives here too because the chain rows are
 * variable-height: a fixed row height was what made the old table overlap its
 * own content. Heights are measured by the component and fed back in, so the
 * math stays pure and testable.
 */

/** The single glyph the whole panel uses for "the provider did not supply this". */
export const UNAVAILABLE = '—';

export interface StrikeRow {
  strike: number;
  call: OptionContract | null;
  put: OptionContract | null;
}

export type Moneyness = 'ITM' | 'ATM' | 'OTM';

/** Half-width of the ATM band, as a fraction of spot. Unchanged from the original panel. */
export const ATM_BAND = 0.0025;

export function formatNumber(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? UNAVAILABLE
    : value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

export function formatMoney(value: number | null | undefined, digits = 2): string {
  const formatted = formatNumber(value, digits);
  return formatted === UNAVAILABLE ? UNAVAILABLE : `$${formatted}`;
}

export function formatPercent(fraction: number | null | undefined, digits = 2): string {
  const formatted = formatNumber(fraction === null || fraction === undefined ? null : fraction * 100, digits);
  return formatted === UNAVAILABLE ? UNAVAILABLE : `${formatted}%`;
}

/** ATM inside the band, otherwise the provider's own ITM flag when it supplied one. */
export function moneyness(contract: OptionContract, spot: number): Moneyness {
  if (!Number.isFinite(spot) || spot <= 0) return 'OTM';
  if (Math.abs(contract.strike - spot) / spot <= ATM_BAND) return 'ATM';
  const inTheMoney = contract.type === 'call' ? spot > contract.strike : spot < contract.strike;
  return inTheMoney ? 'ITM' : 'OTM';
}

export function isAtmStrike(strike: number, spot: number): boolean {
  return Number.isFinite(spot) && spot > 0 && Math.abs(strike - spot) / spot <= ATM_BAND;
}

export function isOutsideExpectedMove(
  strike: number,
  expectedMove: { lower: number | null; upper: number | null } | null | undefined,
): boolean {
  const lower = expectedMove?.lower;
  const upper = expectedMove?.upper;
  if (lower === null || lower === undefined || upper === null || upper === undefined) return false;
  return strike < lower || strike > upper;
}

/** Groups the chain into one row per strike, keeping only strikes inside ±`rangePercent` of spot. */
export function buildStrikeRows(chain: OptionsChain, rangePercent: number): StrikeRow[] {
  const lower = chain.spot * (1 - rangePercent / 100);
  const upper = chain.spot * (1 + rangePercent / 100);
  const byStrike = new Map<number, StrikeRow>();
  for (const contract of [...chain.calls, ...chain.puts]) {
    if (contract.strike < lower || contract.strike > upper) continue;
    const row = byStrike.get(contract.strike) ?? { strike: contract.strike, call: null, put: null };
    row[contract.type] = contract;
    byStrike.set(contract.strike, row);
  }
  return [...byStrike.values()].sort((left, right) => left.strike - right.strike);
}

export interface OptionMetric {
  key: string;
  label: string;
  value: string;
  /** Native tooltip, so a beginner can decode the abbreviation without extra chrome. */
  title: string;
}

/** Bid / Ask / Mid / Last — the price block. */
export function priceMetrics(contract: OptionContract): OptionMetric[] {
  const quote = optionMarketQuote(contract);
  return [
    { key: 'bid', label: 'Bid', value: formatNumber(quote.bid), title: 'Bid · ราคาเสนอซื้อที่ดีที่สุด' },
    { key: 'ask', label: 'Ask', value: formatNumber(quote.ask), title: 'Ask · ราคาเสนอขายที่ดีที่สุด' },
    { key: 'mid', label: 'Mid', value: formatNumber(quote.midpoint), title: 'Midpoint · กึ่งกลางระหว่าง Bid และ Ask' },
    { key: 'last', label: 'Last', value: formatNumber(quote.last), title: 'Last · ราคาซื้อขายล่าสุด' },
  ];
}

/** Vol / OI / IV / Int — the activity block. */
export function activityMetrics(contract: OptionContract, spot: number): OptionMetric[] {
  const quote = optionMarketQuote(contract);
  const intrinsic = Number.isFinite(spot) && spot > 0 ? optionIntrinsicValue(contract, spot) : null;
  return [
    { key: 'volume', label: 'Vol', value: formatNumber(quote.volume, 0), title: 'Volume · จำนวนสัญญาที่ซื้อขายวันนี้' },
    { key: 'openInterest', label: 'OI', value: formatNumber(quote.openInterest, 0), title: 'Open Interest · สัญญาคงค้าง' },
    { key: 'impliedVolatility', label: 'IV', value: formatPercent(quote.impliedVolatility), title: 'Implied Volatility · ความผันผวนแฝง' },
    { key: 'intrinsic', label: 'Int', value: formatNumber(intrinsic), title: 'Intrinsic value · มูลค่าที่แท้จริงเมื่อใช้สิทธิ' },
  ];
}

/** Δ / Γ / Θ — always rendered, so a missing Greek reads as "—" instead of vanishing. */
export function greekMetrics(contract: OptionContract): OptionMetric[] {
  return [
    { key: 'delta', label: 'Δ', value: formatNumber(contract.delta, 4), title: 'Delta · ราคาออปชันเปลี่ยนเท่าไรเมื่อหุ้นขยับ $1' },
    { key: 'gamma', label: 'Γ', value: formatNumber(contract.gamma, 4), title: 'Gamma · Delta เปลี่ยนเร็วแค่ไหน' },
    { key: 'theta', label: 'Θ', value: formatNumber(contract.theta, 4), title: 'Theta · มูลค่าที่หายไปต่อวันจากเวลา' },
  ];
}

export function hasAnyGreek(contract: OptionContract): boolean {
  return [contract.delta, contract.gamma, contract.theta, contract.vega, contract.rho]
    .some((value) => value !== null && Number.isFinite(value));
}

/**
 * A contract symbol can be 20+ characters (OCC format). It is never shortened by
 * dropping characters — the full string stays in `title` and the DOM, and CSS
 * truncates it — so copy/paste and assistive tech still see the real identifier.
 */
export function contractSymbolLabel(contract: OptionContract): string {
  return contract.contractSymbol;
}

/* ------------------------------------------------------------------ */
/* Variable-height virtual window                                      */
/* ------------------------------------------------------------------ */

export interface VirtualWindow {
  /** First rendered row index (inclusive). */
  start: number;
  /** Last rendered row index (exclusive). */
  end: number;
  /** Spacer above the rendered rows, in px. */
  padTop: number;
  /** Spacer below the rendered rows, in px. */
  padBottom: number;
  /** Full scrollable height, in px. */
  totalHeight: number;
}

export interface VirtualWindowInput {
  count: number;
  scrollTop: number;
  viewportHeight: number;
  /** Rows rendered beyond each edge of the viewport. */
  overscan: number;
  /** Height used for rows that have not been measured yet. */
  estimate: number;
  /** Measured heights by row index. Missing entries fall back to `estimate`. */
  heights: ReadonlyMap<number, number>;
}

/**
 * Windows a variable-height list. Rows keep their natural height — the window is
 * computed from measured heights instead of forcing every row into one constant,
 * which is exactly the defect that made cells overlap.
 */
export function computeVirtualWindow({
  count,
  scrollTop,
  viewportHeight,
  overscan,
  estimate,
  heights,
}: VirtualWindowInput): VirtualWindow {
  if (count <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0, totalHeight: 0 };

  const safeEstimate = Number.isFinite(estimate) && estimate > 0 ? estimate : 1;
  const offsets: number[] = new Array(count + 1);
  offsets[0] = 0;
  for (let index = 0; index < count; index += 1) {
    const measured = heights.get(index);
    const height = measured !== undefined && Number.isFinite(measured) && measured > 0 ? measured : safeEstimate;
    offsets[index + 1] = offsets[index] + height;
  }
  const totalHeight = offsets[count];

  const top = Math.max(0, Math.min(scrollTop, totalHeight));
  const bottom = Math.min(totalHeight, top + Math.max(0, viewportHeight));

  let first = 0;
  while (first < count - 1 && offsets[first + 1] <= top) first += 1;
  let last = first;
  while (last < count && offsets[last] < bottom) last += 1;

  const start = Math.max(0, first - overscan);
  const end = Math.min(count, Math.max(last + overscan, start + 1));
  return {
    start,
    end,
    padTop: offsets[start],
    padBottom: totalHeight - offsets[end],
    totalHeight,
  };
}
