/**
 * What moving the implied volatility onto the horizon chain actually does, over
 * thirty real symbols, on one snapshot of the tape.
 *
 * The card used to read every options factor off the FRONT expiration. For
 * liquidity and positioning that is right: they are facts about the book a
 * reader is looking at. For the pricing verdict it is not, because the pricing
 * verdict is a COMPARISON — implied against realized, and against the 30-60 day
 * contract the card's own setup section recommends — and both sides of a
 * comparison have to be on one horizon.
 *
 * On RKLB the front chain was two days out and printed 103.4%. Almost all of
 * that is an earnings report eight days later: a report that contract does not
 * live to see and therefore never amortises. Divided by twenty-day realized
 * volatility, the card called the premium cheap, one paragraph above a setup
 * section recommending thirty to sixty days and an expected move already read at
 * forty-four.
 *
 * BOTH READINGS COME OFF ONE FETCH. The front chain and the horizon chain are
 * pulled once per symbol and the pricing slot is built twice from them — front
 * IV, then horizon IV — so the before and the after are the same market minute.
 * Running the probe twice, once per revision, would have compared two different
 * afternoons and called the difference a model change.
 *
 * It CHANGES NO THRESHOLD. It reports: the ratio per symbol, how many symbols
 * cross a richness band, and what that does to the published label. Any retune
 * that follows is a separate, deliberate decision.
 *
 *   npm run signal:iv-horizon
 */

import { computeOptionsSupportResistance, type OptionsSrResult } from '@/src/lib/analytics/options-sr';
import { getOptionsMarketDataService } from '@/src/lib/market-data/options';
import { calculateAtmIv } from '@/src/lib/market-data/options/analytics';
import type { OptionsChain } from '@/src/lib/market-data/options/contracts';
import {
  assembleOptionsSignalInput,
  atmStraddleExpectedMove,
  chainDte,
} from '@/src/lib/analytics/options-signal/assemble';
import { calculateOptionsSignal } from '@/src/lib/analytics/options-signal/calculations';
import { OPTIONS_SIGNAL_CONFIG } from '@/src/lib/analytics/options-signal/config';
import { loadOptionsSignalContext } from '@/src/lib/analytics/options-signal/service';
import type { IvLevel, OptionsSignalType } from '@/src/lib/analytics/options-signal/types';
import { REGRESSION_TICKERS } from './signal-regression-tickers';

const PRIME = new Set<OptionsSignalType>(['PRIME_CALL', 'PRIME_PUT']);
const round = (value: number | null, digits = 2) =>
  (value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits)));

/** Calendar days between two `YYYY-MM-DD` dates. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * One fetch per symbol of each chain, and both are returned.
 *
 * Deliberately NOT `computeServerOptionsSignal`: that path decides for itself
 * which chain the IV comes off, which is the thing under test here.
 */
async function loadChains(symbol: string): Promise<{
  chain: OptionsChain;
  result: OptionsSrResult;
  horizonChain: OptionsChain | null;
} | null> {
  try {
    const service = getOptionsMarketDataService();
    const expirations = await service.getExpirations(symbol);
    const today = new Date().toISOString().slice(0, 10);
    const future = [...new Set(expirations.data.expirations)].filter((value) => value >= today).sort();
    const nearest = future[0];
    if (!nearest) return null;

    const horizonDays = OPTIONS_SIGNAL_CONFIG.expectedMove.horizonDays;
    const target = future.reduce((best, value) => (
      Math.abs(daysBetween(today, value) - horizonDays) < Math.abs(daysBetween(today, best) - horizonDays)
        ? value
        : best
    ), future[0]);

    const chain = (await service.getChain(symbol, nearest)).data;
    const horizonChain = target === nearest
      ? null
      : (await service.getChain(symbol, target).catch(() => null))?.data ?? null;

    return {
      chain,
      horizonChain,
      result: computeOptionsSupportResistance({
        symbol: chain.underlyingSymbol,
        expiration: chain.expiration,
        acceptedPrice: chain.spot,
        calls: chain.calls,
        puts: chain.puts,
        provider: chain.provider,
        asOf: chain.asOf,
        status: chain.status,
      }),
    };
  } catch {
    return null;
  }
}

