/**
 * Audit the support/resistance levels the Options Signal actually reads.
 *
 * A 12.53% downside on a DAILY signal is either a real level or an artefact of
 * looking too far back, and the Risk:Reward factor cannot be tuned until that is
 * settled: a curve fitted to bad geometry is a curve fitted to noise.
 *
 * Reports, and changes nothing:
 *
 *   * how much history the level finder is given, and how it picks a level;
 *   * how far each chosen level sits, in percent AND in ATR AND in units of the
 *     ATM straddle's own expected move;
 *   * how OLD the last confirming touch is, which is the number that says
 *     whether the lookback is too long.
 *
 *   npm run signal:levels
 */

import { calculateSupportResistance } from '@/src/lib/analytics/support-resistance/calculations';
import { DEFAULT_SUPPORT_RESISTANCE_PARAMETERS } from '@/src/lib/analytics/support-resistance/validation';
import { computeOptionsSupportResistance } from '@/src/lib/analytics/options-sr';
import { getOptionsMarketDataService } from '@/src/lib/market-data/options';
import type { OptionsChain } from '@/src/lib/market-data/options/contracts';
import { assembleOptionsSignalInput, atmStraddleExpectedMove, chainDte } from '@/src/lib/analytics/options-signal/assemble';
import { calculateOptionsSignal } from '@/src/lib/analytics/options-signal/calculations';
import { loadOptionsSignalContext } from '@/src/lib/analytics/options-signal/service';
import { finalizedOnly, nearestLevels, type UnderlyingCandle } from '@/src/lib/analytics/options-signal/underlying';
import { getCandleMarketDataService } from '@/src/lib/market-data/candles';

const TICKERS = [
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'AVGO', 'TSLA', 'JPM', 'XOM',
  'RKLB', 'SOFI', 'PLTR', 'ROKU', 'DKNG', 'ENPH', 'CROX', 'RIVN', 'AFRM', 'U',
  'IONQ', 'ACHR', 'JOBY', 'BBAI', 'LUNR', 'RGTI', 'OPEN', 'WULF', 'BTBT', 'SMCI',
];

const round = (value: number, digits = 2) => Number(value.toFixed(digits));

function quantile(values: readonly number[], fraction: number): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

const mean = (values: readonly number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : Number.NaN;

function describe(label: string, values: readonly number[]) {
  return `| ${label} | ${values.length} | ${round(mean(values), 2)} | ${round(quantile(values, 0.5), 2)} `
    + `| ${round(quantile(values, 0.1), 2)} | ${round(quantile(values, 0.9), 2)} | ${round(Math.max(...values), 2)} |`;
}

async function loadCandles(symbol: string): Promise<UnderlyingCandle[]> {
  const result = await getCandleMarketDataService().getCandles({
    symbol, interval: '1D', range: '5y', adjusted: true, session: 'regular',
  });
  return result.data.candles.map((candle) => ({
    date: new Date(candle.timestamp * 1_000).toISOString().slice(0, 10),
    open: candle.open, high: candle.high, low: candle.low, close: candle.close,
    volume: Math.round(candle.volume), finalized: candle.partial !== true,
  }));
}

async function loadChain(symbol: string): Promise<{ chain: OptionsChain; result: ReturnType<typeof computeOptionsSupportResistance> } | null> {
  try {
    const service = getOptionsMarketDataService();
    const expirations = await service.getExpirations(symbol);
    const today = new Date().toISOString().slice(0, 10);
    const nearest = [...new Set(expirations.data.expirations)].filter((value) => value >= today).sort()[0];
    if (!nearest) return null;
    const chain = (await service.getChain(symbol, nearest)).data;
    return {
      chain,
      result: computeOptionsSupportResistance({
        symbol: chain.underlyingSymbol, expiration: chain.expiration, acceptedPrice: chain.spot,
        calls: chain.calls, puts: chain.puts, provider: chain.provider, asOf: chain.asOf, status: chain.status,
      }),
    };
  } catch {
    return null;
  }
}

const daysBetween = (earlier: string, later: string) =>
  Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);

