import { describe, expect, it } from 'vitest';
import {
  OV_EVENT_WINDOW_MONTHS,
  OV_MARKET_EVENTS,
  ovBangkokDayKey,
  ovEventCountdownDays,
  ovEventDayLabel,
  ovEventWindow,
  type OvMarketEvent,
} from './events';

function event(id: string, startsAtUtc: string): OvMarketEvent {
  return { id, code: 'CPI', titleTh: 'เงินเฟ้อผู้บริโภค', importance: 'high', startsAtUtc };
}

describe('ovBangkokDayKey', () => {
  it('resolves an instant to the Bangkok calendar day, not the host\'s', () => {
    // 17:30 UTC is 00:30 the NEXT day in Bangkok. A host-local `getDate()` on a
    // UTC server answers with the earlier day, which is the whole bug.
    expect(ovBangkokDayKey('2026-09-11T17:30:00.000Z')).toBe('2026-09-12');
    expect(ovBangkokDayKey('2026-09-11T12:30:00.000Z')).toBe('2026-09-11');
  });

  it('is null for an unreadable instant', () => {
    expect(ovBangkokDayKey('not a date')).toBeNull();
  });
});

describe('ovEventCountdownDays', () => {
  const now = '2026-09-11T00:00:00.000Z'; // 07:00 in Bangkok on the 11th.

  it('counts calendar days, not elapsed hours', () => {
    /*
      A release at 19:30 Bangkok tonight is "วันนี้", twelve and a half hours
      away. `(then - now) / 86_400_000` would floor to 0 here and to 0 for
      something 23 hours out as well, which is the next day.
    */
    expect(ovEventCountdownDays('2026-09-11T12:30:00.000Z', now)).toBe(0);
    expect(ovEventCountdownDays('2026-09-11T17:30:00.000Z', now)).toBe(1);
  });

  it('counts a full day ahead as one', () => {
    expect(ovEventCountdownDays('2026-09-12T12:30:00.000Z', now)).toBe(1);
    expect(ovEventCountdownDays('2026-09-18T12:30:00.000Z', now)).toBe(7);
  });

  it('goes negative for something that already happened', () => {
    expect(ovEventCountdownDays('2026-09-10T12:30:00.000Z', now)).toBe(-1);
  });

  it('crosses a month and a year boundary by the calendar', () => {
    expect(ovEventCountdownDays('2026-10-01T12:30:00.000Z', now)).toBe(20);
    expect(ovEventCountdownDays('2027-09-11T12:30:00.000Z', now)).toBe(365);
  });

  it('is null rather than zero when either instant is unreadable', () => {
    // Zero means "today", which is a claim. A caller must render no countdown.
    expect(ovEventCountdownDays('nonsense', now)).toBeNull();
    expect(ovEventCountdownDays('2026-09-11T12:30:00.000Z', 'nonsense')).toBeNull();
  });
});

describe('ovEventWindow', () => {
  const now = '2026-09-11T00:00:00.000Z';

  it('opens on today and closes twelve months later', () => {
    const window = ovEventWindow({ now, events: [] });
    expect(window!.fromDayKey).toBe('2026-09-11');
    expect(window!.toDayKey).toBe('2027-09-11');
    expect(OV_EVENT_WINDOW_MONTHS).toBe(12);
  });

  it('keeps an event happening later today and drops yesterday\'s', () => {
    const window = ovEventWindow({
      now,
      events: [
        event('yesterday', '2026-09-10T12:30:00.000Z'),
        event('tonight', '2026-09-11T12:30:00.000Z'),
      ],
    });
    expect(window!.events.map((item) => item.id)).toEqual(['tonight']);
  });

  it('drops an event past the far edge', () => {
    const window = ovEventWindow({
      now,
      events: [
        event('inside', '2027-09-10T12:30:00.000Z'),
        event('outside', '2027-09-12T12:30:00.000Z'),
      ],
    });
    expect(window!.events.map((item) => item.id)).toEqual(['inside']);
  });

  it('reports that the calendar stops short, and names the date it reaches', () => {
    /*
      FALSE is the common case and must be rendered. A run of empty months is
      perfectly drawable and tells a reader nothing is scheduled, which is the
      opposite of what is true.
    */
    const window = ovEventWindow({
      now,
      events: [event('last', '2026-12-31T13:30:00.000Z')],
    });
    expect(window!.coversThrough).toBe(false);
    expect(window!.lastDayKey).toBe('2026-12-31');
  });

  it('reports full coverage when the file reaches the far edge', () => {
    const window = ovEventWindow({
      now,
      events: [event('a', '2026-10-01T12:30:00.000Z'), event('b', '2027-10-01T12:30:00.000Z')],
    });
    expect(window!.coversThrough).toBe(true);
  });

  it('says the calendar is empty rather than pretending it is quiet', () => {
    const window = ovEventWindow({ now, events: [] });
    expect(window!.events).toEqual([]);
    expect(window!.lastDayKey).toBeNull();
    expect(window!.coversThrough).toBe(false);
  });

  it('sorts soonest first', () => {
    const window = ovEventWindow({
      now,
      events: [
        event('a', '2026-09-15T12:30:00.000Z'),
        event('b', '2026-11-15T12:30:00.000Z'),
        event('c', '2026-10-15T12:30:00.000Z'),
      ],
    });
    expect(window!.events.map((item) => item.id)).toEqual(['a', 'c', 'b']);
  });

  it('clamps the far edge onto a shorter month', () => {
    // 31 August plus twelve months is 31 August, but the clamp matters on the
    // months that are short — 31 March + 11 must not roll into 1 March.
    const window = ovEventWindow({ now: '2026-03-31T00:00:00.000Z', months: 11, events: [] });
    expect(window!.toDayKey).toBe('2027-02-28');
  });

  it('is null when the clock itself is unreadable', () => {
    expect(ovEventWindow({ now: 'nonsense', events: [] })).toBeNull();
  });
});

describe('the shipped calendar', () => {
  it('parses, and every row carries a Z instant', () => {
    expect(OV_MARKET_EVENTS.length).toBeGreaterThan(0);
    for (const item of OV_MARKET_EVENTS) {
      expect(item.startsAtUtc.endsWith('Z'), item.id).toBe(true);
    }
  });

  it('is sorted soonest first', () => {
    const instants = OV_MARKET_EVENTS.map((item) => item.startsAtUtc);
    expect(instants).toEqual([...instants].sort());
  });

  it('carries no symbol list — the join is made at read time', () => {
    /*
      A symbol written next to a release ages silently: the reader sells the
      stock and the file still claims the release affects them.
    */
    for (const item of OV_MARKET_EVENTS) {
      expect(Object.keys(item).sort())
        .toEqual(['code', 'id', 'importance', 'startsAtUtc', 'titleTh']);
    }
  });

  it('labels a day through the shared Thai formatter', () => {
    const label = ovEventDayLabel(event('cpi-1', '2026-09-11T12:30:00.000Z'));
    expect(label).not.toBe('—');
    expect(label).toContain('2569'); // th-TH is Buddhist-era by default.
  });
});
