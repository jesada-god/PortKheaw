/**
 * The expected-move collector. One run writes one day.
 *
 * This is the smallest thing that makes a question answerable later. P5 could
 * not test an expected-move signal because no historical options chain exists to
 * test it against; the only fix is to start keeping one, so this fetches four
 * numbers per symbol and stores them.
 *
 * IT IS NOT A FEATURE. Nothing reads what it writes, no flag switches it on, it
 * renders nothing, and it is not connected to the Market Signal engine. If the
 * collection turns out to be worthless the loss is a few kilobytes a day.
 *
 * WHEN TO LOOK AT THE DATA: not for about a year. The arithmetic is in
 * `docs/market-signal/expected-move-collection.md` — twelve months for a first
 * suggestive look at the 5-bar horizon, roughly three years before all three
 * horizons can carry a 2pp finding. The script prints how far into that wait it
 * is on every run, so the answer to "is it time yet" does not need a calculator.
 *
 * ---------------------------------------------------------------------------
 * WHICH SYMBOLS
 * ---------------------------------------------------------------------------
 * The instrument list of the calibration run named in `MARKET_SIGNAL_MEASURED`.
 * Not a list of its own: the entire point of collecting is to eventually measure
 * against the same corpus P4a and P5 used, and a second list would drift from
 * the first the first time either changed.
 *
 * Symbols with no options chain — the three futures contracts, the crypto pairs,
 * some thin ETFs — fail their fetch and are reported as skipped. That is the
 * correct behaviour and not an error: the collectable universe is a property of
 * the market, and printing it every run is how anyone knows what it is.
 *
 * Run: npm run collect:expected-move
 * Schedule: once per trading day, after the US close.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MARKET_SIGNAL_MEASURED } from '@/src/config/signal';
import { deriveExpectedMove, chooseExpiration } from '@/src/lib/analytics/expected-move/derive';
import { collectionProgress, writeExpectedMove } from '@/src/lib/analytics/expected-move/repository';
import { getOptionsMarketDataService } from '@/src/lib/market-data/options';

const MANIFEST_PATH = join(
  process.cwd(), '__calibration__', MARKET_SIGNAL_MEASURED.runId, 'manifest.json',
);

/** The first date at which the collection is worth looking at, in days. */
const FIRST_LOOK_DAYS = 365;

const today = (): string => new Date().toISOString().slice(0, 10);

function symbols(): string[] {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { instruments: string[] };
  return manifest.instruments;
}

async function collect(symbol: string, asOf: string): Promise<'written' | 'no-chain' | 'no-reading' | 'not-stored'> {
  const service = getOptionsMarketDataService();

  let expirations: readonly string[];
  try {
    const result = await service.getExpirations(symbol);
    expirations = result.data.expirations;
  } catch {
    return 'no-chain';
  }

  const expiration = chooseExpiration(expirations, asOf);
  if (!expiration) return 'no-reading';

  let chain;
  try {
    chain = (await service.getChain(symbol, expiration)).data;
  } catch {
    return 'no-chain';
  }

  const observation = deriveExpectedMove(chain, asOf);
  if (!observation) return 'no-reading';

  return (await writeExpectedMove(observation)) ? 'written' : 'not-stored';
}

async function main(): Promise<void> {
  const asOf = today();
  const universe = symbols();
  console.log(`expected-move collector · ${asOf} · ${universe.length} symbols in the corpus`);

  const outcomes = { written: 0, 'no-chain': [] as string[], 'no-reading': [] as string[], 'not-stored': [] as string[] };

  for (const symbol of universe) {
    // Sequential on purpose. This runs once a day with no deadline, and a burst
    // of a hundred chain requests is the fastest way to meet a provider's rate
    // limiter and collect nothing at all.
    const outcome = await collect(symbol, asOf);
    if (outcome === 'written') outcomes.written += 1;
    else outcomes[outcome].push(symbol);
  }

  console.log(`written        ${outcomes.written}`);
  console.log(`no chain       ${outcomes['no-chain'].length}  ${outcomes['no-chain'].join(' ')}`);
  console.log(`no reading     ${outcomes['no-reading'].length}  ${outcomes['no-reading'].join(' ')}`);
  if (outcomes['not-stored'].length > 0) {
    console.error(`NOT STORED     ${outcomes['not-stored'].length}  ${outcomes['not-stored'].join(' ')}`);
  }

  /*
   * The wait, printed every run so that nobody has to remember it. A collection
   * looked at too early produces an interval wider than any effect worth having,
   * and that is how a feature gets built on noise.
   */
  const progress = await collectionProgress();
  if (progress.since === null) {
    console.log('\nfirst day of collection. Nothing here is worth reading for about a year.');
  } else {
    const remaining = Math.max(0, FIRST_LOOK_DAYS - progress.days);
    console.log(`\ncollecting since ${progress.since} · ${progress.days} days · ${progress.rows} rows`);
    console.log(remaining > 0
      ? `${remaining} days until the first look is worth taking, and it will only cover the 5-bar horizon.`
      : 'past the twelve-month mark: a first look at the 5-bar horizon is now worth taking. All three horizons need about three years.');
  }

  // A day where nothing landed is a broken collector, not a quiet market.
  if (outcomes.written === 0) {
    console.error('\nnothing was written. The collector is not working.');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
