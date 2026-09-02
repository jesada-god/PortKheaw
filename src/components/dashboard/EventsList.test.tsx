// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildOverviewEvents } from '@/src/lib/overview/events-feed';
import type { OvEventCalendar, OvMarketEvent } from '@/src/lib/market-overview/events';
import type { UpcomingFeed } from '@/src/lib/upcoming/types';
import { EventsList } from './EventsList';

/**
 * THE EVENTS SECTION, RENDERED.
 *
 * Built through `buildOverviewEvents` rather than from a hand-written view, so
 * what is asserted is what the real pipeline produces — a view literal would
 * have happily carried the seven identical tickers this file exists to keep off
 * the screen.
 */

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: {
    href: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest} onClick={(event) => event.preventDefault()}>{children}</a>
  ),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const NOW = '2026-09-02T09:00:00.000Z';

function macro(id: string, startsAtUtc: string, code: OvMarketEvent['code'] = 'CPI'): OvMarketEvent {
  return { id, code, titleTh: `ตัวเลข ${id}`, importance: 'high', startsAtUtc };
}

function calendarOf(events: OvMarketEvent[], extra: Partial<OvEventCalendar> = {}): OvEventCalendar {
  return {
    events,
    fromDayKey: '2026-09-02',
    coversThrough: true,
    lastDayKey: events.length ? '2026-12-31' : null,
    ...extra,
  };
}

const UPCOMING: UpcomingFeed = {
  events: [
    {
      id: 'expiry:IREN-C',
      kind: 'option-expiry',
      symbol: 'IREN',
      days: 2,
      contractSymbol: 'IREN260904C00030000',
      expirationDate: '2026-09-04',
      text: 'IREN · Call หมดอายุในอีก 2 วัน',
    },
  ],
  total: 1,
};

function render(input: Parameters<typeof buildOverviewEvents>[0]) {
  act(() => root.render(<EventsList view={buildOverviewEvents(input)} />));
  return container;
}

describe('a macro row says how many, never which', () => {
  /*
    THE BUG THIS REPLACES. Every market-wide release carried the same capped,
    alphabetical list of the reader's tickers, printed as links:

        3 ก.ย. 2569 · 19:30 · ASTS CRCL IREN NVDA NVTS ONDS RKLB

    Under a CPI row that reads as "these seven stocks are affected by CPI",
    which `event-relevance.ts` says in its own header it is not claiming. Every
    refusal lived in a comment and none of it was on screen.
  */
  it('prints a count and links no tickers', () => {
    const section = render({
      window: calendarOf([macro('cpi', '2026-09-11T12:30:00.000Z')]),
      upcoming: null,
      watchlistSymbols: ['ASTS', 'CRCL', 'IREN', 'NVDA', 'NVTS', 'ONDS', 'RKLB'],
      now: NOW,
    });
    const row = section.querySelector('[data-testid="overview-event-macro"]')!.parentElement!;
    expect(row.textContent).toContain('7 ตัวในลิสต์คุณ');
    for (const symbol of ['ASTS', 'CRCL', 'IREN', 'NVDA', 'NVTS', 'ONDS', 'RKLB']) {
      expect(row.querySelector(`[data-testid="overview-event-symbol-${symbol}"]`), symbol).toBeNull();
    }
    expect(row.querySelectorAll('a')).toHaveLength(0);
  });

  /*
    "กระทบ" would be the causal claim the relevance module declines to make: a
    CPI print is an economy-wide number, not a prediction about seven names.
  */
  it('claims no effect on any of them', () => {
    const section = render({
      window: calendarOf([macro('cpi', '2026-09-11T12:30:00.000Z')]),
      upcoming: null,
      watchlistSymbols: ['NVDA'],
      now: NOW,
    });
    expect(section.textContent).not.toContain('กระทบ');
  });

  it('draws nothing at all rather than a zero when the reader holds nothing', () => {
    const section = render({
      window: calendarOf([macro('cpi', '2026-09-11T12:30:00.000Z')]),
      upcoming: null,
      now: NOW,
    });
    expect(section.textContent).not.toContain('0 ตัว');
    expect(section.textContent).not.toContain('ตัวในลิสต์คุณ');
  });

  /*
    The date is printed once. `timeLabel` used to carry a `dateStyle` and the
    row joined it to `dayLabel`, printing "3 ก.ย. 2569 · 3 ก.ย. 2569 19:30".
  */
  it('prints the day once and the clock beside it', () => {
    const section = render({
      window: calendarOf([macro('cpi', '2026-09-11T12:30:00.000Z')]),
      upcoming: null,
      now: NOW,
    });
    const meta = section.querySelector('p')!.textContent!;
    expect(meta).toContain('19:30');
    expect(meta.match(/2569/g)).toHaveLength(1);
  });
});

describe('a row about one company keeps its link', () => {
  /*
    An expiry, an earnings date and an alert each belong to a single instrument,
    so the ticker on them is what the row is ABOUT rather than a list of who a
    release might reach. Removing those links would have cost the section its
    only navigation.
  */
  it('links the instrument an expiry belongs to', () => {
    const section = render({ window: calendarOf([]), upcoming: UPCOMING, now: NOW });
    const link = section.querySelector('[data-testid="overview-event-symbol-IREN"]')!;
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toBe('/stock/IREN');
    // And it carries no breadth count, because it is not a market-wide release.
    expect(section.textContent).not.toContain('ตัวในลิสต์คุณ');
  });
});


