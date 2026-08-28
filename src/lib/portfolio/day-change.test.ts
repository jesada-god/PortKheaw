import { describe, expect, it } from 'vitest';
import {
  combineDayChangeSources,
  dayChangePerUnit,
  resolveDayChangeBasis,
  type DayChangeBasis,
} from './day-change';

const snapshot = { date: '2025-08-22', close: 110, prevClose: 100, source: 'polygon' };

describe('resolveDayChangeBasis — while the market is OPEN', () => {
  it('uses the live price against the quote’s own previous close', () => {
    expect(resolveDayChangeBasis({
      session: 'OPEN', price: 120, previousClose: 100, snapshot,
    })).toEqual({
      close: 120, prevClose: 100, sessionDate: null, source: 'live', provider: null,
    });
  });

  it('borrows only the EARLIER half from the snapshot when the quote omits it', () => {
    /*
      The live price stays the later half. Swapping in the whole snapshot pair
      would replace a moving figure with a finished one during a session the
      reader is watching — the opposite of what the OPEN rule is for.
    */
    expect(resolveDayChangeBasis({
      session: 'OPEN', price: 120, previousClose: null, snapshot,
    })).toEqual({
      close: 120, prevClose: 110, sessionDate: null, source: 'live', provider: null,
    });
  });

  it('falls back to the snapshot pair when there is no live price at all', () => {
    expect(resolveDayChangeBasis({
      session: 'OPEN', price: null, previousClose: 100, snapshot,
    })).toEqual({
      close: 110, prevClose: 100, sessionDate: '2025-08-22', source: 'snapshot', provider: 'polygon',
    });
  });

  it('is null when neither source can produce two prices', () => {
    expect(resolveDayChangeBasis({
      session: 'OPEN', price: 120, previousClose: null, snapshot: null,
    })).toBeNull();
  });
});

describe('resolveDayChangeBasis — outside the session', () => {
  it.each(['PRE_MARKET', 'AFTER_HOURS', 'CLOSED'] as const)(
    'prefers the captured close over the live quote in %s',
    (session) => {
      /*
        The live pair is present AND usable here, and is still not chosen: once
        the bell has rung there is no "today's move" left in a moving price, and
        the honest figure is the one the session ended with.
      */
      expect(resolveDayChangeBasis({
        session, price: 999, previousClose: 500, snapshot,
      })).toEqual({
        close: 110, prevClose: 100, sessionDate: '2025-08-22', source: 'snapshot', provider: 'polygon',
      });
    },
  );

  it('falls back to the live pair in the gap before the capture job runs', () => {
    // 16:00–16:10 ET: the bell has rung but nothing is captured yet. An
    // after-hours quote still reporting a previous close describes the session
    // that just ended, so refusing it would blank the figure for ten minutes.
    expect(resolveDayChangeBasis({
      session: 'AFTER_HOURS', price: 120, previousClose: 100, snapshot: null,
    })).toEqual({
      close: 120, prevClose: 100, sessionDate: null, source: 'live', provider: null,
    });
  });

  it('ignores a snapshot whose previous close is missing and uses the live pair', () => {
    expect(resolveDayChangeBasis({
      session: 'CLOSED',
      price: 120,
      previousClose: 100,
      snapshot: { date: '2025-08-22', close: 110, prevClose: null, source: 'polygon' },
    })).toEqual({
      close: 120, prevClose: 100, sessionDate: null, source: 'live', provider: null,
    });
  });

  it('is null when the snapshot has no previous close and no live pair exists', () => {
    expect(resolveDayChangeBasis({
      session: 'CLOSED',
      price: 120,
      previousClose: null,
      snapshot: { date: '2025-08-22', close: 110, prevClose: null, source: 'polygon' },
    })).toBeNull();
  });
});

describe('resolveDayChangeBasis — what counts as a usable price', () => {
  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects %p as a price rather than computing with it',
    (value) => {
      expect(resolveDayChangeBasis({
        session: 'OPEN', price: value, previousClose: 100, snapshot: null,
      })).toBeNull();
    },
  );

  it('rejects a non-positive previous close, which would make the percent meaningless', () => {
    expect(resolveDayChangeBasis({
      session: 'OPEN', price: 120, previousClose: 0, snapshot: null,
    })).toBeNull();
  });

  it('rejects a snapshot with a non-positive close', () => {
    expect(resolveDayChangeBasis({
      session: 'CLOSED',
      price: null,
      snapshot: { date: '2025-08-22', close: 0, prevClose: 100, source: 'polygon' },
    })).toBeNull();
  });
});

describe('dayChangePerUnit', () => {
  it('is the signed difference, and is genuinely zero for an unchanged price', () => {
    // Zero here is a real reading — the price did not move — as distinct from
    // the null a missing basis produces. The two must never collapse.
    expect(dayChangePerUnit({
      close: 110, prevClose: 100, sessionDate: null, source: 'live', provider: null,
    })).toBe(10);
    expect(dayChangePerUnit({
      close: 100, prevClose: 100, sessionDate: null, source: 'live', provider: null,
    })).toBe(0);
    expect(dayChangePerUnit({
      close: 90, prevClose: 100, sessionDate: null, source: 'live', provider: null,
    })).toBe(-10);
  });
});

describe('combineDayChangeSources', () => {
  const live: DayChangeBasis = {
    close: 1, prevClose: 1, sessionDate: null, source: 'live', provider: null,
  };
  const captured = (date: string): DayChangeBasis => ({
    close: 1, prevClose: 1, sessionDate: date, source: 'snapshot', provider: 'polygon',
  });

  it('is null for an empty list — nothing priced means no source to name', () => {
    expect(combineDayChangeSources([])).toBeNull();
    expect(combineDayChangeSources([null, null])).toBeNull();
  });

  it('reports snapshot with the session date when every part agrees', () => {
    expect(combineDayChangeSources([captured('2025-08-22'), captured('2025-08-22')]))
      .toEqual({ source: 'snapshot', sessionDate: '2025-08-22' });
  });

  it('reports live as soon as any part is still moving', () => {
    // The weaker of the two claims wins: part of the total is a live tick, so
    // captioning the whole thing as a finished close would be false.
    expect(combineDayChangeSources([captured('2025-08-22'), live]))
      .toEqual({ source: 'live', sessionDate: null });
  });

  it('dates a mixed-session total at the OLDEST session present', () => {
    // Never the most recent: a caption may not claim a session more recent than
    // some component of the number actually came from.
    expect(combineDayChangeSources([captured('2025-08-22'), captured('2025-08-21')]))
      .toEqual({ source: 'snapshot', sessionDate: '2025-08-21' });
  });

  it('ignores the absent parts rather than letting them decide', () => {
    expect(combineDayChangeSources([null, captured('2025-08-22'), null]))
      .toEqual({ source: 'snapshot', sessionDate: '2025-08-22' });
  });
});
