// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CARD_MUST_NOT_SAY,
  EVENT_REACTION_MUST_NOT_SAY,
  NEVER_SAY,
} from '@/src/lib/presentation/banned-copy';
import { buildMarketEventsMonthView } from '@/src/lib/market-events/month-view';
import type { ReactionRow } from '@/src/lib/market-events/reactions';
import type { ReleaseTiming } from '@/src/lib/market-events/release-timing';
import type { MarketEvent } from '@/src/lib/market-events/types';
import { MonthCalendar } from './MonthCalendar';

/**
 * THE CALENDAR, MOUNTED AND HYDRATED — not read as source text.
 *
 * The discipline `MarketEventsCard.test.tsx` sets out, and this page is more
 * exposed to it than the card is: every cell is a number, an optional name and
 * a variable number of marks, and "undefined" renders as convincingly as "12".
 * The link targets in particular cannot be checked by reading the component —
 * a template literal that produces `?m=undefined` is perfectly valid source.
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
    referencePeriod: 'พฤศจิกายน 2026',
    etDisplay: '8:30 a.m. ET',
    ...over,
  };
}

/*
 * October to December 2026, worked out on paper — the same fixture
 * `month-view.test.ts` reasons about:
 *
 *   2026-10-15T12:30Z  +7 = 2026-10-15 19:30
 *   2026-11-10T13:30Z  +7 = 2026-11-10 20:30
 *   2026-11-25T13:30Z  +7 = 2026-11-25 20:30
 *   2026-12-09T19:00Z  +7 = 2026-12-10 02:00   (NEXT Thai day)
 *   2026-12-10T13:30Z  +7 = 2026-12-10 20:30
 */
const EVENTS: MarketEvent[] = [
  event({ id: 'ppi-oct', at: '2026-10-15T12:30:00.000Z', kind: 'PPI', shortTh: 'PPI', importance: 'medium', titleTh: 'เงินเฟ้อผู้ผลิต (PPI)' }),
  event({ id: 'cpi-nov', at: '2026-11-10T13:30:00.000Z' }),
  event({
    id: 'claims-nov',
    at: '2026-11-25T13:30:00.000Z',
    kind: 'JOBLESS_CLAIMS',
    shortTh: 'ว่างงาน',
    titleTh: 'ยอดขอรับสวัสดิการว่างงาน',
    importance: 'low',
    source: 'DOL',
    referencePeriod: 'weekly',
  }),
  event({
    id: 'fomc-dec',
    at: '2026-12-09T19:00:00.000Z',
    kind: 'FOMC',
    shortTh: 'FOMC',
    titleTh: 'ผลการประชุม Fed (FOMC)',
    source: 'FED',
    referencePeriod: 'ประชุม 8-9 ธ.ค.',
    etDisplay: '2:00 p.m. ET',
  }),
  event({ id: 'cpi-dec', at: '2026-12-10T13:30:00.000Z', importance: 'medium' }),
];

/*
 * Reaction history, as a fixture. The shipped file is empty — no releases have
 * been backfilled into the calendar — so this is the only way to see the block
 * render at all, and none of these session dates is offered as a real
 * publication date.
 */
const REACTIONS: Record<ReleaseTiming, ReactionRow[]> = {
  beforeOpen: [
    { eventId: 'cpi-jun', kind: 'CPI', sessionDate: '2026-06-10', previousSessionDate: '2026-06-09', close: 100, previousClose: 99.58, changePercent: 0.42 },
    { eventId: 'cpi-jul', kind: 'CPI', sessionDate: '2026-07-14', previousSessionDate: '2026-07-13', close: 100, previousClose: 101.11, changePercent: -1.1 },
    { eventId: 'cpi-aug', kind: 'CPI', sessionDate: '2026-08-12', previousSessionDate: '2026-08-11', close: 100, previousClose: 99.8, changePercent: 0.2 },
  ],
  intraday: [],
  afterClose: [],
};

function render(
  now: string,
  params: { monthParam?: string; dayParam?: string; reactionBuckets?: Record<ReleaseTiming, ReactionRow[]> } = {},
  events: MarketEvent[] = EVENTS,
) {
  const view = buildMarketEventsMonthView({ now, events, ...params });
  if (!view) throw new Error('the view should build for a valid instant');
  act(() => root.render(<MonthCalendar view={view} />));
  return view;
}

