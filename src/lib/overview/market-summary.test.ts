import { describe, expect, it } from 'vitest';
import { buildMarketSummary } from './market-summary';
import type { MarketIndexCard } from './types';

function card(symbol: string, changePercent: number | null): MarketIndexCard {
  return {
    symbol,
    name: symbol,
    proxyLabel: 'ETF อ้างอิง',
    subtitle: `${symbol} · ETF อ้างอิง`,
    instrument: {
      symbol,
      companyName: symbol,
      exchange: 'NYSE',
      assetType: 'ETF',
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

const both = (sp: number | null, nasdaq: number | null) => [card('SPY', sp), card('QQQ', nasdaq)];

describe('buildMarketSummary', () => {
  it('says so plainly when both indices agree', () => {
    expect(buildMarketSummary(both(0.8, 1.2))).toEqual({
      level: 'good',
      text: 'ทั้ง S&P 500 และ NASDAQ ขึ้น',
    });
    expect(buildMarketSummary(both(-0.8, -1.2))).toEqual({
      level: 'bad',
      text: 'ทั้ง S&P 500 และ NASDAQ ลง',
    });
  });

  /*
   * The case the whole line exists for. Two broad indices pulling apart is the
   * day a reader most needs to look closer at, so it gets 🟠 and it names which
   * way each one went — an averaged "ตลาดทรงตัว" would have hidden it.
   */
  it('marks a disagreement more loudly than a quiet day', () => {
    const split = buildMarketSummary(both(0.9, -1.4))!;
    expect(split.level).toBe('weak');
    expect(split.text).toContain('S&P 500 ขึ้น');
    expect(split.text).toContain('NASDAQ ลง');
    expect(split.text).toContain('สองดัชนีไปคนละทาง');

    expect(buildMarketSummary(both(0.02, -0.03))!.level).toBe('neutral');
  });

  /*
   * A tenth of a percent is the index standing still. The band is symmetric, so
   * nothing is called rising at +0.1% that would not be called falling at -0.1%.
   */
  it('does not call a tenth of a percent a direction', () => {
    expect(buildMarketSummary(both(0.1, 0.1))!.text).toBe('ทั้งสองดัชนีทรงตัว');
    expect(buildMarketSummary(both(-0.1, -0.1))!.text).toBe('ทั้งสองดัชนีทรงตัว');
    expect(buildMarketSummary(both(0.11, 0.11))!.level).toBe('good');
    expect(buildMarketSummary(both(-0.11, -0.11))!.level).toBe('bad');
  });

  it('speaks for one index only when the other could not be read', () => {
    const summary = buildMarketSummary(both(1.4, null))!;
    expect(summary.text).toBe('S&P 500 ขึ้น · อีกดัชนียังไม่มีข้อมูล');
    expect(buildMarketSummary(both(null, -2.2))!.text)
      .toBe('NASDAQ ลง · อีกดัชนียังไม่มีข้อมูล');
  });

  it('draws no line at all when neither index could be read', () => {
    expect(buildMarketSummary(both(null, null))).toBeNull();
    expect(buildMarketSummary([])).toBeNull();
    expect(buildMarketSummary(both(Number.NaN, Number.NaN))).toBeNull();
  });

  it('ignores the other assets in the section', () => {
    // Dow, Russell, gold and Bitcoin are all on this page, and none of them
    // gets a vote: the line is about the two broad US equity indices.
    const summary = buildMarketSummary([
      card('DIA', -9),
      card('IWM', -9),
      card('GC-F', 9),
      ...both(0.7, 0.9),
    ])!;
    expect(summary.level).toBe('good');
  });

  it('never prints a percentage', () => {
    /*
     * The percentages are on the cards directly underneath, so repeating them
     * here would make the summary a second, smaller copy of the row it
     * introduces. Checked as "no percent sign and no decimal figure" rather than
     * "no digits": the index is called S&P 500, and that 500 is its name.
     */
    for (const pair of [both(3.21, 1.5), both(-3.21, 1.5), both(0, 0), both(1.4, null)]) {
      const { text } = buildMarketSummary(pair)!;
      expect(text).not.toContain('%');
      expect(text).not.toMatch(/\d+\.\d/);
    }
  });
});
