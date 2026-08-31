import { describe, expect, it } from 'vitest';
import {
  OV_MARKET_EVENTS,
  ovBangkokDayKey,
  ovEventCountdownDays,
  ovEventDayLabel,
  ovEventCalendar,
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

describe('ovEventCalendar', () => {
  const now = '2026-09-11T00:00:00.000Z';

  /**
   * The requirement this block exists for: ADDING A ROW IS EDITING THE FILE.
   *
   * `fixture` is a stand-in for `market-events.json`. Every case below hands it
   * to the calendar unchanged — no horizon, no cap, no constant — so a case that
   * appends a row is doing exactly what an editor of the JSON does.
   */
  const fixture = [
    event('sep', '2026-09-15T12:30:00.000Z'),
    event('dec', '2026-12-31T13:30:00.000Z'),
  ];

  it('opens on today', () => {
    const calendar = ovEventCalendar({ now, events: [] });
    expect(calendar!.fromDayKey).toBe('2026-09-11');
  });

  it('keeps an event happening later today and drops the one before it', () => {
    const calendar = ovEventCalendar({
      now,
      events: [
        event('yesterday', '2026-09-10T12:30:00.000Z'),
        event('tonight', '2026-09-11T12:30:00.000Z'),
      ],
    });
    expect(calendar!.events.map((item) => item.id)).toEqual(['tonight']);
  });

  it('has no far edge — a row years out is still in the list', () => {
    /*
      The twelve-month window used to cut this, which meant the calendar had a
      ceiling written in TypeScript. A date is either in the file or it is not.
    */
    const calendar = ovEventCalendar({
      now,
      events: [
        event('soon', '2026-10-01T12:30:00.000Z'),
        event('far', '2030-01-15T13:30:00.000Z'),
      ],
    });
    expect(calendar!.events.map((item) => item.id)).toEqual(['soon', 'far']);
  });

  it('shows a row added for January 2027 without a code change', () => {
    // The whole requirement, as one case: append to the fixture, and the row is
    // in the output. Nothing else moved.
    const before = ovEventCalendar({ now, events: fixture });
    expect(before!.events.map((item) => item.id)).toEqual(['sep', 'dec']);

    const extended = [...fixture, event('jan-2027', '2027-01-14T13:30:00.000Z')];
    const after = ovEventCalendar({ now, events: extended });
    expect(after!.events.map((item) => item.id)).toEqual(['sep', 'dec', 'jan-2027']);
  });

  it('moves coversThrough and lastDayKey with the file, not with a constant', () => {
    /*
      Read from a day AFTER the fixture runs out. The calendar is then exhausted
      and says so; appending one January row makes it cover again, and the last
      day it names is that row's own day.
    */
    const later = '2027-01-05T00:00:00.000Z';
    const exhausted = ovEventCalendar({ now: later, events: fixture });
    expect(exhausted!.coversThrough).toBe(false);
    expect(exhausted!.lastDayKey).toBe('2026-12-31');
    expect(exhausted!.events).toEqual([]);

    const extended = [...fixture, event('jan-2027', '2027-01-14T13:30:00.000Z')];
    const covered = ovEventCalendar({ now: later, events: extended });
    expect(covered!.coversThrough).toBe(true);
    expect(covered!.lastDayKey).toBe('2027-01-14');
    expect(covered!.events.map((item) => item.id)).toEqual(['jan-2027']);
  });

  it('names the last day the file reaches even when it is already past', () => {
    const calendar = ovEventCalendar({
      now: '2027-06-01T00:00:00.000Z',
      events: fixture,
    });
    expect(calendar!.lastDayKey).toBe('2026-12-31');
    expect(calendar!.coversThrough).toBe(false);
  });

  it('finds the last day without trusting the input to be sorted', () => {
    const calendar = ovEventCalendar({
      now,
      events: [
        event('later', '2026-12-31T13:30:00.000Z'),
        event('earlier', '2026-09-15T12:30:00.000Z'),
      ],
    });
    expect(calendar!.lastDayKey).toBe('2026-12-31');
  });

  it('says the calendar is empty rather than pretending it is quiet', () => {
    const calendar = ovEventCalendar({ now, events: [] });
    expect(calendar!.events).toEqual([]);
    expect(calendar!.lastDayKey).toBeNull();
    expect(calendar!.coversThrough).toBe(false);
  });

  it('sorts soonest first', () => {
    const calendar = ovEventCalendar({
      now,
      events: [
        event('a', '2026-09-15T12:30:00.000Z'),
        event('b', '2026-11-15T12:30:00.000Z'),
        event('c', '2026-10-15T12:30:00.000Z'),
      ],
    });
    expect(calendar!.events.map((item) => item.id)).toEqual(['a', 'c', 'b']);
  });

  it('is null when the clock itself is unreadable', () => {
    expect(ovEventCalendar({ now: 'nonsense', events: [] })).toBeNull();
  });

  it('still answers to the old name, so the page keeps compiling', () => {
    // `app/page.tsx` imports `ovEventWindow`. The alias is the whole of what is
    // left of the window.
    expect(ovEventWindow).toBe(ovEventCalendar);
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