const text = () => container.textContent ?? '';
const at = (selector: string) => container.querySelector<HTMLElement>(selector);
const cell = (dayKey: string) => at(`[data-testid="market-events-cell-${dayKey}"]`);

describe('the month calendar', () => {
  it('draws seven Monday-first columns', () => {
    render('2026-11-10T04:00:00.000Z');
    const headings = [...container.querySelectorAll('[role="presentation"] > div')]
      .map((node) => node.textContent);
    expect(headings).toEqual(['จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.', 'อา.']);
  });

  it('states the month in the Buddhist era and counts what is in it', () => {
    render('2026-11-10T04:00:00.000Z');
    expect(at('[data-testid="market-events-month"]')?.textContent).toBe('พฤศจิกายน 2569');
    expect(at('[data-testid="market-events-month-total"]')?.textContent).toBe('2 รายการ');
  });

  it('renders no undefined, null or NaN', () => {
    render('2026-11-10T04:00:00.000Z');
    expect(text()).not.toMatch(/undefined|null|NaN/);
    expect(container.innerHTML).not.toMatch(/href="[^"]*undefined/);
  });
});

describe('walking to another month', () => {
  it('links each arrow to the month it steps to', () => {
    render('2026-11-10T04:00:00.000Z');
    expect(at('[data-testid="market-events-prev-month"]')?.getAttribute('href'))
      .toBe('/market-events?m=2026-10');
    expect(at('[data-testid="market-events-next-month"]')?.getAttribute('href'))
      .toBe('/market-events?m=2026-12');
  });

  /*
   * A dead arrow is DISABLED AND STILL THERE. One that vanished would slide the
   * other under the reader's thumb, so the control that meant "back" last month
   * means "forward" this one.
   */
  it('leaves the arrow in place and disables it at the end of the calendar', () => {
    render('2026-11-10T04:00:00.000Z', { monthParam: '2026-12' });
    const next = at('[data-testid="market-events-next-month"]');
    expect(next).not.toBeNull();
    expect(next?.tagName).toBe('BUTTON');
    expect((next as HTMLButtonElement).disabled).toBe(true);
    expect(next?.getAttribute('href')).toBeNull();
    expect(at('[data-testid="market-events-prev-month"]')?.tagName).toBe('A');
  });

  it('leaves the arrow in place and disables it at the start of the calendar', () => {
    render('2026-11-10T04:00:00.000Z', { monthParam: '2026-10' });
    expect(at('[data-testid="market-events-prev-month"]')?.tagName).toBe('BUTTON');
    expect(at('[data-testid="market-events-next-month"]')?.tagName).toBe('A');
  });

  it('names each arrow for a reader who cannot see which way it points', () => {
    render('2026-11-10T04:00:00.000Z');
    expect(at('[data-testid="market-events-prev-month"]')?.getAttribute('aria-label'))
      .toBe('เดือนก่อนหน้า');
    expect(at('[data-testid="market-events-next-month"]')?.getAttribute('aria-label'))
      .toBe('เดือนถัดไป');
  });
});

