// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CARD_MUST_NOT_SAY, NEVER_SAY } from '@/src/lib/presentation/banned-copy';
import { buildMarketEventsCardView } from '@/src/lib/market-events/card-view';
import type { MarketEvent } from '@/src/lib/market-events/types';
import { MarketEventsCard } from './MarketEventsCard';

/**
 * THE CARD, MOUNTED AND HYDRATED — not read as source text.
 *
 * The discipline `WhatChangedCard.test.tsx` sets out: greping a component
 * proves a string exists in a file, not that it reaches a reader, not that the
 * branch printing it is reachable, and not that a `null` arrived as the text
 * "null". A calendar is especially exposed to the last one — every cell is a
 * number and an optional name, and "undefined" renders as convincingly as "12".
 */

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

function event(over: Partial<MarketEvent> & Pick<MarketEvent, 'id' | 'at'>): MarketEvent {
  return {
    kind: 'CPI',
    titleTh: 'เงินเฟ้อผู้บริโภค (CPI)',
    shortTh: 'CPI',
    importance: 'high',
    source: 'BLS',
    referencePeriod: 'ทดสอบ',
    etDisplay: '8:30 a.m. ET',
    ...over,
  };
}

const EVENTS: MarketEvent[] = [
  event({ id: 'cpi', at: '2026-12-10T13:30:00.000Z' }),
  event({ id: 'fomc', at: '2026-12-09T19:00:00.000Z', kind: 'FOMC', shortTh: 'FOMC', titleTh: 'ผลการประชุม Fed (FOMC)' }),
  event({ id: 'claims', at: '2026-12-10T13:30:00.000Z', kind: 'JOBLESS_CLAIMS', shortTh: 'ว่างงาน', importance: 'low', source: 'DOL' }),
  event({ id: 'ppi', at: '2026-12-15T13:30:00.000Z', kind: 'PPI', shortTh: 'PPI', importance: 'medium' }),
];

function render(now: string, events: MarketEvent[] = EVENTS) {
  const view = buildMarketEventsCardView({ now, events });
  if (!view) throw new Error('the view should build for a valid instant');
  act(() => root.render(<MarketEventsCard view={view} />));
  return view;
}

const text = () => container.textContent ?? '';
const cell = (dayKey: string) =>
  container.querySelector<HTMLElement>(`[data-testid="market-events-cell-${dayKey}"]`);