interface Reading {
  iv: number | null;
  dte: number | null;
  realized: number | null;
  window: number | null;
  ratio: number | null;
  level: IvLevel | null;
  signalType: OptionsSignalType | null;
  ivWarning: boolean;
}

interface Row {
  symbol: string;
  cap: string;
  /** The horizon chain resolved to a DIFFERENT expiration than the front one. */
  horizonResolved: boolean;
  before: Reading;
  after: Reading;
}

async function main() {
  const rows: Row[] = [];
  const failures: string[] = [];

  for (const { symbol, cap } of REGRESSION_TICKERS) {
    try {
      const [context, chains] = await Promise.all([
        loadOptionsSignalContext(symbol),
        loadChains(symbol),
      ]);
      if (!chains) {
        failures.push(`${symbol}: no chain`);
        process.stderr.write('x');
        continue;
      }

      const horizonChain = chains.horizonChain;
      /*
       * The expected move is held CONSTANT at the horizon across both readings.
       * It moved there in an earlier change, and leaving it on the front chain
       * for the "before" run would fold two revisions into one difference.
       */
      const expectedMove = horizonChain
        ? { move: atmStraddleExpectedMove(horizonChain), dte: chainDte(horizonChain) }
        : null;
      const horizonAtm = horizonChain ? calculateAtmIv(horizonChain) : null;
      const horizonIv = horizonChain
        ? { iv: horizonAtm?.status === 'available' ? horizonAtm.iv : null, dte: chainDte(horizonChain) }
        : null;

      const base = {
        chain: chains.chain,
        optionsSr: chains.result,
        acceptedPrice: chains.chain.spot,
        expectedMove,
        // No history by construction: the percentile basis needs sixty readings
        // and this is the cold-start comparison, which is the one that ships.
        ownHistory: { atmIv: [], putCallRatio: [] },
      };

      // BEFORE: the IV off the front chain, which is where it used to live.
      const before = calculateOptionsSignal(assembleOptionsSignalInput(context, base));
      // AFTER: the IV off the same chain the expected move is already read from.
      const after = calculateOptionsSignal(assembleOptionsSignalInput(context, { ...base, horizonIv }));

      const readingOf = (result: typeof before): Reading => ({
        iv: round(result.diagnostics.iv.impliedVolatility, 4),
        dte: result.diagnostics.iv.dte,
        realized: round(result.diagnostics.iv.realizedVolatility, 4),
        window: result.diagnostics.iv.realizedWindowDays,
        ratio: round(result.diagnostics.iv.ratio, 3),
        level: result.diagnostics.iv.level,
        signalType: result.status === 'available' ? result.signalType : null,
        ivWarning: result.diagnostics.gates.ivWarning,
      });

      rows.push({
        symbol,
        cap,
        horizonResolved: horizonChain !== null,
        before: readingOf(before),
        after: readingOf(after),
      });
      process.stderr.write('.');
    } catch (error) {
      failures.push(`${symbol}: ${(error as Error).message.slice(0, 80)}`);
      process.stderr.write('x');
    }
  }
  process.stderr.write('\n');

  console.log('\n## Per-symbol · IV, the window it is judged against, and the ratio\n');
  console.log('| symbol | cap | DTE before → after | IV before → after | RV window before → after | IV÷RV before → after | level before → after |');
  console.log('| --- | --- | --- | --- | --- | ---: | --- |');
  const percent = (value: number | null) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`);
  for (const row of rows) {
    const changed = row.before.level !== row.after.level ? ' **' : '';
    console.log(
      `| ${row.symbol} | ${row.cap}`
      + ` | ${row.before.dte ?? '—'} → ${row.after.dte ?? '—'}`
      + ` | ${percent(row.before.iv)} → ${percent(row.after.iv)}`
      + ` | ${row.before.window ?? '—'} → ${row.after.window ?? '—'}`
      + ` | ${row.before.ratio ?? '—'} → ${row.after.ratio ?? '—'}`
      + ` | ${row.before.level ?? '—'} → ${row.after.level ?? '—'}${changed} |`,
    );
  }

  const usable = rows.filter((row) => row.before.ratio !== null && row.after.ratio !== null);
  const levelChanged = rows.filter((row) => row.before.level !== row.after.level);
  const labelChanged = rows.filter((row) => row.before.signalType !== row.after.signalType);
  const warningChanged = rows.filter((row) => row.before.ivWarning !== row.after.ivWarning);
  const noHorizon = rows.filter((row) => !row.horizonResolved);

  const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
  const median = (values: number[]) => {
    if (!values.length) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  };

  console.log('\n## IV ÷ realized volatility\n');
  console.log('| reading | n | mean | median |');
  console.log('| --- | ---: | ---: | ---: |');
  for (const [what, key] of [['front chain (before)', 'before'], ['horizon chain (after)', 'after']] as const) {
    const values = usable.map((row) => row[key].ratio as number);
    console.log(`| ${what} | ${values.length} | ${round(mean(values), 3)} | ${round(median(values), 3)} |`);
  }

  console.log('\n## What moved\n');
  console.log(`  richness band changed: ${levelChanged.length} of ${rows.length}`);
  for (const row of levelChanged) {
    console.log(`    ${row.symbol}: ${row.before.level ?? '—'} -> ${row.after.level ?? '—'}`
      + ` · ratio ${row.before.ratio ?? '—'} -> ${row.after.ratio ?? '—'}`
      + ` · DTE ${row.before.dte ?? '—'} -> ${row.after.dte ?? '—'}`);
  }
  console.log(`\n  IV warning gate changed: ${warningChanged.length} of ${rows.length}`);
  for (const row of warningChanged) {
    console.log(`    ${row.symbol}: ivWarning ${row.before.ivWarning} -> ${row.after.ivWarning}`);
  }
  console.log(`\n  published label changed: ${labelChanged.length} of ${rows.length}`);
  for (const row of labelChanged) {
    console.log(`    ${row.symbol}: ${row.before.signalType ?? '—'} -> ${row.after.signalType ?? '—'}`);
  }

  const primeBefore = rows.filter((row) => row.before.signalType && PRIME.has(row.before.signalType)).length;
  const primeAfter = rows.filter((row) => row.after.signalType && PRIME.has(row.after.signalType)).length;
  console.log(`\n  PRIME: ${primeBefore} -> ${primeAfter} of ${rows.length}`);

  if (noHorizon.length) {
    /*
     * Not a failure. The horizon chain and the front chain being the same
     * expiration is the documented fallback, and these are the symbols where the
     * card now prints the front DTE beside the IV instead of leaving it unsaid.
     */
    console.log(`\n  no separate horizon expiration (front chain used, DTE stated): ${noHorizon.length}`);
    console.log(`    ${noHorizon.map((row) => row.symbol).join(', ')}`);
  }

  /*
   * The line the brief drew, and it is a REPORTING line rather than a gate: past
   * it, the change is big enough that somebody has to look at the bands rather
   * than at this summary.
   */
  const share = rows.length ? levelChanged.length / rows.length : 0;
  console.log(`\n  richness band changed on ${(share * 100).toFixed(0)}% of symbols`);
  console.log(share > 0.5
    ? '  => OVER the 50% line. Reported, not acted on: no threshold is moved here.'
    : '  => within the 50% line.');

  if (failures.length) {
    console.log(`\n## Symbols that could not be read (${failures.length})\n`);
    for (const failure of failures) console.log(`  ${failure}`);
  }
}

void main();
