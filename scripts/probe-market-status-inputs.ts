/**
 * Market Status card → input source probe.
 *
 * ===========================================================================
 * THE QUESTION THIS ANSWERS
 * ===========================================================================
 * The Market Status card wants six readings: three broad US equity indices,
 * plus VIX, the ten-year yield and the dollar index. The first three are
 * already quoted through `MARKET_ASSETS` as ETF proxies. The other three are
 * not in the product at all, and `PLAN.md` §3 Q2 deferred them with a specific
 * open question attached — whether the provider returns anything usable for
 * them — which nothing has ever run.
 *
 * `toProviderSymbol` passes any symbol it does not recognise straight through
 * to Yahoo, so `^VIX` and `^TNX` MIGHT already work. "Might" is the whole
 * problem: a card built on an assumption about a provider is a card that breaks
 * on the day the assumption is checked. This runs the real pipeline against the
 * live provider and prints what actually comes back.
 *
 * ===========================================================================
 * WHAT IT CHECKS, AND WHY EACH CHECK IS HERE
 * ===========================================================================
 *  1. Does the request succeed at all — the direct index symbol, and the ETF
 *     proxy that would stand in for it if it does not.
 *  2. Is the number PLAUSIBLE. A provider that answers 200 OK with a price of
 *     1.0 for `^TNX` has not given us the ten-year yield, and a probe that only
 *     reported "success" would have recommended shipping it. Each row carries
 *     the range the instrument has actually traded in for years; a value
 *     outside it is reported as IMPLAUSIBLE and treated as a failure.
 *  3. Are the FIELDS the card needs present — `previousClose` above all, which
 *     is what every change figure is measured against and which several
 *     providers stop publishing once their feed goes quiet.
 *
 * Nothing here is mocked and nothing is cached: it is a report about the
 * outside world at the moment it ran.
 *
 * Run: npm run probe:market-status-inputs
 */

import { getYahooChartProvider } from '@/src/lib/market-data/candles';
import { marketSessionDetail } from '@/src/lib/market-data/market-session';

interface Candidate {
  /** What the card wants to know. */
  input: 'VIX' | 'US10Y' | 'DXY';
  /** The instrument itself, asked for by the symbol the provider names it. */
  direct: string;
  /** The US-listed ETF that would stand in for it, and what it actually holds. */
  proxy: string;
  proxyNote: string;
  /**
   * The band the DIRECT instrument has plausibly traded in for years.
   *
   * Deliberately wide — this is a smoke test for "is this the right
   * instrument", not a market view. VIX has printed 9 and it has printed 80;
   * what the band has to catch is a 200 OK carrying a number that could not be
   * this instrument at all.
   */
  plausible: [number, number];
  /** The same for the proxy, which trades at a completely different magnitude. */
  proxyPlausible: [number, number];
}

const CANDIDATES: readonly Candidate[] = [
  {
    input: 'VIX',
    direct: '^VIX',
    proxy: 'VIXY',
    proxyNote: 'holds VIX FUTURES, not the index — it decays in contango and does not track ^VIX levels',
    plausible: [5, 100],
    proxyPlausible: [1, 500],
  },
  {
    input: 'US10Y',
    direct: '^TNX',
    proxy: 'IEF',
    proxyNote: 'a 7-10y Treasury BOND fund — its price moves INVERSELY to yield',
    plausible: [0.3, 12],
    proxyPlausible: [50, 150],
  },
  {
    input: 'DXY',
    direct: 'DX-Y.NYB',
    proxy: 'UUP',
    proxyNote: 'a dollar-index futures fund — same direction as DXY, different scale',
    plausible: [70, 130],
    proxyPlausible: [10, 100],
  },
];

/** The three equity proxies the card already has, probed as the control group. */
const EQUITY_PROXIES = ['SPY', 'QQQ', 'DIA'] as const;

interface Reading {
  symbol: string;
  ok: boolean;
  price: number | null;
  previousClose: number | null;
  currency: string | null;
  latestTradingDay: string | null;
  quoteTimestamp: string | null;
  freshness: string | null;
  plausible: boolean | null;
  missingFields: string[];
  error: string | null;
}

