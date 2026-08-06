import { describe, expect, it, vi } from 'vitest';
import type { OptionsChain } from '@/src/lib/market-data/options/contracts';
import type { PortfolioRecord, PortfolioTransaction } from '../types';
import {
  buildOptionPurchaseQuote,
  calculateOptionPurchasePreview,
  optionPurchaseQuoteFingerprint,
  optionsMarketClosedMessage,
  validateOptionPurchaseQuote,
} from './purchase';
import { purchaseOptionFromChain, type OptionPurchaseServiceDependencies } from './purchase-service';

const NOW = Date.parse('2026-08-05T03:00:00.000Z');
/** Wednesday 13:00 ET — the middle of a regular session, where a stale quote is a defect. */
const REGULAR_SESSION = Date.parse('2026-08-05T17:00:00.000Z');
const AS_OF = '2026-08-05T02:59:30.000Z';

function contract(type: 'call' | 'put') {
  return {
    contractSymbol: type === 'call' ? 'AAPL260821C00200000' : 'AAPL260821P00200000',
    underlyingSymbol: 'AAPL', type, expiration: '2026-08-21', strike: 200,
    bid: type === 'call' ? 2.4 : 1.1, ask: type === 'call' ? 2.5 : 1.2,
    last: type === 'call' ? 2.45 : 1.15, mark: type === 'call' ? 2.45 : 1.15,
    volume: 10, openInterest: 100, inTheMoney: false, multiplier: 100,
    currency: 'USD', provider: 'test', marketDataProvider: 'test-quotes', marketDataFeed: 'indicative',
    asOf: AS_OF, oiAsOf: '2026-08-04', timestampKind: 'provider' as const,
    status: 'delayed' as const, delayedMinutes: 15,
    impliedVolatility: 0.31, delta: type === 'call' ? 0.45 : -0.4,
    gamma: 0.02, theta: -0.04, vega: 0.12, rho: 0.03, valuationSource: 'provider' as const,
  };
}

function chain(): OptionsChain {
  return {
    underlyingSymbol: 'AAPL', spot: 198.5, expiration: '2026-08-21', expirations: ['2026-08-21'],
    calls: [contract('call')], puts: [contract('put')], provider: 'test', asOf: AS_OF,
    timestampKind: 'provider', status: 'delayed', delayedMinutes: 15, completeness: 1, warnings: [],
    underlyingProvider: 'test-spot', underlyingAsOf: AS_OF, underlyingStatus: 'delayed',
  };
}

function deposit(amount: number): PortfolioTransaction {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', portfolioId: '11111111-1111-4111-8111-111111111111',
    type: 'deposit', symbol: null, quantity: null, price: null, amount: String(amount),
    occurredAt: '2026-08-05', occurredAtTime: '2026-08-05T02:00:00.000Z', note: null,
    createdAt: '2026-08-05T02:00:00.000Z', updatedAt: '2026-08-05T02:00:00.000Z',
  };
}

function portfolio(cash: number): PortfolioRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111', name: 'Options', type: 'OPTION', isLegacy: false,
    archivedAt: null, deletedAt: null, purgeAfter: null,
    targetValueUsd: null, targetDate: null, baseCurrency: 'USD', transactions: [deposit(cash)],
  };
}

function request(quote = buildOptionPurchaseQuote(chain(), 'AAPL260821C00200000')!) {
  return {
    portfolioId: '11111111-1111-4111-8111-111111111111', underlyingSymbol: 'AAPL',
    expiration: '2026-08-21', contractSymbol: quote.contractSymbol, contracts: 2,
    purchasePrice: String(quote.ask), occurredAt: '2026-08-05T10:00', timezone: 'Asia/Bangkok',
    quoteFingerprint: optionPurchaseQuoteFingerprint(quote),
    idempotencyKey: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  };
}

