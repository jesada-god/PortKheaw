import { describe, expect, it } from 'vitest';
import {
  OV_EVENT_SCOPE,
  OV_EVENT_SYMBOL_LIMIT,
  ovEventRelevance,
  ovEventRelevanceFor,
} from './event-relevance';
import { ovEventCodeSchema, type OvMarketEvent } from './events';

function event(id: string, code: OvMarketEvent['code'] = 'CPI'): OvMarketEvent {
  return {
    id,
    code,
    titleTh: 'เงินเฟ้อผู้บริโภค',
    importance: 'high',
    startsAtUtc: '2026-09-11T12:30:00.000Z',
  };
}

describe('the scope table', () => {
  it('covers every code the calendar can contain', () => {
    expect(Object.keys(OV_EVENT_SCOPE).sort()).toEqual([...ovEventCodeSchema.options].sort());
  });

  it('calls all seven market-wide, which is what they measure', () => {
    expect(Object.values(OV_EVENT_SCOPE).every((scope) => scope === 'market-wide')).toBe(true);
  });
});

describe('ovEventRelevance', () => {
  it('merges the reader\'s two lists and counts a shared symbol once', () => {
    const relevance = ovEventRelevance(event('cpi-1'), {
      portfolioSymbols: ['AAPL', 'MSFT'],
      watchlistSymbols: ['MSFT', 'NVDA'],
    });
    expect(relevance.affectedSymbols).toEqual(['AAPL', 'MSFT', 'NVDA']);
    expect(relevance.total).toBe(3);
  });

  it('normalizes case and whitespace, because the list is a join key', () => {
    const relevance = ovEventRelevance(event('cpi-1'), {
      portfolioSymbols: [' aapl ', 'AAPL'],
      watchlistSymbols: ['msft'],
    });
    expect(relevance.affectedSymbols).toEqual(['AAPL', 'MSFT']);
  });

  it('drops empty entries rather than listing a blank symbol', () => {
    const relevance = ovEventRelevance(event('cpi-1'), { portfolioSymbols: ['', '   ', 'AAPL'] });
    expect(relevance.affectedSymbols).toEqual(['AAPL']);
    expect(relevance.total).toBe(1);
  });

  it('sorts alphabetically and not by any notion of importance', () => {
    /*
      Ordering by position size or by how much each symbol "reacts" would be the
      ranking this feature refuses — and the second of those is not something
      the product measures at all.
    */
    const relevance = ovEventRelevance(event('cpi-1'), {
      portfolioSymbols: ['NVDA', 'AAPL', 'MSFT'],
    });
    expect(relevance.affectedSymbols).toEqual(['AAPL', 'MSFT', 'NVDA']);
  });

  it('caps the list but reports the full count', () => {
    const many = Array.from({ length: 20 }, (_, index) => `SYM${String(index).padStart(2, '0')}`);
    const relevance = ovEventRelevance(event('cpi-1'), { portfolioSymbols: many });
    expect(relevance.affectedSymbols).toHaveLength(OV_EVENT_SYMBOL_LIMIT);
    expect(relevance.total).toBe(20);
  });

  it('answers honestly for a reader who holds nothing', () => {
    // The release still happens. A signed-out visitor is entitled to see it.
    const relevance = ovEventRelevance(event('cpi-1'), {});
    expect(relevance.affectedSymbols).toEqual([]);
    expect(relevance.total).toBe(0);
    expect(relevance.scope).toBe('market-wide');
  });

  it('carries the event id so a row can find its own relevance', () => {
    expect(ovEventRelevance(event('fomc-3', 'FOMC'), {}).eventId).toBe('fomc-3');
  });
});

describe('ovEventRelevanceFor', () => {
  it('gives every event in the window the same list, in the same order', () => {
    /*
      Twelve months of jobless-claims rows would otherwise be forty passes over
      the reader's holdings. One pass, one list, and every row provably names
      the same symbols.
    */
    const events = [event('a'), event('b', 'NFP'), event('c', 'FOMC')];
    const map = ovEventRelevanceFor(events, {
      portfolioSymbols: ['NVDA', 'AAPL'],
      watchlistSymbols: ['MSFT'],
    });
    expect([...map.keys()]).toEqual(['a', 'b', 'c']);
    for (const id of ['a', 'b', 'c']) {
      expect(map.get(id)!.affectedSymbols).toEqual(['AAPL', 'MSFT', 'NVDA']);
      expect(map.get(id)!.total).toBe(3);
    }
  });

  it('agrees with the single-event form', () => {
    const one = event('cpi-1');
    const symbols = { portfolioSymbols: ['AAPL', 'MSFT'], watchlistSymbols: ['NVDA'] };
    expect(ovEventRelevanceFor([one], symbols).get('cpi-1')).toEqual(ovEventRelevance(one, symbols));
  });

  it('returns an empty map for an empty window', () => {
    expect(ovEventRelevanceFor([], { portfolioSymbols: ['AAPL'] }).size).toBe(0);
  });
});