async function read(symbol: string, band: [number, number] | null): Promise<Reading> {
  const base: Reading = {
    symbol,
    ok: false,
    price: null,
    previousClose: null,
    currency: null,
    latestTradingDay: null,
    quoteTimestamp: null,
    freshness: null,
    plausible: null,
    missingFields: [],
    error: null,
  };
  try {
    const result = await getYahooChartProvider().getQuote(symbol);
    const quote = result.data;
    const missing: string[] = [];
    // `previousClose` is listed first because it is the field the card cannot
    // do without: every change figure is the difference against it.
    if (quote.previousClose === null || quote.previousClose === undefined) missing.push('previousClose');
    if (quote.change === null || quote.change === undefined) missing.push('change');
    if (quote.changePercent === null || quote.changePercent === undefined) missing.push('changePercent');
    if (!quote.latestTradingDay) missing.push('latestTradingDay');
    return {
      ...base,
      ok: true,
      price: quote.price,
      previousClose: quote.previousClose ?? null,
      currency: quote.currency ?? null,
      latestTradingDay: quote.latestTradingDay ?? null,
      quoteTimestamp: quote.quoteTimestamp ?? null,
      freshness: result.freshness?.status ?? null,
      plausible: band === null ? null : quote.price >= band[0] && quote.price <= band[1],
      missingFields: missing,
    };
  } catch (error) {
    return {
      ...base,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

function verdict(reading: Reading): string {
  if (!reading.ok) return 'FAIL (request)';
  if (reading.plausible === false) return 'FAIL (implausible value)';
  if (reading.missingFields.includes('previousClose')) return 'PARTIAL (no previousClose)';
  if (reading.missingFields.length > 0) return `PARTIAL (missing ${reading.missingFields.join(', ')})`;
  return 'PASS';
}

function line(reading: Reading, band: [number, number] | null): void {
  const price = reading.price === null ? '—' : String(reading.price);
  const prev = reading.previousClose === null ? '—' : String(reading.previousClose);
  console.log(`  ${reading.symbol.padEnd(11)} ${verdict(reading).padEnd(28)} price=${price.padEnd(12)} prevClose=${prev.padEnd(12)} ${band ? `expected ${band[0]}–${band[1]}` : ''}`);
  if (reading.error) console.log(`    error       : ${reading.error}`);
  if (reading.ok) {
    console.log(`    currency    : ${reading.currency ?? '—'}   tradingDay: ${reading.latestTradingDay ?? '—'}   asOf: ${reading.quoteTimestamp ?? '—'}   freshness: ${reading.freshness ?? '—'}`);
    if (reading.missingFields.length > 0) console.log(`    missing     : ${reading.missingFields.join(', ')}`);
  }
}

async function main(): Promise<void> {
  const now = new Date();
  const detail = marketSessionDetail(now);
  console.log('now (UTC)              :', now.toISOString());
  console.log('now (America/New_York) :', now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  console.log('market session         :', detail.session);
  console.log('last completed session :', detail.lastCompletedSessionDate ?? '—');
  console.log();

  console.log('CONTROL GROUP — the equity proxies the card already quotes');
  console.log('(if these fail, the probe itself is broken, not the candidates)');
  for (const symbol of EQUITY_PROXIES) {
    line(await read(symbol, [10, 2_000]), [10, 2_000]);
  }
  console.log();

  console.log('CANDIDATES — direct instrument first, ETF proxy as the fallback');
  const summary: Array<{ input: string; direct: string; proxy: string; recommend: string }> = [];
  for (const candidate of CANDIDATES) {
    console.log(`\n${candidate.input}`);
    const direct = await read(candidate.direct, candidate.plausible);
    line(direct, candidate.plausible);
    const proxy = await read(candidate.proxy, candidate.proxyPlausible);
    line(proxy, candidate.proxyPlausible);
    console.log(`    proxy note  : ${candidate.proxyNote}`);
    summary.push({
      input: candidate.input,
      direct: verdict(direct),
      proxy: verdict(proxy),
      /*
        The direct instrument wins whenever it is usable, because a proxy is a
        different thing wearing the reading's name — and for two of these three
        the difference is not cosmetic: VIXY holds futures and decays, IEF moves
        the opposite way to the yield it stands for.
      */
      recommend: verdict(direct) === 'PASS'
        ? `USE DIRECT ${candidate.direct}`
        : verdict(proxy) === 'PASS'
          ? `USE PROXY ${candidate.proxy}`
          : 'NO SOURCE',
    });
  }

  console.log('\n\nSUMMARY');
  for (const row of summary) {
    console.log(`  ${row.input.padEnd(7)} direct=${row.direct.padEnd(28)} proxy=${row.proxy.padEnd(28)} → ${row.recommend}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