describe('Option Chain purchase preparation', () => {
  it.each(['call', 'put'] as const)('preloads the complete %s identity, quote, Greeks, spot and multiplier 100', (kind) => {
    const quote = buildOptionPurchaseQuote(chain(), contract(kind).contractSymbol);
    expect(quote).toMatchObject({
      underlyingSymbol: 'AAPL', optionKind: kind, strike: 200, expiration: '2026-08-21',
      contractSymbol: contract(kind).contractSymbol, multiplier: 100, quoteTimestamp: AS_OF,
      impliedVolatility: 0.31, gamma: 0.02, theta: -0.04, vega: 0.12, rho: 0.03,
      spot: 198.5, provider: 'test', marketDataProvider: 'test-quotes',
    });
    expect(quote?.mid).toBe(kind === 'call' ? 2.45 : 1.15);
    expect(validateOptionPurchaseQuote(quote!, NOW)).toEqual({ ok: true });
  });

  it('calculates premium, cost, long max loss and cash after with multiplier 100', () => {
    expect(calculateOptionPurchasePreview(2, '2.50', 1_000)).toEqual({
      premium: 5,
      cost: 500,
      maxLoss: 500,
      cashAfter: 500,
    });
  });

  it('refuses stale and non-standard/invalid quotes', () => {
    const quote = buildOptionPurchaseQuote(chain(), 'AAPL260821C00200000')!;
    expect(validateOptionPurchaseQuote({ ...quote, status: 'stale' }, REGULAR_SESSION)).toMatchObject({ ok: false, code: 'stale-quote' });
    expect(validateOptionPurchaseQuote({ ...quote, quoteTimestamp: '2026-08-04T00:00:00.000Z' }, REGULAR_SESSION)).toMatchObject({ ok: false, code: 'stale-quote' });
    expect(validateOptionPurchaseQuote({ ...quote, ask: null }, NOW)).toMatchObject({ ok: false, code: 'invalid-quote' });
    expect(validateOptionPurchaseQuote({ ...quote, multiplier: 10 }, NOW)).toMatchObject({ ok: false, code: 'invalid-quote' });
  });

  /*
   * The refusal a closed market gets is the point of these three. "กรุณาโหลดราคาใหม่"
   * is a real instruction at 13:00 ET and a dead end at 23:00 ET, on a Saturday and
   * during pre-market — the reader can press reload until the bell and the price
   * will not change, because no session is quoting it.
   */
  it.each([
    ['an ordinary evening', Date.parse('2026-08-05T03:00:00.000Z'), 'ปิดตลาด'],
    ['a weekend', Date.parse('2026-08-08T17:00:00.000Z'), 'วันหยุดสุดสัปดาห์'],
    ['pre-market', Date.parse('2026-08-05T12:00:00.000Z'), 'ก่อนเปิดตลาด'],
    ['after hours', Date.parse('2026-08-05T21:00:00.000Z'), 'หลังปิดตลาด'],
  ])('says the options market is closed rather than asking for a reload on %s', (_case, instant, expected) => {
    const quote = buildOptionPurchaseQuote(chain(), 'AAPL260821C00200000')!;
    const result = validateOptionPurchaseQuote({ ...quote, quoteTimestamp: '2026-08-04T00:00:00.000Z' }, instant);
    expect(result).toMatchObject({ ok: false, code: 'market-closed' });
    expect(result.ok === false && result.message).toContain(expected);
    expect(result.ok === false && result.message).not.toContain('โหลดราคาใหม่');
    expect(optionsMarketClosedMessage(instant)).not.toBeNull();
  });

  it('keeps the 15-minute allowance and the reload instruction while the market trades', () => {
    const quote = buildOptionPurchaseQuote(chain(), 'AAPL260821C00200000')!;
    expect(optionsMarketClosedMessage(REGULAR_SESSION)).toBeNull();
    // 14 minutes old, inside the unchanged allowance, is still buyable.
    expect(validateOptionPurchaseQuote(
      { ...quote, delayedMinutes: 0, quoteTimestamp: new Date(REGULAR_SESSION - 14 * 60_000).toISOString() },
      REGULAR_SESSION,
    )).toEqual({ ok: true });
    expect(validateOptionPurchaseQuote(
      { ...quote, delayedMinutes: 0, quoteTimestamp: new Date(REGULAR_SESSION - 16 * 60_000).toISOString() },
      REGULAR_SESSION,
    )).toMatchObject({ ok: false, code: 'stale-quote', message: expect.stringContaining('โหลดราคาใหม่') });
  });
});

describe('server-authoritative Option Chain purchase', () => {
  it('uses the server chain and creates one validated transaction', async () => {
    const quote = buildOptionPurchaseQuote(chain(), 'AAPL260821C00200000')!;
    const create = vi.fn<OptionPurchaseServiceDependencies['create']>(async () => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    const result = await purchaseOptionFromChain(request(quote), {
      now: () => NOW,
      loadChain: async () => chain(),
      loadPortfolio: async () => portfolio(1_000),
      create,
    });
    expect(result).toMatchObject({ ok: true, cost: 500, cashAfter: 500 });
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][1]).toMatchObject({ contractSymbol: quote.contractSymbol, multiplier: 100 });
  });

  /*
   * The market moving between opening the sheet and pressing confirm is the
   * normal case, not an error: a live option re-quotes every few seconds, and
   * the row is priced from the reader's own input either way. Refusing it made
   * the feature unusable during the only hours it can be used.
   */
  it('still writes at the price the reader confirmed when the market has moved since', async () => {
    const shown = buildOptionPurchaseQuote(chain(), 'AAPL260821C00200000')!;
    const moved = chain();
    moved.calls = [{ ...moved.calls[0], bid: 2.6, ask: 2.7, mark: 2.65, last: 2.68, asOf: '2026-08-05T02:59:50.000Z' }];
    moved.spot = 199.4;
    const create = vi.fn<OptionPurchaseServiceDependencies['create']>(async () => 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    const result = await purchaseOptionFromChain(request(shown), {
      now: () => NOW,
      loadChain: async () => moved,
      loadPortfolio: async () => portfolio(1_000),
      create,
    });
    // 2 contracts x 100 x the 2.50 the reader confirmed — never the 2.70 ask.
    expect(result).toMatchObject({ ok: true, cost: 500, cashAfter: 500 });
    expect(create.mock.calls[0][0].purchasePrice).toBe('2.5');
  });

  it('refuses and does not write when the resolved contract carries different terms', async () => {
    const shown = buildOptionPurchaseQuote(chain(), 'AAPL260821C00200000')!;
    const mismatched = chain();
    // The same OCC symbol resolving to a different strike is an integrity
    // failure: it would post an instrument the reader never saw.
    mismatched.calls = [{ ...mismatched.calls[0], strike: 205 }];
    const create = vi.fn();
    const result = await purchaseOptionFromChain(request(shown), {
      now: () => NOW,
      loadChain: async () => mismatched,
      loadPortfolio: async () => portfolio(1_000),
      create,
    });
    expect(result).toMatchObject({ ok: false, code: 'quote-changed', quote: { strike: 205 } });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses insufficient cash before the database repeats the atomic check', async () => {
    const quote = buildOptionPurchaseQuote(chain(), 'AAPL260821C00200000')!;
    const create = vi.fn();
    const result = await purchaseOptionFromChain(request(quote), {
      now: () => NOW,
      loadChain: async () => chain(),
      loadPortfolio: async () => portfolio(499),
      create,
    });
    expect(result).toMatchObject({ ok: false, code: 'insufficient-cash' });
    expect(create).not.toHaveBeenCalled();
  });
});
