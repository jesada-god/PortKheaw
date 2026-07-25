import { describe, expect, it, vi } from 'vitest';
import {
  IndependentMarketInputsResolver,
  IndependentMarketSourceError,
  parseDamodaranUsImpliedErp,
  parseTreasuryTenYearYield,
} from './independent-market-inputs';

vi.mock('server-only', () => ({}));

const treasuryXml = `
  <feed xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices">
    <entry><content><m:properties>
      <d:NEW_DATE m:type="Edm.DateTime">2026-07-23T00:00:00</d:NEW_DATE>
      <d:BC_10YEAR m:type="Edm.Double">4.31</d:BC_10YEAR>
    </m:properties></content></entry>
    <entry><content><m:properties>
      <d:NEW_DATE m:type="Edm.DateTime">2026-07-24T00:00:00</d:NEW_DATE>
      <d:BC_10YEAR m:type="Edm.Double">4.27</d:BC_10YEAR>
    </m:properties></content></entry>
  </feed>`;

const damodaranHtml = `
  <html><body>
    <strong>Implied ERP on July 1, 2026 </strong>= 4.
    <span class="MsoNormal"></span><span class="MsoNormal">18%
    (Trailing 12 month, with adjusted payout);
    </span>
  </body></html>`;

describe('independent Fair Value market inputs', () => {
  it('selects the latest real Treasury 10Y observation and normalizes percent once', () => {
    const result = parseTreasuryTenYearYield(treasuryXml);
    expect(result).toMatchObject({
      asOf: '2026-07-24',
      provenance: {
        provider: 'us-treasury-daily-par-yield-curve',
        fiscalPeriod: '10Y',
      },
    });
    expect(result.value).toBeCloseTo(0.0427);
  });

  it('parses the labelled current U.S. implied ERP from NYU Damodaran', () => {
    expect(parseDamodaranUsImpliedErp(damodaranHtml)).toMatchObject({
      value: 0.0418,
      asOf: '2026-07-01',
      provenance: {
        provider: 'nyu-damodaran-implied-erp',
        fiscalPeriod: 'United States',
      },
    });
  });

  it('fails safely when either upstream format loses its validated field', () => {
    expect(() => parseTreasuryTenYearYield('<feed><entry /></feed>'))
      .toThrow(IndependentMarketSourceError);
    expect(() => parseDamodaranUsImpliedErp('<html>ERP estimate unavailable</html>'))
      .toThrow(IndependentMarketSourceError);
  });

  it('deduplicates and caches shared U.S. market input requests across tickers', async () => {
    let release!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => {
      release = resolve;
    }));
    const resolver = new IndependentMarketInputsResolver(fetcher as typeof fetch);

    const first = resolver.resolveRiskFreeRate();
    const second = resolver.resolveRiskFreeRate();
    expect(fetcher).toHaveBeenCalledTimes(1);
    release(new Response(treasuryXml, { status: 200 }));

    expect((await first).value).toBeCloseTo(0.0427);
    expect((await second).value).toBeCloseTo(0.0427);
    expect((await resolver.resolveRiskFreeRate()).value).toBeCloseTo(0.0427);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('honors 429 cooldown and does not create a retry storm', async () => {
    const fetcher = vi.fn(async () => new Response('', {
      status: 429,
      headers: { 'retry-after': '120' },
    }));
    const resolver = new IndependentMarketInputsResolver(
      fetcher as typeof fetch,
      () => Date.parse('2026-07-25T00:00:00.000Z'),
    );

    await expect(resolver.resolveEquityRiskPremium()).rejects.toMatchObject({
      code: 'rate-limited',
      source: 'nyu-damodaran',
      status: 429,
      retryAfterSeconds: 120,
    });
    await expect(resolver.resolveEquityRiskPremium()).rejects.toMatchObject({
      code: 'rate-limited',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('negative-caches an unexpected source format instead of refetching per ticker', async () => {
    const fetcher = vi.fn(async () => new Response(
      '<html>ERP publication format changed</html>',
      { status: 200 },
    ));
    const resolver = new IndependentMarketInputsResolver(fetcher as typeof fetch);

    await expect(resolver.resolveEquityRiskPremium()).rejects.toMatchObject({
      code: 'invalid-provider-response',
    });
    await expect(resolver.resolveEquityRiskPremium()).rejects.toMatchObject({
      code: 'invalid-provider-response',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
