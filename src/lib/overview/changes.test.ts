import { describe, expect, it } from 'vitest';
import { buildOverviewChanges, NOTABLE_MOVE_PERCENT } from './changes';
import type { OverviewPrice } from './types';

function row(symbol: string, changePercent: number | null): OverviewPrice {
  return {
    symbol,
    instrument: {
      symbol,
      companyName: symbol,
      exchange: 'NASDAQ',
      assetType: 'Stock',
      currency: 'USD',
      sector: null,
      industry: null,
      websiteDomain: null,
      logoUrl: null,
      metadataSource: 'test',
      updatedAt: null,
    },
    price: 100,
    currency: 'USD',
    change: changePercent,
    changePercent,
    session: 'CLOSED',
    sessionLabel: 'ราคาช่วงตลาดปกติ',
    status: changePercent === null ? 'unavailable' : 'closed',
    asOf: null,
    tradingDate: null,
    extended: null,
    freshness: null,
    sparkline: [],
  };
}

describe('buildOverviewChanges', () => {
  it('raises a move at the threshold and leaves the one below it alone', () => {
    const changes = buildOverviewChanges([
      row('NVDA', NOTABLE_MOVE_PERCENT),
      row('AAPL', NOTABLE_MOVE_PERCENT - 0.01),
    ]);
    expect(changes.map((change) => change.symbol)).toEqual(['NVDA']);
  });

  it('reads a fall the same distance out as a rise', () => {
    const changes = buildOverviewChanges([row('RKLB', -NOTABLE_MOVE_PERCENT)]);
    expect(changes).toHaveLength(1);
    expect(changes[0].level).toBe('bad');
    expect(changes[0].text).toBe('RKLB ลงแรง -4.0%');
  });

  it('says a rise in the words the vocabulary allows', () => {
    expect(buildOverviewChanges([row('NVDA', 6.42)])[0].text).toBe('NVDA ขึ้นแรง +6.4%');
  });

  /*
   * The distinction the whole module turns on. A row whose quote never arrived
   * carries `changePercent: null`, and treating that as a zero would file it
   * under "did not move" — which is a claim about the market made from a
   * failure to reach it.
   */
  it('never reads a missing quote as a stock that did not move', () => {
    const changes = buildOverviewChanges([row('META', null), row('TSLA', 0)]);
    expect(changes).toEqual([]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'drops %p rather than letting it through the threshold',
    (value) => {
      expect(buildOverviewChanges([row('BAD', value)])).toEqual([]);
    },
  );

  it('leads with the biggest move, whichever way it went', () => {
    const changes = buildOverviewChanges([
      row('AAPL', 4.5),
      row('NVDA', -9.2),
      row('RKLB', 6.1),
    ]);
    expect(changes.map((change) => change.symbol)).toEqual(['NVDA', 'RKLB', 'AAPL']);
  });

  it('caps the list so a volatile day cannot become the whole page', () => {
    const rows = ['A', 'B', 'C', 'D', 'E', 'F'].map((symbol, index) => row(symbol, 10 + index));
    expect(buildOverviewChanges(rows)).toHaveLength(4);
    expect(buildOverviewChanges(rows, { limit: 2 })).toHaveLength(2);
  });

  /*
   * An empty result on a quiet day is the CORRECT answer, and the section is
   * required to disappear rather than announce it. This asserts the shape the
   * component's `length > 0` guard depends on.
   */
  it('returns nothing at all when nothing moved', () => {
    expect(buildOverviewChanges([row('AAPL', 0.4), row('MSFT', -1.1)])).toEqual([]);
    expect(buildOverviewChanges([])).toEqual([]);
  });

  it('gives every line a key that is stable and unique per symbol', () => {
    const changes = buildOverviewChanges([row('AAPL', 5), row('NVDA', 6)]);
    const ids = changes.map((change) => change.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(buildOverviewChanges([row('AAPL', 5)])[0].id).toBe('move:AAPL');
  });

  it('prints no null, undefined or NaN in any line it produces', () => {
    const changes = buildOverviewChanges([row('AAPL', 5.55), row('NVDA', -12.349)]);
    for (const change of changes) {
      expect(change.text).not.toMatch(/undefined|null|NaN|Infinity/);
    }
  });
});
