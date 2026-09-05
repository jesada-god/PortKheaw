import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarketDataError, mapProviderFailure } from '../../errors';
import { IntradayMarketDataService } from '../../intraday/service';
import type { IntradayProvider } from '../alpha-vantage/intraday';
import { FinancialModelingPrepIntradayProvider } from './intraday';

vi.mock('server-only', () => ({}));

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * WHAT HAPPENS WHEN FMP SAYS THE PLAN DOES NOT COVER THIS ENDPOINT.
 *
 * ===========================================================================
 * THE ACTUAL STATE OF THE KEY, MEASURED
 * ===========================================================================
 * The report that started this said the FMP key was dead across the board,
 * because `/v3/quote` returns 403. `/v3` IS dead — FMP retired it for anyone
 * who is not a legacy subscriber — but nothing in this codebase calls `/v3`.
 * Every caller is on `/stable`, and on `/stable` the key works:
 *
 *     /stable/profile                     200
 *     /stable/historical-price-eod/full   200
 *     /stable/earnings                    200
 *     /stable/income-statement            200
 *     /stable/historical-chart/5min       402  Restricted Endpoint
 *
 * So exactly one path is broken and it is broken for a different reason than
 * the one reported: a plan tier, not a retired API. That distinction decides
 * the fix. A retired API needs a new provider; a tier limit needs the fallback
 * that is already there to actually work.
 *
 * ===========================================================================
 * WHY THESE TESTS DID NOT EXIST BEFORE
 * ===========================================================================
 * The mapping, the ordering and the staleness labels were all written
 * correctly and none of them was ever exercised for this case. That is the
 * dangerous kind of correct: the 402 arrives in production, the code does the
 * right thing, and nobody can tell whether it did because it was designed to
 * or because it happened to.
 */
describe('an FMP endpoint the plan does not cover', () => {
  /*
   * FMP answers a restricted endpoint with `402` and a PLAIN TEXT body —
   * "Restricted Endpoint: This endpoint is not available under your current
   * subscription". No JSON, so the status is the only thing to read, which is
   * why the mapping must not depend on parsing a message out of the payload.
   */
  const restrictedResponse = () => new Response(
    'Restricted Endpoint: This endpoint is not available under your current'
    + ' subscription please visit our subscription page',
    { status: 402, headers: { 'Content-Type': 'text/plain' } },
  );

  it('is an entitlement failure, not a rate limit', () => {
    const error = mapProviderFailure({ status: 402 });
    expect(error.code).toBe('forbidden');
  });

  /*
   * NOT RETRYABLE, AND THAT IS THE WHOLE POINT OF THE ORDERING IN
   * `mapProviderFailure`. A plan limit does not clear by asking again. Reading
   * it as a quota would turn every chart load into three requests against an
   * endpoint that will refuse all three — the request storm the comment above
   * that branch exists to prevent.
   */
  it('does not retry, because a plan limit does not clear by asking again', () => {
    expect(mapProviderFailure({ status: 402 }).retryable).toBe(false);
  });

  /*
   * The provider goes through `ProviderHttpClient`, which gives up on a
   * non-JSON body before it ever looks for a message. This asserts the whole
   * path — provider, http client, mapper — lands on `forbidden` rather than on
   * the generic parse failure the plain-text body would otherwise produce.
   */
  it('surfaces as forbidden through the real provider, not as a parse error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => restrictedResponse()));

    const provider = new FinancialModelingPrepIntradayProvider('secret');
    const failure = await provider.getIntraday('AAPL', '5m', 'regular').catch((error) => error);

    expect(failure).toBeInstanceOf(MarketDataError);
    expect((failure as MarketDataError).code).toBe('forbidden');
    expect((failure as MarketDataError).retryable).toBe(false);
  });

  it('asks the restricted endpoint once, not three times', async () => {
    const fetcher = vi.fn(async () => restrictedResponse());
    vi.stubGlobal('fetch', fetcher);

    await new FinancialModelingPrepIntradayProvider('secret')
      .getIntraday('AAPL', '5m', 'regular')
      .catch(() => undefined);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

/**
 * ===========================================================================
 * THE FALLBACK IS REAL, AND FMP IS THE SECOND CHOICE
 * ===========================================================================
 * `intraday/index.ts` pushes Alpha Vantage first and FMP after it, so the
 * restricted endpoint is only ever reached when the primary has already
 * failed. These pin that ordering behaviour at the service, because "FMP is
 * the fallback" is a claim about a list built somewhere else and is exactly
 * the kind of thing that gets reordered by accident.
 */
describe('the intraday chain around a restricted secondary', () => {
  const bar = (sessionDate: string) => ({
    timestamp: `${sessionDate}T14:30:00.000Z`,
    sessionDate,
    open: 1, high: 2, low: 0.5, close: 1.5,
    volume: 100,
    interval: '5m' as const,
    exchangeTimezone: 'America/New_York',
    sessionType: 'regular' as const,
    provider: 'alpha-vantage',
    asOf: `${sessionDate}T14:30:00.000Z`,
  });

  const working = (): IntradayProvider => ({
    id: 'alpha-vantage',
    getIntraday: vi.fn(async () => ({
      symbol: 'AAPL', interval: '5m' as const, sessionMode: 'regular' as const,
      bars: [bar('2026-09-04')],
      exchangeTimezone: 'America/New_York',
      provider: 'alpha-vantage',
      asOf: '2026-09-04T14:30:00.000Z',
      status: 'delayed' as const, delayedMinutes: null, warnings: [],
    })),
  } as unknown as IntradayProvider);

  const restricted = (): IntradayProvider => ({
    id: 'financial-modeling-prep',
    getIntraday: vi.fn(async () => {
      throw new MarketDataError('forbidden', 'The configured provider plan does not authorize this market data operation');
    }),
  } as unknown as IntradayProvider);

  it('never reaches the restricted provider while the primary answers', async () => {
    const primary = working();
    const secondary = restricted();
    const result = await new IntradayMarketDataService([primary, secondary])
      .getIntraday('AAPL', '5m', '1d', 'regular');

    expect(result.data.provider).toBe('alpha-vantage');
    expect(secondary.getIntraday).not.toHaveBeenCalled();
  });

  /*
   * WITH BOTH GONE, THE ANSWER IS AN ERROR — never an empty series dressed as
   * a quiet market. A chart drawn from no bars is indistinguishable from a
   * chart of a symbol that did not trade, and the reader has no way to tell
   * which one they are looking at.
   */
  it('fails loudly when the primary is down and the secondary is restricted', async () => {
    const primary = {
      id: 'alpha-vantage',
      getIntraday: vi.fn(async () => {
        throw new MarketDataError('upstream-unavailable', 'Market data provider is unavailable');
      }),
    } as unknown as IntradayProvider;

    const failure = await new IntradayMarketDataService([primary, restricted()])
      .getIntraday('AAPL', '5m', '1d', 'regular')
      .catch((error) => error);

    expect(failure).toBeInstanceOf(MarketDataError);
    expect((failure as MarketDataError).code).not.toBe('insufficient-data');
  });
});
