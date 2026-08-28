import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';
import { loadPortfolioPrices } from '@/src/lib/overview/service';
import { loadPortfolioOptionQuotes } from '@/src/lib/portfolio/options/quote-pipeline';
import type { PortfolioOptionQuotePosition } from '@/src/lib/portfolio/options/quote-pipeline';
import { validMidpoint } from './quote-model';
import { getOptionsMarketDataService } from './options';
import {
  captureDailyCloses,
  loadPreviousCloses,
  type CaptureResult,
  type CapturedClose,
} from './daily-snapshot';
import { lastCompletedSessionDate, marketSession } from './market-session';

/**
 * The post-market capture run: take the closes of everything anybody holds and
 * write them to `daily_snapshot`, once, after the session has ended.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT CAPTURES, AND WHY THAT SET
 * ---------------------------------------------------------------------------
 * The symbols on somebody's ledger — not a universe, not a watchlist. The table
 * exists to answer "what did MY portfolio do today" outside market hours, and a
 * symbol nobody owns has no day figure to rescue. That keeps the provider bill
 * proportional to the product's actual holdings, and it keeps the table from
 * quietly becoming an end-of-day mirror of somebody's licensed data.
 *
 * Symbols are read straight off `portfolio_transactions` rather than by
 * replaying every user's ledger. A symbol that was fully sold is captured too,
 * which is a small amount of waste bought deliberately: the alternative is
 * replaying every ledger in the product to find out, and a sold position that
 * gets re-bought tomorrow then has yesterday's close waiting for it.
 *
 * Option CONTRACTS are captured alongside the equities, and for them this table
 * is not a fallback but the only source there has ever been: the chain pipeline
 * hard-codes `previousClose: null`, so an option's day figure has been blank in
 * every session since the feature shipped. Contracts already past expiry are
 * skipped — a chain lookup for one returns nothing, and its day figure is zero
 * by definition rather than unknown.
 *
 * ---------------------------------------------------------------------------
 * IT DOES NOT DECIDE WHEN IT MAY WRITE
 * ---------------------------------------------------------------------------
 * `captureDailyCloses` refuses to write during an open market, and this run
 * checks the same thing up front purely to avoid buying quotes it is about to
 * throw away. The authority is the one in the writer — a scheduler firing early
 * must not be able to talk its way past it, and a second caller added later
 * must not have to remember the rule.
 */

const SYMBOL_PAGE = 1_000;

export interface DailySnapshotRunResult extends CaptureResult {
  symbols: number;
  contracts: number;
  /** Symbols and contracts whose close could not be obtained from any provider. */
  unpriced: number;
}

interface LedgerContract extends PortfolioOptionQuotePosition {
  expirationDate: string;
}

/**
 * Every distinct equity symbol and unexpired option contract on any ledger.
 *
 * A contract needs its underlying, kind, strike and expiry as well as its
 * symbol, because that identity — not the OCC string — is what resolves a row
 * in a provider chain. Rows missing any part of it cannot be quoted and are
 * dropped here rather than failing later with less context.
 */
async function heldSymbols(
  client: SupabaseClient<Database>,
  onOrAfter: string,
): Promise<{ equities: string[]; contracts: LedgerContract[] }> {
  const equities = new Set<string>();
  const contracts = new Map<string, LedgerContract>();
  for (let page = 0; ; page += 1) {
    const { data, error } = await client
      .from('portfolio_transactions')
      .select('symbol, contract_symbol, underlying_symbol, option_kind, strike_price, expiration_date')
      .range(page * SYMBOL_PAGE, (page + 1) * SYMBOL_PAGE - 1);
    if (error || !data || data.length === 0) break;
    for (const row of data) {
      if (row.symbol) equities.add(row.symbol.toUpperCase());
      const strike = row.strike_price === null ? Number.NaN : Number(row.strike_price);
      if (
        !row.contract_symbol || !row.underlying_symbol || !row.option_kind
        || !row.expiration_date || !Number.isFinite(strike)
        || row.expiration_date < onOrAfter
      ) continue;
      const contractSymbol = row.contract_symbol.toUpperCase();
      if (contracts.has(contractSymbol)) continue;
      contracts.set(contractSymbol, {
        // Keyed by the OCC symbol, which is also what the snapshot row is keyed
        // on — so the quote map comes back ready to write without a join.
        key: contractSymbol,
        contractSymbol,
        underlyingSymbol: row.underlying_symbol.toUpperCase(),
        optionKind: row.option_kind,
        strikePrice: strike,
        expirationDate: row.expiration_date,
      });
    }
    if (data.length < SYMBOL_PAGE) break;
  }
  return { equities: [...equities], contracts: [...contracts.values()] };
}

