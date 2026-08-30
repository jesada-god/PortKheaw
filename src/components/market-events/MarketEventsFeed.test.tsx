// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CARD_MUST_NOT_SAY, NEVER_SAY } from '@/src/lib/presentation/banned-copy';
import { buildEventFeed, exposureNoteTh } from '@/src/lib/market-events/feed';
import type { MarketEvent } from '@/src/lib/market-events/types';
import { MarketEventsFeed } from './MarketEventsFeed';

/** Mounted and hydrated, for the reasons `MarketEventsCard.test.tsx` sets out. */

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

const EVENTS: MarketEvent[] = [
  event({ id: 'cpi', at: '2026-12-10T13:30:00.000Z' }),
  event({
    id: 'fomc',
    at: '2026-12-09T19:00:00.000Z',
    kind: 'FOMC',
    shortTh: 'FOMC',
    titleTh: 'ผลการประชุม Fed (FOMC)',
    source: 'FED',
    referencePeriod: 'ประชุม 8-9 ธ.ค.',
    etDisplay: '2:00 p.m. ET',
  }),
  event({ id: 'claims', at: '2026-12-11T13:30:00.000Z', kind: 'JOBLESS_CLAIMS', importance: 'low', source: 'DOL', titleTh: 'ยอดขอรับสวัสดิการว่างงาน' }),
  event({ id: 'ppi', at: '2026-12-15T13:30:00.000Z', kind: 'PPI', importance: 'medium', titleTh: 'เงินเฟ้อผู้ผลิต (PPI)' }),
];

function render(now: string, holdings = 6, events: MarketEvent[] = EVENTS) {
  const days = buildEventFeed({ now, events });
  act(() => root.render(
    <MarketEventsFeed days={days} exposureNoteTh={exposureNoteTh(holdings)} />,
  ));
  return days;
}

const text = () => container.textContent ?? '';

