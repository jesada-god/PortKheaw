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