interface Row {
  symbol: string;
  barsFed: number;
  upsidePercent: number | null;
  downsidePercent: number | null;
  upsideAtr: number | null;
  downsideAtr: number | null;
  upsideEm: number | null;
  downsideEm: number | null;
  rrCall: number | null;
  rrPut: number | null;
  supportAgeDays: number | null;
  resistanceAgeDays: number | null;
  supportTouches: number | null;
  resistanceTouches: number | null;
  supportStrength: number | null;
  resistanceStrength: number | null;
  dte: number | null;
}

async function main() {
  console.log('## How the levels are produced\n');
  const parameters = DEFAULT_SUPPORT_RESISTANCE_PARAMETERS;
  console.log('| parameter | value |');
  console.log('| --- | ---: |');
  for (const [key, value] of Object.entries(parameters)) console.log(`| ${key} | ${String(value)} |`);
  console.log('\nStrength = touches x42 + recency x20 + wick x24 + volume x10 + psychological x4,');
  console.log(`kept when >= ${parameters.minimumStrengthScore}. Recency is linear over the WHOLE series fed in.`);
  console.log('The Options Signal then takes the NEAREST qualifying level on each side of the close.\n');

  const rows: Row[] = [];
  const failures: string[] = [];

  for (const symbol of TICKERS) {
    try {
      const [candles, chainInfo, context] = await Promise.all([
        loadCandles(symbol),
        loadChain(symbol),
        loadOptionsSignalContext(symbol),
      ]);
      const finalized = finalizedOnly(candles);
      const close = finalized.at(-1)!.close;
      const latestDate = finalized.at(-1)!.date;

      const sr = calculateSupportResistance(finalized, {
        symbol, source: 'audit', freshness: { status: 'end-of-day', asOf: null, maxAgeSeconds: null }, calculatedAt: new Date().toISOString(),
      });
      const nearest = sr.status === 'available' ? nearestLevels(sr.zones, close) : { support: null, resistance: null };
      const zoneFor = (price: number | null) => sr.status === 'available' && price !== null
        ? sr.zones.find((zone) => zone.midpoint === price) ?? null
        : null;

      const input = assembleOptionsSignalInput(context, {
        chain: chainInfo?.chain ?? null,
        optionsSr: chainInfo?.result ?? null,
        acceptedPrice: chainInfo?.chain.spot ?? null,
        ownHistory: { atmIv: [], putCallRatio: [] },
      });
      const diagnostics = calculateOptionsSignal(input).diagnostics.riskReward;

      const supportZone = zoneFor(nearest.support);
      const resistanceZone = zoneFor(nearest.resistance);
      rows.push({
        symbol,
        barsFed: finalized.length,
        upsidePercent: diagnostics.upsidePercent,
        downsidePercent: diagnostics.downsidePercent,
        upsideAtr: diagnostics.upsideAtr,
        downsideAtr: diagnostics.downsideAtr,
        upsideEm: diagnostics.upsideExpectedMoves,
        downsideEm: diagnostics.downsideExpectedMoves,
        rrCall: diagnostics.callRewardRisk,
        rrPut: diagnostics.putRewardRisk,
        supportAgeDays: supportZone?.latestTouchAt ? daysBetween(supportZone.latestTouchAt, latestDate) : null,
        resistanceAgeDays: resistanceZone?.latestTouchAt ? daysBetween(resistanceZone.latestTouchAt, latestDate) : null,
        supportTouches: supportZone?.touches ?? null,
        resistanceTouches: resistanceZone?.touches ?? null,
        supportStrength: supportZone?.strengthScore ?? null,
        resistanceStrength: resistanceZone?.strengthScore ?? null,
        dte: chainInfo ? chainDte(chainInfo.chain) : null,
      });
      void atmStraddleExpectedMove;
      process.stderr.write('.');
    } catch (error) {
      failures.push(`${symbol}: ${(error as Error).message.slice(0, 70)}`);
      process.stderr.write('x');
    }
  }
  process.stderr.write('\n');

  console.log('## Per symbol\n');
  console.log('| symbol | up % | down % | up ATR | down ATR | rrCall | sup age (d) | sup touches | sup strength | res age (d) | res touches | res strength |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of rows) {
    const cell = (value: number | null) => value === null ? '—' : String(round(value, 2));
    console.log(`| ${row.symbol} | ${cell(row.upsidePercent)} | ${cell(row.downsidePercent)} `
      + `| ${cell(row.upsideAtr)} | ${cell(row.downsideAtr)} | ${cell(row.rrCall)} `
      + `| ${cell(row.supportAgeDays)} | ${cell(row.supportTouches)} | ${cell(row.supportStrength)} `
      + `| ${cell(row.resistanceAgeDays)} | ${cell(row.resistanceTouches)} | ${cell(row.resistanceStrength)} |`);
  }

  /*
   * The cohort that looks like the case this whole rework came from: a call
   * reward:risk under 0.5, i.e. price much nearer its resistance than its
   * support. The baseline test fixture is hand-built and has no symbol behind
   * it, so this is the closest thing to asking "do real charts of that shape sit
   * on stale levels?".
   */
  const lopsided = rows.filter((row) => row.rrCall !== null && row.rrCall < 0.5);
  console.log('\n## Lopsided cohort (rrCall < 0.5) — the shape of the reported case\n');
  console.log('| symbol | rrCall | down % | down ATR | sup age (d) | sup touches | sup strength | res age (d) |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of lopsided) {
    const cell = (value: number | null) => value === null ? '—' : String(round(value, 2));
    console.log(`| ${row.symbol} | ${cell(row.rrCall)} | ${cell(row.downsidePercent)} | ${cell(row.downsideAtr)} `
      + `| ${cell(row.supportAgeDays)} | ${cell(row.supportTouches)} | ${cell(row.supportStrength)} `
      + `| ${cell(row.resistanceAgeDays)} |`);
  }
  const lopsidedStale = lopsided.filter((row) => (row.supportAgeDays ?? 0) > 180 || (row.resistanceAgeDays ?? 0) > 180);
  console.log(`\nof those, using a level older than 180 days: ${lopsidedStale.length}/${lopsided.length}`
    + (lopsidedStale.length ? ` (${lopsidedStale.map((row) => row.symbol).join(', ')})` : ''));

  const usable = <K extends keyof Row>(key: K) =>
    rows.flatMap((row) => typeof row[key] === 'number' && Number.isFinite(row[key]) ? [row[key] as number] : []);

  console.log('\n## Distribution\n');
  console.log('| metric | n | mean | median | p10 | p90 | max |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  console.log(describe('upside %', usable('upsidePercent')));
  console.log(describe('downside %', usable('downsidePercent')));
  console.log(describe('upside ATR', usable('upsideAtr')));
  console.log(describe('downside ATR', usable('downsideAtr')));
  console.log(describe('upside EM', usable('upsideEm')));
  console.log(describe('downside EM', usable('downsideEm')));
  console.log(describe('rrCall', usable('rrCall')));
  console.log(describe('support age (days)', usable('supportAgeDays')));
  console.log(describe('resistance age (days)', usable('resistanceAgeDays')));

  const downsideAtr = usable('downsideAtr');
  const medianDownside = quantile(downsideAtr, 0.5);
  console.log('\n## Verdict\n');
  console.log(`median downside = ${round(medianDownside, 2)} ATR`);
  console.log(medianDownside > 2.5
    ? '=> ABOVE the 2.5 ATR line: the lookback is too long for a 1D signal.'
    : '=> at or below the 2.5 ATR line: the lookback is defensible for a 1D signal.');

  const stale = rows.filter((row) => (row.supportAgeDays ?? 0) > 180 || (row.resistanceAgeDays ?? 0) > 180);
  console.log(`\nlevels whose last confirming touch is over 180 days old: ${stale.length}/${rows.length}`
    + (stale.length ? ` (${stale.map((row) => row.symbol).join(', ')})` : ''));

  if (failures.length) {
    console.log('\n## Failed\n');
    for (const failure of failures) console.log(`  ${failure}`);
  }
}

void main();