describe('the market events feed', () => {
  it('heads the first two days in words and keeps the checkable date beside them', () => {
    render('2026-12-10T04:00:00.000Z');
    const today = container.querySelector('[data-testid="market-events-day-2026-12-10"]');
    expect(today?.textContent).toContain('วันนี้');
    expect(today?.textContent).toContain('วันพฤหัสบดีที่ 10 ธันวาคม 2569');
    const tomorrow = container.querySelector('[data-testid="market-events-day-2026-12-11"]');
    expect(tomorrow?.textContent).toContain('พรุ่งนี้');
  });

  it('heads a later day with its Buddhist-era date', () => {
    render('2026-12-10T04:00:00.000Z');
    const later = container.querySelector('[data-testid="market-events-day-2026-12-15"]');
    expect(later?.textContent).toContain('วันอังคารที่ 15 ธันวาคม 2569');
  });

  it('counts the rows on each day', () => {
    render('2026-12-10T04:00:00.000Z');
    expect(container.querySelector('[data-testid="market-events-count-2026-12-10"]')?.textContent)
      .toBe('2 รายการ');
    expect(container.querySelector('[data-testid="market-events-count-2026-12-15"]')?.textContent)
      .toBe('1 รายการ');
  });

  it('prints the Thai clock time on every row', () => {
    render('2026-12-10T04:00:00.000Z');
    expect(container.querySelector('[data-testid="market-events-item-fomc"]')?.textContent)
      .toContain('02:00');
    expect(container.querySelector('[data-testid="market-events-item-cpi"]')?.textContent)
      .toContain('20:30');
  });

  it('names each release in Thai and labels how widely it is watched', () => {
    render('2026-12-10T04:00:00.000Z');
    const cpi = container.querySelector('[data-testid="market-events-item-cpi"]');
    expect(cpi?.textContent).toContain('เงินเฟ้อผู้บริโภค (CPI)');
    expect(container.querySelector('[data-testid="market-events-importance-cpi"]')?.textContent)
      .toBe('สำคัญมาก');
    expect(container.querySelector('[data-testid="market-events-importance-claims"]')?.textContent)
      .toBe('ติดตามได้');
  });

  /*
   * The whole reason the feed carries an ET note. This row is filed under
   * Thursday 10 December in Bangkok and was reported in New York on Wednesday
   * the 9th; a reader comparing against foreign coverage needs to know those
   * are the same event.
   */
  it('gives the American date on a row whose dateline differs, and only on those rows', () => {
    render('2026-12-10T04:00:00.000Z');
    expect(container.querySelector('[data-testid="market-events-et-fomc"]')?.textContent)
      .toBe('ตามเวลาสหรัฐคือ 9 ธ.ค. 2569');
    expect(container.querySelector('[data-testid="market-events-et-cpi"]')).toBeNull();
  });

  it('names the publishing agency on every row', () => {
    render('2026-12-10T04:00:00.000Z');
    expect(container.querySelector('[data-testid="market-events-item-fomc"]')?.textContent)
      .toContain('FED');
    expect(container.querySelector('[data-testid="market-events-item-claims"]')?.textContent)
      .toContain('DOL');
  });

  /*
   * ===========================================================================
   * THE EXPOSURE LINE MAY COUNT, AND MAY NOT RELATE
   * ===========================================================================
   * A macro release lands on the whole market. How many symbols a reader holds
   * is a fact; which of them a given release moves more is a correlation
   * nothing in this codebase computed. The page states the first and must never
   * imply the second.
   */
  it('states exposure as a count of holdings', () => {
    render('2026-12-10T04:00:00.000Z', 6);
    const note = container.querySelector('[data-testid="market-events-exposure"]');
    expect(note?.textContent).toContain('คุณถือหุ้นอยู่ 6 ตัว');
    expect(note?.textContent).toContain('กระทบตลาดโดยรวม');
  });

  it('says so plainly when the reader holds nothing', () => {
    render('2026-12-10T04:00:00.000Z', 0);
    expect(container.querySelector('[data-testid="market-events-exposure"]')?.textContent)
      .toContain('ยังไม่มีหุ้นในพอร์ต');
    expect(text()).not.toContain('ถือหุ้นอยู่ 0');
  });

  it('claims no relationship between a release and any kind of holding', () => {
    render('2026-12-10T04:00:00.000Z');
    expect(text()).not.toMatch(
      /มักจะ|มักกระทบ|กระทบกลุ่ม|หุ้นเทค|กลุ่มเทคโนโลยี|น่าจะ|คาดว่า|ทำนาย|แนวโน้มว่า|ส่งผลให้ราคา/,
    );
  });

  it('anchors each day so a calendar cell can link straight to it', () => {
    render('2026-12-10T04:00:00.000Z');
    expect(container.querySelector('#\\32 026-12-15')).not.toBeNull();
    expect(container.querySelector('[data-testid="market-events-day-2026-12-15"]')?.id)
      .toBe('2026-12-15');
  });

  it('drops days that have already gone by', () => {
    render('2026-12-12T04:00:00.000Z');
    expect(container.querySelector('[data-testid="market-events-day-2026-12-10"]')).toBeNull();
    expect(container.querySelector('[data-testid="market-events-day-2026-12-15"]')).not.toBeNull();
  });

  it('says the calendar has run out rather than rendering an empty frame', () => {
    render('2027-03-01T04:00:00.000Z');
    expect(container.querySelector('[data-testid="market-events-feed-empty"]')?.textContent)
      .toContain('ไม่มีรายการที่ยังมาไม่ถึง');
  });

  it('renders no undefined, null or NaN', () => {
    render('2026-12-10T04:00:00.000Z');
    expect(text()).not.toMatch(/undefined|null|NaN/);
  });

  it('says none of the words the product does not say', () => {
    render('2026-12-10T04:00:00.000Z');
    for (const phrase of [...CARD_MUST_NOT_SAY, ...NEVER_SAY]) {
      expect(text(), `the feed must not say "${phrase}"`).not.toContain(phrase);
    }
  });
});
