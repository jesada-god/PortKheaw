import { describe, expect, it } from 'vitest';
import { buildFinnhubSubscriptionFrame, normalizeFinnhubMessage, normalizeFinnhubMessageWithDiagnostics } from './finnhub-normalize';

describe('Finnhub normalization', () => {
  it('maps real wire fields to validated provider-timestamped trades', () => {
    const [trade] = normalizeFinnhubMessage({
      type: 'trade',
      data: [{ s: 'nvda', p: 187.5, v: 25, t: Date.UTC(2026, 6, 24, 14, 0), c: ['1'] }],
    });
    expect(trade).toMatchObject({
      symbol: 'NVDA', price: 187.5, size: 25, provider: 'finnhub', session: 'regular',
    });
    expect(trade.tradeId).toContain('NVDA:');
  });

  it('rejects malformed rows without discarding valid siblings', () => {
    const message = {
      type: 'trade',
      data: [
        { s: 'NVDA', p: 0, v: 2, t: 1 },
        { s: 'NVDA', p: 187.5, v: 2, t: Date.UTC(2026, 6, 24, 14, 0) },
      ],
    };
    expect(normalizeFinnhubMessage(message)).toHaveLength(1);
    expect(normalizeFinnhubMessageWithDiagnostics(message)).toMatchObject({
      rejected: [{ symbol: 'NVDA', reason: 'invalid' }],
      observedSymbols: ['NVDA', 'NVDA'],
    });
  });

  it('builds one provider subscription frame per symbol', () => {
    expect(JSON.parse(buildFinnhubSubscriptionFrame('subscribe', ' nvda ')))
      .toEqual({ type: 'subscribe', symbol: 'NVDA' });
  });
});