describe('the market events card', () => {
  it('draws seven Monday-first columns', () => {
    render('2026-12-10T04:00:00.000Z');
    const headings = [...container.querySelectorAll('.grid-cols-7')][0];
    expect(headings?.children).toHaveLength(7);
    expect(headings?.children[0].textContent).toBe('จ.');
    expect(headings?.children[6].textContent).toBe('อา.');
  });

  it('names one event on a day that has one, with no count beside it', () => {
    render('2026-12-10T04:00:00.000Z');
    const december15 = cell('2026-12-15');
    expect(december15?.textContent).toContain('PPI');
    expect(december15?.textContent).not.toContain('+');
  });

  /*
   * Three releases share 10 December in Bangkok — CPI and the jobless claims
   * that morning, plus the FOMC statement that fired at 2:00 p.m. on the 9th in
   * New York. The cell names the most-watched and counts the rest.
   */
  it('names the most watched event and counts the rest as +N', () => {
    render('2026-12-10T04:00:00.000Z');
    const december10 = cell('2026-12-10');
    expect(december10?.textContent).toContain('FOMC');
    expect(december10?.textContent).toContain('+2');
  });

  it('leaves a quiet day blank rather than marking it', () => {
    render('2026-12-10T04:00:00.000Z');
    const quiet = cell('2026-12-01');
    expect(quiet).not.toBeNull();
    // The day number, and nothing else.
    expect(quiet?.textContent?.trim()).toBe('1');
  });

  it('marks today, and marks exactly one day as today', () => {
    render('2026-12-10T04:00:00.000Z');
    const marked = container.querySelectorAll('[data-today="true"]');
    expect(marked).toHaveLength(1);
    expect(cell('2026-12-10')?.dataset.today).toBe('true');
  });

  /*
   * Today is a filled disc, not a colour on the number. A reader who cannot
   * distinguish the colour still sees a shape the other cells do not have.
   */
  it('distinguishes today by more than colour alone', () => {
    render('2026-12-10T04:00:00.000Z');
    // Addressed by its own marker, not by position: the cell gained a wash box
    // around its contents and "the first span" stopped meaning the number.
    const today = cell('2026-12-10')?.querySelector('[data-day-number]');
    expect(today?.className).toContain('rounded-full');
    expect(today?.className).toContain('bg-[var(--accent)]');
  });

  /*
   * ===========================================================================
   * A DAY LINK HAS TO CARRY ITS OWN MONTH
   * ===========================================================================
   * `/market-events` reads `?m=` and `?d=`, and `resolveSelectedDayKey` drops
   * the day outright when it does not fall inside the month — both are
   * untrusted input, so disagreeing with itself is the one thing the link must
   * never do. Without `?m=` the day is dropped and the reader lands on a grid
   * with nothing selected, which is what tapping a cell was meant to avoid.
   *
   * The anchor is kept beside it: `?d=` selects the day in the grid, `#dayKey`
   * scrolls to it in the feed below, and the bare-anchor form that shipped
   * still resolves for anyone holding an old link.
   */
  it('links a day with events to that day on the detail page, month included', () => {
    render('2026-12-10T04:00:00.000Z');
    const link = cell('2026-12-10');
    expect(link?.tagName).toBe('A');
    expect(link?.getAttribute('href')).toBe('/market-events?m=2026-12&d=2026-12-10#2026-12-10');
  });

  /*
   * The month is sliced from the day rather than taken from the card, so it is
   * the day's own month on every cell — checked across the whole grid rather
   * than on the one cell the test above names.
   */
  it('gives every day link a month that contains the day it links to', () => {
    render('2026-12-10T04:00:00.000Z');
    const links = container.querySelectorAll<HTMLAnchorElement>(
      'a[data-testid^="market-events-cell-"]',
    );
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const href = link.getAttribute('href') ?? '';
      const match = /^\/market-events\?m=(\d{4}-\d{2})&d=(\d{4}-\d{2}-\d{2})#(.+)$/
        .exec(href);
      expect(match, `${href} is not a month+day link with an anchor`).not.toBeNull();
      const [, monthParam, dayParam, anchor] = match ?? [];
      // `?m=` is the day's own month — anything else and the page drops `?d=`.
      expect(monthParam, `${href} pairs a day with another month`)
        .toBe(dayParam?.slice(0, 7));
      // And the anchor is that same day, so the feed below scrolls to it.
      expect(anchor, `${href} anchors somewhere other than its day`).toBe(dayParam);
    }
  });

  it('links the card itself to the detail page', () => {
    render('2026-12-10T04:00:00.000Z');
    const all = container.querySelector('[data-testid="market-events-all"]');
    expect(all?.getAttribute('href')).toBe('/market-events');
  });

  it('does not make a quiet day tappable', () => {
    render('2026-12-10T04:00:00.000Z');
    expect(cell('2026-12-01')?.tagName).toBe('DIV');
  });

  it('states the month in the Buddhist era and counts what is in it', () => {
    render('2026-12-10T04:00:00.000Z');
    const month = container.querySelector('[data-testid="market-events-month"]');
    expect(month?.textContent).toBe('ธันวาคม 2569 · 4 รายการ');
  });

  /*
   * ===========================================================================
   * THE REQUIREMENT THAT AN EXHAUSTED CALENDAR CANNOT GO QUIET
   * ===========================================================================
   * Past the last row the grid is still perfectly drawable — a full month of
   * numbered, eventless cells — and that is exactly the failure. A reader would
   * read it as "nothing is scheduled" when the truth is "this file does not
   * reach here". The note is mandatory, and it names the date the calendar
   * actually reaches so the claim can be checked.
   */
  it('says the calendar does not cover the month instead of drawing a silent empty one', () => {
    render('2027-02-14T04:00:00.000Z');
    const note = container.querySelector('[data-testid="market-events-coverage"]');
    expect(note).not.toBeNull();
    expect(note?.textContent).toContain('ยังไม่ครอบคลุมเดือนนี้');
    expect(note?.textContent).toContain('15 ธ.ค. 2569');
    // The month still renders — the note explains it, it does not replace it.
    expect(container.querySelector('[data-testid="market-events-card"]')).not.toBeNull();
    expect(text()).toContain('กุมภาพันธ์ 2570');
  });

  it('carries no coverage note while the calendar covers the month', () => {
    render('2026-12-10T04:00:00.000Z');
    expect(container.querySelector('[data-testid="market-events-coverage"]')).toBeNull();
  });

  it('says an empty calendar is empty rather than showing a blank month', () => {
    render('2026-12-10T04:00:00.000Z', []);
    const note = container.querySelector('[data-testid="market-events-coverage"]');
    expect(note?.textContent).toContain('ยังไม่มีข้อมูลปฏิทินเศรษฐกิจในระบบ');
  });

  /*
   * ===========================================================================
   * THE SAME TABLE AS THE CALENDAR PAGE
   * ===========================================================================
   * The rules, the wash and the weekday layer landed on `/market-events` and
   * not here, so one reader met two different-looking months inside one
   * product. `calendar-grid.tsx` owns those three now and both components
   * render it — these assert this surface actually uses it, because "we
   * extracted a module" is not the same claim as "both callers changed".
   *
   * The DATA stays apart. `card-view.ts` and `month-view.ts` answer different
   * questions and nothing here merges them.
   */
  it('draws its rules by showing the container between the cells', () => {
    render('2026-12-10T04:00:00.000Z');
    const grid = cell('2026-12-10')?.parentElement;
    expect(grid?.className).toContain('gap-px');
    expect(grid?.className).toContain('bg-[var(--border)]');
    // Inner rules only — a border round the month is a card inside a card.
    expect(grid?.className).not.toMatch(/(^|\s)(border|ring|p-|px-|py-)/);
  });

  it('gives every cell an opaque background, padding days included', () => {
    render('2026-12-10T04:00:00.000Z');
    const cells = [
      ...container.querySelectorAll<HTMLElement>('[data-testid^="market-events-cell-"]'),
    ];
    expect(cells.length).toBeGreaterThan(28);
    for (const node of cells) {
      expect(node.className, `${node.dataset.testid} must paint its own background`)
        .toMatch(/bg-\[var\(--surface/);
      expect(node.className, `${node.dataset.testid} must not round its corners`)
        .not.toMatch(/rounded/);
    }
  });

  it('washes a day with releases and leaves a quiet day alone', () => {
    render('2026-12-10T04:00:00.000Z');
    const busy = cell('2026-12-10');
    expect(busy?.dataset.importance).toBe('high');
    expect(busy?.querySelector('span')?.className).toContain('bg-[var(--negative-soft)]');

    const quiet = cell('2026-12-01');
    expect(quiet?.dataset.importance).toBeUndefined();
    const resting = (quiet?.querySelector('span')?.className ?? '')
      .split(/\s+/).filter((name) => !name.includes(':')).join(' ');
    expect(resting).not.toMatch(/bg-\[var\(--/);
  });

  /*
   * COLOUR IS NEVER THE ONLY CHANNEL. The card knows one importance per day —
   * the lead, which is the highest — so the label names that one in words.
   */
  it('says the importance in Thai words beside the count', () => {
    render('2026-12-10T04:00:00.000Z');
    const label = cell('2026-12-10')?.getAttribute('aria-label') ?? '';
    expect(label).toContain('รายการ');
    expect(label).toContain('สำคัญมาก');
  });

  it('gives every washed cell a label, whatever the rank', () => {
    render('2026-12-10T04:00:00.000Z');
    const washed = [...container.querySelectorAll<HTMLElement>('[data-importance]')];
    expect(washed.length).toBeGreaterThan(0);
    for (const node of washed) {
      expect(node.getAttribute('aria-label'), `${node.dataset.testid} is washed but unlabelled`)
        .toBeTruthy();
    }
  });

  it('separates the weekday row from the dates the same way the page does', () => {
    render('2026-12-10T04:00:00.000Z');
    const headings = container.querySelector<HTMLElement>('[data-testid="market-events-weekdays"]');
    expect(headings).not.toBeNull();
    expect(headings?.className).toContain('border-b');
    expect(headings?.className).toContain('border-[var(--border)]');
    expect(headings?.className).toMatch(/\bpb-\d/);
    expect(headings?.className).toMatch(/\bmb-/);
    const first = headings?.firstElementChild as HTMLElement | null;
    expect(first?.className).toContain('font-normal');
    expect(first?.className).toContain('text-[var(--text-muted)]');
  });

  /*
   * Every colour is a token. Read off the CLASS ATTRIBUTES rather than the
   * markup: a day link ends in `#2026-12-10`, which is eight hex characters
   * after a hash and would be read as a literal colour by anything scanning
   * innerHTML. That is also why the calendar page's copy of this assertion
   * passes on markup — its cells carry no anchor.
   */
  it('names no colour of its own anywhere on the grid', () => {
    render('2026-12-10T04:00:00.000Z');
    const grid = cell('2026-12-10')?.parentElement;
    const classes = [...(grid?.querySelectorAll('*') ?? [])]
      .map((node) => node.getAttribute('class') ?? '')
      .join(' ');
    expect(classes).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(classes).not.toMatch(/rgb\(|hsl\(/);
  });

  it('renders no undefined, null or NaN into a cell', () => {
    render('2026-12-10T04:00:00.000Z');
    expect(text()).not.toMatch(/undefined|null|NaN/);
  });

  /*
   * MOBILE: the month must fit the width it is given.
   *
   * A calendar that scrolls sideways has lost the property that makes it a
   * calendar. The grid is seven fractional columns and every cell carries
   * `min-w-0`, which is what lets `truncate` actually clip instead of forcing
   * the track wider than its container.
   */
  it('lays the month out in a grid that cannot overflow its container', () => {
    render('2026-12-10T04:00:00.000Z');
    const card = container.querySelector('[data-testid="market-events-card"]');
    expect(card?.className).toContain('min-w-0');
    expect(card?.innerHTML).toContain('grid-cols-7');
    expect(card?.innerHTML).not.toContain('overflow-x-auto');
    expect(card?.innerHTML).not.toContain('snap-x');
    for (const item of container.querySelectorAll('[data-testid^="market-events-cell-2"]')) {
      expect(item.className).toContain('min-w-0');
    }
  });

  it('clips a long event name rather than wrapping it into a taller row', () => {
    render('2026-12-10T04:00:00.000Z');
    const name = cell('2026-12-10')?.querySelector('[data-day-name]');
    expect(name?.className).toContain('truncate');
  });

  /*
   * ===========================================================================
   * THE COPY SWEEP
   * ===========================================================================
   * Run over the RENDERED text, not the source, so it covers what a reader
   * actually gets — including strings composed at render time from the view
   * model. Both lists: the card vocabulary and the product-wide one.
   *
   * Proved by planting. `โซน` was inserted into the month caption, this test
   * failed on it, and the word was removed again — so the sweep is known to
   * fire rather than assumed to.
   */
  it('says none of the words the product does not say', () => {
    for (const now of ['2026-12-10T04:00:00.000Z', '2027-02-14T04:00:00.000Z']) {
      render(now);
      for (const phrase of [...CARD_MUST_NOT_SAY, ...NEVER_SAY]) {
        expect(text(), `the card must not say "${phrase}"`).not.toContain(phrase);
      }
    }
  });

  /*
   * A macro calendar states what is scheduled. It does not forecast, and it does
   * not claim a relationship between a release and any holding — that is the
   * line `feed.ts` draws and the card is on the same side of it.
   */
  it('makes no claim about what a release will do', () => {
    render('2026-12-10T04:00:00.000Z');
    expect(text()).not.toMatch(/คาดว่า|น่าจะ|มักจะ|ทำนาย|แนวโน้มว่า/);
  });
});
