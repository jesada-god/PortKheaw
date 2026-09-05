import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  FALLBACK_INSTRUMENT_PROVIDER,
  PRIMARY_INSTRUMENT_PROVIDER,
  loadInstrumentSnapshot,
} from './providers';

/**
 * WHICH PROVIDER A SYNCED ROW SAYS IT CAME FROM.
 *
 * ===========================================================================
 * THE DEFECT
 * ===========================================================================
 * `sync-instruments.ts` passed the constant `PRIMARY_INSTRUMENT_PROVIDER` to
 * the database whichever provider had actually answered. A run that fell back
 * to Nasdaq Trader wrote 12,636 rows all claiming Alpha Vantage, while the
 * sync's own log line above them said `providerUsed: nasdaq-trader`. The log
 * told the truth; the table did not.
 *
 * A wrong provider is worse than a missing one. Missing is visibly unknown.
 * Wrong is confidently misleading, and it makes "which rows came from the
 * fallback" unanswerable — the exact question somebody asks the moment they
 * find a column the fallback does not populate.
 *
 * ===========================================================================
 * WHAT THESE COVER, IN TWO HALVES
 * ===========================================================================
 * The snapshot half is behavioural: drive `loadInstrumentSnapshot` down the
 * fallback path with stubbed responses and read what it reports.
 *
 * The script half is a source assertion, because the persist stage is a
 * `scripts/` entry point that talks to Supabase RPCs and cannot be exercised
 * without a database. What it pins is small and exact — that the value handed
 * to `begin_market_instrument_sync` is derived from the snapshot rather than
 * from the constant — which is precisely the line that was wrong.
 */

const NASDAQ_LISTED = [
  'Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares',
  'AAPL|Apple Inc. - Common Stock|Q|N|N|100|N|N',
  'MSFT|Microsoft Corporation - Common Stock|Q|N|N|100|N|N',
  'File Creation Time: 0905202611:00',
].join('\r\n');

const OTHER_LISTED = [
  'ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol',
  'RKLB|Rocket Lab Corporation - Common Stock|Q|RKLB|N|100|N|RKLB',
  'File Creation Time: 0905202611:00',
].join('\r\n');

/** Alpha Vantage refuses; Nasdaq Trader answers. The real fallback shape. */
function fallbackFetch() {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('alphavantage')) {
      return new Response('{"Information":"premium endpoint"}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const body = url.includes('otherlisted') ? OTHER_LISTED : NASDAQ_LISTED;
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  });
}

describe('what a synced row says it came from', () => {
  it('reports the fallback when the fallback is what answered', async () => {
    const snapshot = await loadInstrumentSnapshot({
      apiKey: 'unused',
      fetchImpl: fallbackFetch() as unknown as typeof fetch,
    });

    expect(snapshot.providerUsed).toBe(FALLBACK_INSTRUMENT_PROVIDER);
    expect(snapshot.instruments.length).toBeGreaterThan(0);
  });

  /*
   * `primaryProvider` is what was TRIED and `providerUsed` is what worked. The
   * defect was reading the first where the second was meant, so the two staying
   * distinct on a fallback run is the property that matters.
   */
  it('keeps "what was tried" and "what answered" as different facts', async () => {
    const snapshot = await loadInstrumentSnapshot({
      apiKey: 'unused',
      fetchImpl: fallbackFetch() as unknown as typeof fetch,
    });

    expect(snapshot.primaryProvider).toBe(PRIMARY_INSTRUMENT_PROVIDER);
    expect(snapshot.providerUsed).not.toBe(snapshot.primaryProvider);
    expect(snapshot.fallbackReason).not.toBeNull();
  });

  it('reports the primary when the primary answered', async () => {
    const csv = [
      'symbol,name,exchange,assetType,ipoDate,delistingDate,status',
      'AAPL,Apple Inc,NASDAQ,Stock,1980-12-12,null,Active',
    ].join('\n');
    const snapshot = await loadInstrumentSnapshot({
      apiKey: 'unused',
      fetchImpl: (async () => new Response(csv, {
        status: 200,
        headers: { 'Content-Type': 'application/x-download' },
      })) as unknown as typeof fetch,
    });

    expect(snapshot.providerUsed).toBe(PRIMARY_INSTRUMENT_PROVIDER);
    expect(snapshot.fallbackReason).toBeNull();
  });

  /*
   * NULL IS NOT AN ATTRIBUTION. With both providers down there is no honest
   * name to write on a run, and the script refuses rather than reaching for the
   * primary's name — the habit that produced the defect.
   */
  it('names nobody when nobody answered', async () => {
    const snapshot = await loadInstrumentSnapshot({
      apiKey: 'unused',
      fetchImpl: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
    });

    expect(snapshot.providerUsed).toBeNull();
    expect(snapshot.incomplete).toBe(true);
  });
});

describe('the sync script writes the provider that answered', () => {
  /*
   * COMMENTS STRIPPED FIRST. This file explains what it used to do, quoting the
   * old expression verbatim — a scan that could not tell prose from code would
   * forbid documenting the defect it exists to prevent. Same distinction
   * `overview.contract.test.ts` draws.
   */
  const source = readFileSync(path.resolve('scripts/sync-instruments.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*/g, '');

  /*
   * The one line the defect lived on. `input_provider` must be computed from
   * the snapshot; a constant there is the bug returning.
   */
  it('derives the run provider from the snapshot, not from the constant', () => {
    expect(source).toContain('input_provider: syncProvider(providerUsed)');
    expect(source).not.toMatch(/input_provider:\s*PRIMARY_INSTRUMENT_PROVIDER/);
  });

  it('passes what answered down to the persist stage', () => {
    expect(source).toContain('persist(rows, failed, idempotencyKey, snapshot.providerUsed)');
  });

  /*
   * The preview used to diff against one provider's rows. With a table that can
   * hold a mix, that would count the other provider's rows as new inserts every
   * run.
   */
  it('previews against every row rather than one provider\'s', () => {
    expect(source).not.toMatch(/\.eq\('provider',\s*PRIMARY_INSTRUMENT_PROVIDER\)/);
  });

  it('refuses to attribute a run when no provider answered', () => {
    expect(source).toContain('sync-provider-unknown');
  });
});
