import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  GroundedFinancialResearchService,
  validateGroundedResearch,
  type GroundedResearchRequest,
} from './grounded-research';

const NOW = Date.parse('2026-07-25T00:00:00.000Z');
const URL = 'https://www.nasdaq.com/market-activity/stocks/nvts/earnings';
const TREASURY_URL = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates';
const REQUEST: GroundedResearchRequest = {
  symbols: ['NVTS'],
  metrics: ['revenue', 'eps'],
  fiscalYears: [2027],
};

function metric(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'NVTS',
    metric: 'revenue',
    fiscalYear: 2027,
    periodEnd: '2027-12-31',
    value: 1_200_000_000,
    currency: 'USD',
    unit: 'USD',
    analystCount: 8,
    asOf: '2026-07-24',
    forward: true,
    consensus: true,
    inferred: false,
    sources: [{
      url: URL,
      publisher: 'Nasdaq',
      publishedAt: '2026-07-24',
      evidence: 'NVTS FY2027 revenue consensus is 1.20 billion USD from 8 analysts.',
      reportedValue: 1_200_000_000,
      currency: 'USD',
      unit: 'USD',
    }],
    ...overrides,
  };
}

function payload(estimates = [metric()], extra: Record<string, unknown> = {}) {
  return {
    retrievedAt: '2026-07-25T00:00:00.000Z',
    estimates,
    ...extra,
  };
}

describe('Gemini grounded evidence validator', () => {
  it('accepts a cited, current, forward consensus and records provenance', () => {
    const result = validateGroundedResearch(payload(), REQUEST, [URL], NOW);
    expect(result.metrics).toHaveLength(1);
    expect(result.metrics[0]).toMatchObject({
      symbol: 'NVTS',
      metric: 'revenue',
      value: 1_200_000_000,
      provenance: {
        provider: 'gemini-grounded-research',
        sourceType: 'gemini-grounded',
        evidenceQuality: 'medium',
      },
    });
    expect(result.metrics[0].provenance.evidence).toHaveLength(1);
  });

  it('classifies a Google grounding redirect from its trusted attribution title', () => {
    const redirect = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/example';
    const result = validateGroundedResearch(payload([metric({
      sources: [{
        ...(metric().sources[0] as object),
        url: redirect,
      }],
    })]), REQUEST, [redirect], NOW, {
      [redirect]: 'nasdaq.com',
    });
    expect(result.metrics).toHaveLength(1);
    expect(result.metrics[0].provenance.evidence[0]).toMatchObject({
      url: redirect,
      quality: 'reputable',
    });
  });

  it.each([
    ['symbol mismatch', metric({ symbol: 'AAPL' }), 'symbol-mismatch'],
    ['historical period', metric({ fiscalYear: 2025, periodEnd: '2025-12-31' }), 'fiscal-year-mismatch'],
    ['stale consensus', metric({ asOf: '2025-01-01' }), 'stale'],
    ['unit mismatch', metric({ unit: 'USD/share' }), 'unit-ambiguous'],
    ['unsupported inference', metric({ inferred: true }), 'unsupported-inference'],
  ])('rejects %s', (_label, candidate, reason) => {
    const result = validateGroundedResearch(payload([candidate]), REQUEST, [URL], NOW);
    expect(result.metrics).toEqual([]);
    expect(result.rejectedReasons).toContain(reason);
  });

  it('rejects an ungrounded or AI-generated citation', () => {
    const missing = validateGroundedResearch(payload(), REQUEST, ['https://www.reuters.com/'], NOW);
    expect(missing.metrics).toEqual([]);
    expect(missing.rejectedReasons).toContain('missing-citation');

    const aiUrl = 'https://chatgpt.com/share/valuation';
    const ai = validateGroundedResearch(payload([metric({
      sources: [{
        ...(metric().sources[0] as object),
        url: aiUrl,
      }],
    })]), REQUEST, [aiUrl], NOW);
    expect(ai.metrics).toEqual([]);
    expect(ai.rejectedReasons).toContain('ai-generated-source');
  });

  it('rejects duplicate/conflicting sources instead of silently averaging', () => {
    const secondUrl = 'https://www.reuters.com/markets/companies/NVTS.OQ';
    const source = metric().sources[0];
    const result = validateGroundedResearch(payload([metric({
      sources: [
        source,
        { ...source },
        {
          ...source,
          url: secondUrl,
          publisher: 'Reuters',
          evidence: 'NVTS FY2027 revenue consensus is 1.40 billion USD.',
          reportedValue: 1_400_000_000,
        },
      ],
    })]), REQUEST, [URL, secondUrl], NOW);
    expect(result.metrics).toEqual([]);
    expect(result.rejectedReasons).toEqual(expect.arrayContaining([
      'duplicate-source',
      'conflicting-sources',
    ]));

    const duplicateMetric = validateGroundedResearch(
      payload([metric(), metric({ value: 1_250_000_000 })]),
      REQUEST,
      [URL],
      NOW,
    );
    expect(duplicateMetric.metrics).toEqual([]);
    expect(duplicateMetric.rejectedReasons).toContain('conflicting-sources');
  });

  it('rejects missing grounding and schema fields that could smuggle an AI valuation', () => {
    expect(validateGroundedResearch(payload(), REQUEST, [], NOW))
      .toMatchObject({ metrics: [], rejectedReasons: ['missing-grounding'] });
    expect(validateGroundedResearch(payload([metric()], { fairValue: 99 }), REQUEST, [URL], NOW))
      .toMatchObject({ metrics: [], rejectedReasons: ['invalid-json'] });
  });

  it('accepts an authoritative market-level risk-free rate with no ticker', () => {
    const marketRequest: GroundedResearchRequest = {
      symbols: [],
      metrics: ['riskFreeRate'],
      fiscalYears: [2026],
    };
    const candidate = metric({
      symbol: null,
      metric: 'riskFreeRate',
      fiscalYear: 2026,
      periodEnd: '2026-07-24',
      value: 0.043,
      unit: 'decimal',
      analystCount: null,
      forward: false,
      consensus: false,
      sources: [{
        url: TREASURY_URL,
        publisher: 'U.S. Department of the Treasury',
        publishedAt: '2026-07-24',
        evidence: 'The 10-year U.S. Treasury rate was published as 4.30 percent on July 24, 2026.',
        reportedValue: 0.043,
        currency: 'USD',
        unit: 'decimal',
      }],
    });
    const result = validateGroundedResearch(
      payload([candidate]),
      marketRequest,
      [TREASURY_URL],
      NOW,
    );
    expect(result.metrics[0]).toMatchObject({
      symbol: null,
      field: 'riskFreeRate',
      value: 0.043,
      unit: 'decimal',
      confidence: 'high',
    });
  });

  it('requires two independent reputable sources for a non-primary critical value', () => {
    const marketRequest: GroundedResearchRequest = {
      symbols: [],
      metrics: ['equityRiskPremium'],
      fiscalYears: [2026],
    };
    const candidate = metric({
      symbol: null,
      metric: 'equityRiskPremium',
      fiscalYear: 2026,
      periodEnd: '2026-07-24',
      value: 0.05,
      unit: 'decimal',
      analystCount: null,
      forward: false,
      consensus: false,
      sources: [{
        url: URL,
        publisher: 'Nasdaq',
        publishedAt: '2026-07-24',
        evidence: 'The published U.S. equity risk premium was 5.00 percent on July 24, 2026.',
        reportedValue: 0.05,
        currency: 'USD',
        unit: 'decimal',
      }],
    });
    const result = validateGroundedResearch(payload([candidate]), marketRequest, [URL], NOW);
    expect(result.metrics).toEqual([]);
    expect(result.rejectedReasons).toContain('insufficient-evidence');
  });
});