describe('the cells', () => {
  it('links every day in the month to itself, quiet ones included', () => {
    render('2026-11-10T04:00:00.000Z');
    expect(cell('2026-11-25')?.getAttribute('href'))
      .toBe('/market-events?m=2026-11&d=2026-11-25');
    // A day with nothing on it is still an answer, so it is still tappable.
    expect(cell('2026-11-14')?.getAttribute('href'))
      .toBe('/market-events?m=2026-11&d=2026-11-14');
  });

  it('does not make a padding day tappable', () => {
    render('2026-11-10T04:00:00.000Z');
    const outside = container.querySelectorAll('[data-testid="market-events-cell-outside"]');
    expect(outside.length).toBeGreaterThan(0);
    for (const node of outside) expect(node.tagName).not.toBe('A');
  });

  it('draws one mark per release on the day, and none on a quiet one', () => {
    render('2026-12-10T04:00:00.000Z');
    expect(cell('2026-12-10')?.querySelectorAll('[aria-hidden="true"] > span')).toHaveLength(2);
    expect(cell('2026-12-09')?.querySelectorAll('[aria-hidden="true"] > span')).toHaveLength(0);
  });

  /*
   * COLOUR IS NEVER THE ONLY CHANNEL. Without this label the three dot hues are
   * the entire content of a cell on a phone.
   */
  it('says the date, the count and every importance in words on each cell', () => {
    render('2026-12-10T04:00:00.000Z');
    expect(cell('2026-12-10')?.getAttribute('aria-label'))
      .toBe('10 ธ.ค. 2569 2 รายการ: สำคัญมาก, สำคัญปานกลาง');
    expect(cell('2026-12-09')?.getAttribute('aria-label')).toBe('9 ธ.ค. 2569 ไม่มีรายการ');
  });

  it('offers a legend naming every mark it draws', () => {
    render('2026-11-10T04:00:00.000Z');
    const legend = at('[data-testid="market-events-legend"]');
    expect(legend?.textContent).toContain('สำคัญมาก');
    expect(legend?.textContent).toContain('สำคัญปานกลาง');
    expect(legend?.textContent).toContain('ติดตามได้');
  });

  it('marks today and the selected day with different shapes, not just colours', () => {
    render('2026-11-10T04:00:00.000Z', { dayParam: '2026-11-25' });
    expect(cell('2026-11-10')?.dataset.today).toBe('true');
    expect(cell('2026-11-10')?.dataset.selected).toBeUndefined();
    expect(cell('2026-11-25')?.dataset.selected).toBe('true');
    expect(cell('2026-11-25')?.getAttribute('aria-current')).toBe('date');
    expect(cell('2026-11-10')?.getAttribute('aria-current')).toBeNull();
  });

  it('names the most watched release from sm: up, and counts the rest', () => {
    render('2026-12-10T04:00:00.000Z');
    expect(cell('2026-12-10')?.textContent).toContain('FOMC');
    expect(cell('2026-12-10')?.textContent).toContain('+1');
  });
});

describe('the day panel', () => {
  it('opens under the grid rather than over it, and is not a dialog', () => {
    render('2026-12-10T04:00:00.000Z');
    const panel = at('[data-testid="market-events-day-panel"]');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('role')).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    // Underneath means underneath: the grid is still in the document above it.
    expect(at('[data-testid="market-events-calendar"]')?.contains(panel!)).toBe(true);
  });

  it('shows every release on the selected day, with the Thai clock and the agency', () => {
    render('2026-12-10T04:00:00.000Z');
    expect(at('[data-testid="market-events-panel-count"]')?.textContent).toBe('2 รายการ');
    const fomc = at('[data-testid="market-events-panel-item-fomc-dec"]');
    expect(fomc?.textContent).toContain('02:00');
    expect(fomc?.textContent).toContain('ผลการประชุม Fed (FOMC)');
    expect(fomc?.textContent).toContain('FED');
    expect(at('[data-testid="market-events-panel-importance-fomc-dec"]')?.textContent)
      .toBe('สำคัญมาก');
  });

  /*
   * The row builder is shared with the feed, so the ET note is the same rule in
   * both places — the December statement is filed under Thursday the 10th in
   * Bangkok and was reported in New York on Wednesday the 9th.
   */
  it('gives the American date on a row whose dateline differs, and only on those rows', () => {
    render('2026-12-10T04:00:00.000Z');
    expect(at('[data-testid="market-events-panel-et-fomc-dec"]')?.textContent)
      .toBe('ตามเวลาสหรัฐคือ 9 ธ.ค. 2569');
    expect(at('[data-testid="market-events-panel-et-cpi-dec"]')).toBeNull();
  });

  it('heads today in words and keeps the checkable date beside it', () => {
    render('2026-11-10T04:00:00.000Z');
    const panel = at('[data-testid="market-events-day-panel"]');
    expect(panel?.textContent).toContain('วันนี้');
    expect(panel?.textContent).toContain('วันอังคารที่ 10 พฤศจิกายน 2569');
  });

  it('heads any other day with its Buddhist-era date', () => {
    render('2026-11-10T04:00:00.000Z', { dayParam: '2026-11-25' });
    expect(at('[data-testid="market-events-day-panel"]')?.textContent)
      .toContain('วันพุธที่ 25 พฤศจิกายน 2569');
  });

  it('says a quiet day is quiet rather than showing an empty list', () => {
    render('2026-11-10T04:00:00.000Z', { dayParam: '2026-11-14' });
    expect(at('[data-testid="market-events-panel-count"]')?.textContent).toBe('0 รายการ');
    expect(at('[data-testid="market-events-panel-quiet"]')?.textContent)
      .toContain('ไม่มีตัวเลขเศรษฐกิจตามกำหนด');
  });
});