describe('two groups, each saying what it is', () => {
  /*
    THE BUG THIS REPLACES: "IREN · Call หมดอายุในอีก 2 วัน" sat between CPI and
    NFP, on the sole grounds that its date fell there. One is an economy-wide
    number published on a schedule, the other is a contract the reader
    personally owns running out; nothing about either explains the other.
  */
  it('separates the calendar from the reader own instruments', () => {
    const section = render({
      window: calendarOf([
        macro('cpi', '2026-09-11T12:30:00.000Z'),
        macro('nfp', '2026-09-04T12:30:00.000Z', 'NFP'),
      ]),
      upcoming: UPCOMING,
      now: NOW,
    });
    const calendar = section.querySelector('[data-testid="overview-events-calendar"]')!;
    const holdings = section.querySelector('[data-testid="overview-events-holdings"]')!;
    expect(calendar.querySelector('[data-testid="overview-events-calendar-heading"]')!.textContent)
      .toBe('ปฏิทินเศรษฐกิจ');
    expect(holdings.querySelector('[data-testid="overview-events-holdings-heading"]')!.textContent)
      .toBe('เรื่องของหุ้นที่ถืออยู่');
    // The expiry falls between the two releases by date and is still not there.
    expect(calendar.textContent).not.toContain('IREN');
    expect(holdings.textContent).toContain('IREN');
  });

  /*
    A HEADING WITH NOTHING UNDER IT reads as a section that failed to load. The
    truth — no expiry, no earnings date, no alert coming up — is better said by
    drawing neither the rows nor the title.
  */
  it('hides a group and its heading together when it is empty', () => {
    const section = render({
      window: calendarOf([macro('cpi', '2026-09-11T12:30:00.000Z')]),
      upcoming: null,
      now: NOW,
    });
    expect(section.querySelector('[data-testid="overview-events-calendar"]')).not.toBeNull();
    expect(section.querySelector('[data-testid="overview-events-holdings"]')).toBeNull();
    expect(section.textContent).not.toContain('เรื่องของหุ้นที่ถืออยู่');
  });

  it('hides the calendar group the same way when only holdings have rows', () => {
    const section = render({ window: calendarOf([]), upcoming: UPCOMING, now: NOW });
    expect(section.querySelector('[data-testid="overview-events-calendar"]')).toBeNull();
    expect(section.textContent).not.toContain('ปฏิทินเศรษฐกิจ');
    expect(section.querySelector('[data-testid="overview-events-holdings"]')).not.toBeNull();
  });

  it('says nothing is coming only when both groups are empty', () => {
    const section = render({ window: calendarOf([]), upcoming: null, now: NOW });
    expect(section.querySelector('[data-testid="overview-events-empty"]')).not.toBeNull();
    expect(section.textContent).toContain('ยังไม่มีวันสำคัญที่ใกล้ถึง');
  });

  /*
    Each group counts only its own remainder. A pooled number would tell a
    reader looking at the economic calendar how many contract expiries they were
    not being shown.
  */
  it('counts the remainder of each group separately', () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      macro(`m${index}`, `2026-09-${String(4 + index).padStart(2, '0')}T12:30:00.000Z`));
    const section = render({ window: calendarOf(many), upcoming: UPCOMING, now: NOW });
    const remaining = section.querySelector('[data-testid="overview-events-calendar-remaining"]')!;
    // Nine releases, five drawn.
    expect(remaining.textContent).toContain('4');
    // The one expiry is drawn in full, so its group says nothing about a rest.
    expect(section.querySelector('[data-testid="overview-events-holdings-remaining"]')).toBeNull();
  });

  /*
    The coverage note says how far the shipped economic calendar reaches. An
    expiry date has never depended on that file, and at the foot of the whole
    section the sentence read as a limit on everything above it.
  */
  it('keeps the coverage note inside the calendar group', () => {
    const section = render({
      window: calendarOf([macro('cpi', '2026-09-11T12:30:00.000Z')], {
        coversThrough: false,
        lastDayKey: '2026-12-31',
      }),
      upcoming: UPCOMING,
      now: NOW,
    });
    const note = section.querySelector('[data-testid="overview-events-coverage"]')!;
    expect(note.textContent).toContain('ปฏิทินถึง');
    expect(section.querySelector('[data-testid="overview-events-calendar"]')!.contains(note))
      .toBe(true);
    expect(section.querySelector('[data-testid="overview-events-holdings"]')!.contains(note))
      .toBe(false);
  });

  /*
    `overview-events` is the marker `phase2-flag-manifest.mjs` reads to decide
    whether PHASE2_EVENTS reached the page, and `overview-events-empty` and
    `-coverage` are read by `overview-phase2-qa.mjs`. All three have to survive
    a rewrite of what renders them.
  */
  it('keeps the markers the flag checker and the QA script read', () => {
    const withRows = render({
      window: calendarOf([macro('cpi', '2026-09-11T12:30:00.000Z')], {
        coversThrough: false,
        lastDayKey: '2026-12-31',
      }),
      upcoming: UPCOMING,
      now: NOW,
    });
    expect(withRows.querySelector('[data-testid="overview-events"]')).not.toBeNull();
    expect(withRows.querySelector('[data-testid="overview-events-coverage"]')).not.toBeNull();

    const bare = render({ window: calendarOf([]), upcoming: null, now: NOW });
    expect(bare.querySelector('[data-testid="overview-events-empty"]')).not.toBeNull();
  });
});