/**
 * The closing mark of each contract.
 *
 * `mark`, falling back to the bid/ask midpoint, which is the same valuation the
 * ledger already uses for a long position's market value — so a contract's day
 * figure is the difference of two numbers computed the way its market value is,
 * and not a mix of a mark today against a midpoint yesterday.
 */
async function captureContractCloses(contracts: readonly LedgerContract[]): Promise<CapturedClose[]> {
  if (contracts.length === 0) return [];
  let service: ReturnType<typeof getOptionsMarketDataService> | null = null;
  try { service = getOptionsMarketDataService(); } catch { return []; }

  const quotes = await loadPortfolioOptionQuotes(
    contracts,
    async (underlying, expiration) => (await service!.getChain(underlying, expiration)).data,
  );
  return Object.entries(quotes).flatMap(([contractSymbol, quote]) => {
    if (!quote) return [];
    const close = quote.mark ?? validMidpoint(quote.bid, quote.ask);
    if (close === null || !Number.isFinite(close) || close <= 0) return [];
    return [{
      symbol: contractSymbol,
      close,
      // Filled from our own previous row by the caller; a chain never carries one.
      prevClose: null,
      source: quote.source ?? 'options-chain',
    }];
  });
}

export async function runDailySnapshotCapture(
  client: SupabaseClient<Database>,
  now: Date = new Date(),
): Promise<DailySnapshotRunResult> {
  const empty = { written: 0, skipped: 0, symbols: 0, contracts: 0, unpriced: 0 } as const;
  if (marketSession(now) === 'OPEN') {
    return { ...empty, date: null, refused: 'market-open' };
  }
  const date = lastCompletedSessionDate(now);
  if (date === null) {
    return { ...empty, date: null, refused: 'no-completed-session' };
  }

  const { equities, contracts } = await heldSymbols(client, date);
  if (equities.length === 0 && contracts.length === 0) {
    return { ...empty, date, refused: null };
  }

  /*
    The same loader the pages use, so a captured close and a displayed price
    come from one pipeline and cannot disagree about which provider won or how a
    symbol was resolved.

    The two capture legs are independent: an options provider that is not
    configured, or a chain that fails, must not cost the equities their closes,
    and vice versa. `allSettled` rather than `all` for exactly that.
  */
  const [pricedResult, contractResult] = await Promise.allSettled([
    loadPortfolioPrices(equities, now),
    captureContractCloses(contracts),
  ]);
  const priced = pricedResult.status === 'fulfilled' ? pricedResult.value : new Map();
  const contractCloses = contractResult.status === 'fulfilled' ? contractResult.value : [];

  /*
    `prev_close` comes from OUR OWN previous row first, and from the provider's
    reported change only as a fallback.

    Ours is the better source because it is the number the previous day's card
    was computed from: taking the provider's instead means a revision on their
    side silently rewrites the move a reader already saw, and the two figures
    stop reconciling across a week. The fallback exists for the first capture of
    a symbol, when there is no previous row to read — and for a contract there
    is no fallback at all, because a chain never reports one.
  */
  const previous = await loadPreviousCloses(
    client,
    [...equities, ...contractCloses.map((entry) => entry.symbol)],
    date,
  );

  const closes: CapturedClose[] = [];
  let unpriced = 0;
  for (const symbol of equities) {
    const display = priced.get(symbol)?.display;
    const close = display?.price ?? null;
    if (close === null || !Number.isFinite(close) || close <= 0) {
      unpriced += 1;
      continue;
    }
    const reported = display?.change === null || display?.change === undefined
      ? null
      : close - display.change;
    const prevClose = previous.get(symbol)
      ?? (reported !== null && Number.isFinite(reported) && reported > 0 ? reported : null);
    closes.push({
      symbol,
      close,
      prevClose,
      source: display?.source ?? 'canonical-market-snapshot',
    });
  }
  for (const entry of contractCloses) {
    closes.push({ ...entry, prevClose: previous.get(entry.symbol) ?? null });
  }
  unpriced += contracts.length - contractCloses.length;

  const result = await captureDailyCloses(client, closes, now);
  return { ...result, symbols: equities.length, contracts: contracts.length, unpriced };
}