describe('a month the calendar cannot speak for', () => {
  it('says where the calendar actually reaches instead of drawing a silent empty month', () => {
    render('2026-11-10T04:00:00.000Z', { monthParam: '2027-03' });
    expect(at('[data-testid="market-events-coverage"]')?.textContent)
      .toBe('ปฏิทินนี้มีข้อมูลถึงเดือน ธันวาคม 2569 จึงยังไม่ครอบคลุมเดือนนี้');
    expect(at('[data-testid="market-events-month"]')?.textContent).toBe('มีนาคม 2570');
  });

  /*
   * "0 รายการ" is the exact sentence the coverage note exists to refuse, and it
   * would have been printed one line above it.
   */
  it('prints no count for a month it cannot count', () => {
    render('2026-11-10T04:00:00.000Z', { monthParam: '2027-03' });
    expect(at('[data-testid="market-events-month-total"]')).toBeNull();
    expect(text()).not.toContain('0 รายการ');
  });

  it('draws its cells faint and stops making them tappable', () => {
    render('2026-11-10T04:00:00.000Z', { monthParam: '2027-03' });
    expect(container.innerHTML).toContain('opacity-40');
    expect(cell('2027-03-04')?.tagName).toBe('DIV');
    expect(container.querySelectorAll('[data-testid^="market-events-cell-2027"]').length)
      .toBeGreaterThan(0);
  });

  it('opens no day panel and offers no legend there', () => {
    render('2026-11-10T04:00:00.000Z', { monthParam: '2027-03' });
    expect(at('[data-testid="market-events-day-panel"]')).toBeNull();
    expect(at('[data-testid="market-events-legend"]')).toBeNull();
  });

  it('still offers the arrow that walks back toward the calendar', () => {
    render('2026-11-10T04:00:00.000Z', { monthParam: '2027-03' });
    expect(at('[data-testid="market-events-prev-month"]')?.getAttribute('href'))
      .toBe('/market-events?m=2027-02');
    expect(at('[data-testid="market-events-next-month"]')?.tagName).toBe('BUTTON');
  });

  it('says an empty calendar is empty rather than showing a blank month', () => {
    render('2026-11-10T04:00:00.000Z', {}, []);
    expect(at('[data-testid="market-events-coverage"]')?.textContent)
      .toBe('ยังไม่มีข้อมูลปฏิทินเศรษฐกิจในระบบ');
    expect(at('[data-testid="market-events-day-panel"]')).toBeNull();
  });
});

describe('what the calendar refuses to do', () => {
  /*
   * A calendar that scrolls sideways has given up the one property that makes
   * it a calendar. `MarketEventsCard.test.tsx` asserts the same about the card;
   * the page is the surface where "just let it scroll" is most tempting.
   */
  it('lays the month out in a grid that cannot overflow its container', () => {
    render('2026-11-10T04:00:00.000Z');
    const calendar = at('[data-testid="market-events-calendar"]');
    expect(calendar?.innerHTML).not.toContain('overflow-x-auto');
    expect(calendar?.innerHTML).not.toContain('snap-x');
    expect(calendar?.innerHTML).toContain('grid-cols-7');
  });

  it('says none of the words the product does not say', () => {
    for (const params of [{}, { monthParam: '2027-03' }, { dayParam: '2026-11-14' }]) {
      render('2026-11-10T04:00:00.000Z', params);
      for (const phrase of [...CARD_MUST_NOT_SAY, ...NEVER_SAY]) {
        expect(text(), `the calendar must not say "${phrase}"`).not.toContain(phrase);
      }
    }
  });

  it('makes no claim about what a release will do', () => {
    render('2026-12-10T04:00:00.000Z');
    expect(text()).not.toMatch(/คาดว่า|น่าจะ|มักจะ|ทำนาย|แนวโน้มว่า|ส่งผลให้ราคา/);
  });

  it('names no holding and no ticker anywhere on the grid', () => {
    render('2026-12-10T04:00:00.000Z');
    expect(text()).not.toMatch(/NVDA|AAPL|หุ้นเทค|กลุ่มเทคโนโลยี/);
  });
});