describe('grounded research cache and rate-limit safety', () => {
  it('uses one single-flight call and then the positive cache', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const generate = vi.fn(async () => {
      await gate;
      return { payload: payload(), groundingUrls: [URL] };
    });
    const service = new GroundedFinancialResearchService(generate, () => NOW);
    const first = service.research(REQUEST);
    const second = service.research(REQUEST);
    release();
    const [left, right] = await Promise.all([first, second]);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(left.metrics).toEqual(right.metrics);
    expect((await service.research(REQUEST)).cache).toBe('hit');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('negative-caches invalid evidence and avoids a retry storm', async () => {
    const generate = vi.fn(async () => ({ payload: { invalid: true }, groundingUrls: [URL] }));
    const service = new GroundedFinancialResearchService(generate, () => NOW);
    expect((await service.research(REQUEST)).cache).toBe('negative');
    expect((await service.research(REQUEST)).cache).toBe('negative');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('shares the market-level cache across ticker-independent requests', async () => {
    const request: GroundedResearchRequest = {
      symbols: [],
      metrics: ['riskFreeRate'],
      fiscalYears: [2026],
    };
    const marketPayload = payload([metric({
      symbol: null,
      metric: 'riskFreeRate',
      fiscalYear: 2026,
      periodEnd: '2026-07-24',
      value: 0.043,
      unit: 'decimal',
      analystCount: null,
      forward: false,
      consensus: false,
      sources: [{
        url: TREASURY_URL,
        publisher: 'U.S. Department of the Treasury',
        publishedAt: '2026-07-24',
        evidence: 'The 10-year U.S. Treasury rate was published as 4.30 percent on July 24, 2026.',
        reportedValue: 0.043,
        currency: 'USD',
        unit: 'decimal',
      }],
    })]);
    const generate = vi.fn(async () => ({
      payload: marketPayload,
      groundingUrls: [TREASURY_URL],
    }));
    const service = new GroundedFinancialResearchService(generate, () => NOW);

    expect((await service.research(request)).cache).toBe('miss');
    expect((await service.research({ ...request, symbols: [] })).cache).toBe('hit');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('bounds a 429 retry and returns unavailable without a fake value', async () => {
    const generate = vi.fn(async () => {
      throw Object.assign(new Error('rate limited'), { status: 429 });
    });
    const sleep = vi.fn(async () => undefined);
    const service = new GroundedFinancialResearchService(generate, () => NOW, sleep);
    const result = await service.research(REQUEST);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      metrics: [],
      cache: 'negative',
      unavailableReason: 'gemini-rate-limited',
    });
  });

  it('bounds timeouts and exposes unavailable rather than model memory', async () => {
    const generate = vi.fn(async () => { throw new Error('request timeout'); });
    const service = new GroundedFinancialResearchService(
      generate,
      () => NOW,
      async () => undefined,
    );
    const result = await service.research(REQUEST);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.metrics).toEqual([]);
    expect(result.unavailableReason).toBe('gemini-timeout');
  });
});
