import type { StatusLevel } from '@/src/lib/presentation/status';
import type { MarketIndexCard } from './types';

/**
 * "ตลาดวันนี้" in one line, from the two index proxies the overview already loads.
 *
 * The brief asks a reader to understand the market in five to ten seconds, and
 * four cards in a scroller do not do that — they present the numbers and leave
 * the reading to the reader. This is the reading: which way the two broad US
 * indices went, and whether they agree.
 *
 * TWO INDICES AND NOT FOUR, deliberately. The overview also carries Dow Jones
 * and Russell 2000, and the original brief asked for VIX and US10Y on top. VIX
 * and the ten-year are not in `MARKET_ASSETS` at all and adding them means new
 * instruments, new proxies and a provider probe — Phase 2 work, and PLAN.md
 * records it as such. Dow and Russell are here, but a summary that averages four
 * indices says less than one that reads two: S&P and NASDAQ disagreeing IS the
 * interesting case, and burying it in a four-way average would hide the one
 * sentence worth printing.
 *
 * It computes nothing. Both percentages arrive on the cards the section is
 * already drawing, so this reads two numbers and picks a sentence.
 */

/** The two proxies the summary reads, by the symbol `MARKET_ASSETS` gives them. */
const SP500 = 'SPY';
const NASDAQ = 'QQQ';

/**
 * How far from zero a move has to be before it is a direction rather than noise.
 *
 * A tenth of a percent on the S&P is the index standing still, and calling that
 * "ขึ้น" would put a 🟢 on a flat tape. The band is symmetric, so nothing is
 * described as rising at +0.1% that would not be described as falling at -0.1%.
 */
const FLAT_BAND_PERCENT = 0.1;

export interface MarketSummary {
  level: StatusLevel;
  /** The whole line, ready to print. Never carries a number. */
  text: string;
}

function directionOf(percent: number | null | undefined): 'up' | 'down' | 'flat' | null {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return null;
  if (percent > FLAT_BAND_PERCENT) return 'up';
  if (percent < -FLAT_BAND_PERCENT) return 'down';
  return 'flat';
}

/**
 * The one line above the market cards.
 *
 * Returns `null` — and the section draws no line at all — when neither index
 * could be read. An "ยังไม่มีข้อมูล" banner over a row of cards that are
 * themselves showing their own unavailable states would be the third telling of
 * one fact.
 */
export function buildMarketSummary(indices: readonly MarketIndexCard[]): MarketSummary | null {
  const find = (symbol: string) => indices.find((item) => item.symbol === symbol);
  const sp = directionOf(find(SP500)?.changePercent);
  const nasdaq = directionOf(find(NASDAQ)?.changePercent);

  if (sp === null && nasdaq === null) return null;

  /*
   * One index readable and the other not. Said as the one index rather than as
   * a market-wide claim: "ตลาดขึ้น" on the strength of a single proxy is a
   * bigger statement than the data behind it.
   */
  if (sp === null || nasdaq === null) {
    const only = sp ?? nasdaq!;
    const name = sp === null ? 'NASDAQ' : 'S&P 500';
    if (only === 'up') return { level: 'good', text: `${name} ขึ้น · อีกดัชนียังไม่มีข้อมูล` };
    if (only === 'down') return { level: 'bad', text: `${name} ลง · อีกดัชนียังไม่มีข้อมูล` };
    return { level: 'neutral', text: `${name} ทรงตัว · อีกดัชนียังไม่มีข้อมูล` };
  }

  if (sp === 'up' && nasdaq === 'up') {
    return { level: 'good', text: 'ทั้ง S&P 500 และ NASDAQ ขึ้น' };
  }
  if (sp === 'down' && nasdaq === 'down') {
    return { level: 'bad', text: 'ทั้ง S&P 500 และ NASDAQ ลง' };
  }
  if (sp === 'flat' && nasdaq === 'flat') {
    return { level: 'neutral', text: 'ทั้งสองดัชนีทรงตัว' };
  }
  /*
   * Everything left is a disagreement, including the one-flat-one-moving cases.
   * 🟠 rather than 🟡: two broad indices pulling apart is the day a reader most
   * needs to look closer at, and it must not wear the same mark as a quiet one.
   */
  const parts = [
    `S&P 500 ${sp === 'up' ? 'ขึ้น' : sp === 'down' ? 'ลง' : 'ทรงตัว'}`,
    `NASDAQ ${nasdaq === 'up' ? 'ขึ้น' : nasdaq === 'down' ? 'ลง' : 'ทรงตัว'}`,
  ];
  return { level: 'weak', text: `${parts.join(' · ')} — สองดัชนีไปคนละทาง` };
}