describe('what the index did the last few times a release was published', () => {
  const reaction = () => at('[data-testid="market-events-panel-reaction-cpi-nov"]');

  /*
   * ===========================================================================
   * THE STATE THE PRODUCT SHIPS IN TODAY
   * ===========================================================================
   * No releases have been backfilled, so there is no history for any row, and
   * the whole block must be ABSENT — not a heading over a dash, not "ไม่มีข้อมูล",
   * not a reserved empty strip. Any of those would be a permanent apology on
   * every row, and would invite a reader to wonder what is broken when the
   * answer is that nothing is.
   */
  it('renders nothing at all when there is no history — no heading, no dash, no gap', () => {
    render('2026-11-10T04:00:00.000Z');
    expect(container.querySelectorAll('[data-testid*="-reaction-"]')).toHaveLength(0);
    expect(text()).not.toContain('ครั้งก่อน');
    expect(text()).not.toContain('S&P 500');
    expect(text()).not.toContain('ไม่มีข้อมูล');
    expect(text()).not.toContain('—%');
  });

  it('states the earlier publications and what the numbers are of', () => {
    render('2026-11-10T04:00:00.000Z', { reactionBuckets: REACTIONS });
    expect(reaction()?.textContent).toContain('ครั้งก่อน ๆ');
    expect(reaction()?.textContent).toContain('S&P 500 วันนั้น');
  });

  it('prints each change signed, most recent first', () => {
    render('2026-11-10T04:00:00.000Z', { reactionBuckets: REACTIONS });
    const numbers = [...reaction()!.querySelectorAll('.font-mono')].map((node) => node.textContent);
    expect(numbers).toEqual(['+0.20%', '-1.10%', '+0.42%']);
  });

  /*
   * A percentage nobody can locate is not a fact a reader can check, and every
   * other figure in this feature is traceable to something they can go and look
   * at. Three dated closes are three facts; three undated ones are an assertion.
   */
  it('keeps the session date beside every number', () => {
    render('2026-11-10T04:00:00.000Z', { reactionBuckets: REACTIONS });
    expect(reaction()?.textContent).toContain('12 ส.ค. 2569');
    expect(reaction()?.textContent).toContain('14 ก.ค. 2569');
    expect(reaction()?.textContent).toContain('10 มิ.ย. 2569');
  });

  it('does not lean on colour: the sign is printed on every number', () => {
    render('2026-11-10T04:00:00.000Z', { reactionBuckets: REACTIONS });
    for (const node of reaction()!.querySelectorAll('.font-mono')) {
      expect(node.textContent).toMatch(/^[+-]/);
    }
  });

  /*
   * The row component is shared with the feed, and the feed answers a different
   * question — "what is still coming". Past percentages under a future release
   * would answer one nobody on that list asked.
   */
  it('appears in the day panel and nowhere else on the page', () => {
    render('2026-11-10T04:00:00.000Z', { reactionBuckets: REACTIONS });
    const found = [...container.querySelectorAll('[data-testid*="-reaction-"]')];
    expect(found).toHaveLength(1);
    expect(found[0].getAttribute('data-testid')).toBe('market-events-panel-reaction-cpi-nov');
    expect(at('[data-testid="market-events-day-panel"]')?.contains(found[0])).toBe(true);
  });

  it('shows no history on a release whose kind has none', () => {
    render('2026-12-10T04:00:00.000Z', { reactionBuckets: REACTIONS });
    // The December day holds an FOMC statement and a CPI print; only CPI has rows,
    // and the FOMC one reads a different bucket, which is empty.
    expect(at('[data-testid="market-events-panel-reaction-fomc-dec"]')).toBeNull();
  });

  it('says none of the words a measured number is not allowed to imply', () => {
    render('2026-11-10T04:00:00.000Z', { reactionBuckets: REACTIONS });
    for (const phrase of EVENT_REACTION_MUST_NOT_SAY) {
      expect(text(), `the calendar must not say "${phrase}"`).not.toContain(phrase);
    }
  });
});
