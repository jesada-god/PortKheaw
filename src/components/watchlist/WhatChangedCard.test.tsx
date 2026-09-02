// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CARD_MUST_NOT_SAY, NEVER_SAY } from '@/src/lib/presentation/banned-copy';
import type { MarketSession } from '@/src/lib/market-data/market-session';
import { thaiSessionDate } from '@/src/lib/portfolio/day-change-label';
import {
  WHAT_CHANGED_LIMIT,
  whatChanged,
  type WhatChangedItem,
} from '@/src/lib/watchlist/what-changed';
import { WhatChangedCard } from './WhatChangedCard';

/**
 * The card, RENDERED AND HYDRATED — not read as source text.
 *
 * The discipline `WatchlistV2Client.test.tsx` states: a test that greps a
 * component proves a string exists in a file, not that it reaches a reader, not
 * that the branch printing it is reachable, and not that a `null` failed to
 * arrive as the text "null". So everything here mounts the real component into
 * a real DOM and asserts on what came out.
 *
 * The absence test matters most. "No section when nothing changed" is a claim
 * about a component rendering NOTHING, and the only way to check it is to mount
 * it and find an empty container.
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

function render(
  items: readonly WhatChangedItem[],
  session: MarketSession = 'CLOSED',
  sessionDate: string | null = '2026-03-02',
) {
  act(() => {
    root.render(
      <WhatChangedCard
        items={items}
        session={session}
        sessionDate={sessionDate}
        limit={WHAT_CHANGED_LIMIT}
      />,
    );
  });
}

function text() {
  return container.textContent ?? '';
}

function item(overrides: Partial<WhatChangedItem> = {}): WhatChangedItem {
  return {
    detector: 'level-break',
    symbol: 'AAPL',
    importance: 5,
    level: 'good',
    text: 'ราคาขึ้นเหนือแนวต้าน 210 แล้ว',
    ...overrides,
  };
}

describe('what changed card — presence', () => {
  it('renders NOTHING at all when nothing changed', () => {
    render([]);
    expect(container.innerHTML).toBe('');
    expect(container.querySelector('[data-testid="what-changed"]')).toBeNull();
  });

  it('renders one line per item, with the mark, the symbol and the sentence', () => {
    render([
      item(),
      item({ detector: 'earnings-soon', symbol: 'MSFT', importance: 0, level: 'neutral', text: 'ประกาศผลประกอบการอีก 3 วัน' }),
    ]);
    expect(container.querySelectorAll('[data-testid^="what-changed-"][data-testid*="-"]').length)
      .toBeGreaterThanOrEqual(2);
    expect(text()).toContain('AAPL');
    expect(text()).toContain('ราคาขึ้นเหนือแนวต้าน 210 แล้ว');
    expect(text()).toContain('MSFT');
    expect(text()).toContain('ประกาศผลประกอบการอีก 3 วัน');
  });

  /*
   * The mark is drawn from the item's level and from nothing else — the payload
   * no longer carries a glyph of its own — so "ราคาขึ้นเหนือแนวต้าน" gets the
   * rising arrow because it is `good`, not because a detector said so.
   */
  it('hides the mark from assistive technology, leaving the sentence to carry it', () => {
    render([item()]);
    const mark = container.querySelector('[data-testid="what-changed-AAPL-level-break"] [aria-hidden="true"]');
    expect(mark?.getAttribute('data-status-mark')).toBe('trending_up');
    expect(mark?.textContent).toBe('');
  });

  /*
   * A line that says a price fell must not be able to draw a rising arrow. This
   * is the one thing the switch away from five same-shaped circles bought, so it
   * is asserted on the rendered list and not only on the vocabulary.
   */
  it('points a fall down and a rise up, on the same screen', () => {
    render([
      item({ symbol: 'UP', level: 'good', text: 'เปิดตลาดห่างจากราคาปิดก่อนหน้า +3.10%' }),
      item({ symbol: 'DOWN', detector: 'trend-change', level: 'bad', text: 'แนวโน้มเปลี่ยนจากขาขึ้นเป็นขาลง' }),
    ]);
    const marks = [...container.querySelectorAll('li [aria-hidden="true"]')]
      .map((node) => node.getAttribute('data-status-mark'));
    expect(marks).toEqual(['trending_up', 'trending_down']);
  });

  it('keeps the order it was given — the cap already decided it', () => {
    render([
      item({ symbol: 'AAA' }),
      item({ symbol: 'BBB', detector: 'trend-change', importance: 4, text: 'แนวโน้มเปลี่ยนจากขาขึ้นเป็นขาลง', level: 'bad' }),
      item({ symbol: 'CCC', detector: 'gap', importance: 2, text: 'เปิดตลาดห่างจากราคาปิดก่อนหน้า +3.10%' }),
    ]);
    const symbols = [...container.querySelectorAll('li')].map((node) => node.textContent ?? '');
    expect(symbols[0]).toContain('AAA');
    expect(symbols[1]).toContain('BBB');
    expect(symbols[2]).toContain('CCC');
  });
});

describe('what changed card — which day', () => {
  it('names the completed session when the market is shut', () => {
    render([item()], 'CLOSED', '2026-03-02');
    const caption = container.querySelector('[data-testid="what-changed-caption"]')?.textContent ?? '';
    expect(caption).toContain('ตลาดปิดแล้ว');
    /*
      The date is `thaiSessionDate`'s, not this card's — the same formatter the
      %วันนี้ caption uses, so the two surfaces cannot render one session two
      ways. Asserted through it rather than against a literal for that reason.
    */
    expect(caption).toContain(thaiSessionDate('2026-03-02')!);
    expect(caption).toContain('2 มี.ค. 2026');
  });

  it('says the figures are still moving while a session runs, and dates nothing', () => {
    render([item()], 'OPEN', null);
    const caption = container.querySelector('[data-testid="what-changed-caption"]')?.textContent ?? '';
    expect(caption).toContain('ตลาดกำลังซื้อขายอยู่');
    expect(caption).not.toContain('ตลาดปิดแล้ว');
  });

  it('admits it cannot date a closed session rather than guessing วันนี้', () => {
    render([item()], 'CLOSED', null);
    const caption = container.querySelector('[data-testid="what-changed-caption"]')?.textContent ?? '';
    expect(caption).toContain('ยังระบุวันที่ไม่ได้');
    expect(text()).not.toContain('null');
  });
});

describe('what changed card — the cap, as the reader meets it', () => {
  it('says how many it may show once it is full, and stays quiet below that', () => {
    const full = Array.from({ length: WHAT_CHANGED_LIMIT }, (_unused, index) =>
      item({ symbol: `S${index}` }));
    render(full);
    expect(container.querySelector('[data-testid="what-changed-cap"]')?.textContent)
      .toContain(String(WHAT_CHANGED_LIMIT));

    render(full.slice(0, WHAT_CHANGED_LIMIT - 1));
    expect(container.querySelector('[data-testid="what-changed-cap"]')).toBeNull();
  });

  it('never draws more lines than the engine handed it', () => {
    /*
      Mounted from the real engine output rather than from a hand-built array,
      so the cap and the rendering are checked as one path. Six symbols each
      crossing a level plus a report date is eleven detections; five survive.
    */
    const loud = (symbol: string) => ({
      symbol,
      dayChangePercent: null,
      bars: [],
      price: 121,
      previousClose: 118,
      support: null,
      resistance: 120,
      trend: null,
      previousTrendLevel: null,
      earningsDays: 2,
    });
    const produced = whatChanged(['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'].map(loud));
    render(produced);
    expect(container.querySelectorAll('li')).toHaveLength(WHAT_CHANGED_LIMIT);
  });
});

describe('what changed card — what it must never say', () => {
  /** Every sentence the six detectors can produce, on one screen. */
  function everything() {
    return [
      item(),
      item({ detector: 'trend-change', symbol: 'BBB', importance: 4, level: 'bad', text: 'แนวโน้มเปลี่ยนจากขาขึ้นเป็นขาลง' }),
      item({ detector: 'return-sigma', symbol: 'CCC', importance: 3, level: 'bad', text: 'ขยับ -9.00% เกินช่วงปกติ 60 วัน (±2.02%)' }),
      item({ detector: 'gap', symbol: 'DDD', importance: 2, level: 'good', text: 'เปิดตลาดห่างจากราคาปิดก่อนหน้า +3.10%' }),
      item({ detector: 'volume-surge', symbol: 'EEE', importance: 1, level: 'neutral', text: 'ปริมาณซื้อขายวันนี้ 3.1 เท่าของค่ากลาง 20 วัน' }),
    ];
  }

  it('says nothing from either banned list', () => {
    render(everything());
    for (const phrase of [...CARD_MUST_NOT_SAY, ...NEVER_SAY]) {
      expect(text(), phrase).not.toContain(phrase);
    }
  });

  it('publishes no score and no confidence percentage', () => {
    render(everything());
    for (const banned of ['คะแนน', 'ความมั่นใจ', 'confidence', 'score', 'ผิดปกติ']) {
      expect(text().toLowerCase(), banned).not.toContain(banned.toLowerCase());
    }
  });

  it('tells the reader to do nothing — no buy, no sell, no hold, no wait', () => {
    render(everything());
    for (const banned of ['ควรซื้อ', 'ควรขาย', 'แนะนำ', 'น่าซื้อ', 'น่าขาย', 'ทยอยเก็บ', 'ถือต่อ']) {
      expect(text(), banned).not.toContain(banned);
    }
  });

  it('never renders a null or a NaN as text', () => {
    render(everything(), 'CLOSED', null);
    expect(text()).not.toContain('null');
    expect(text()).not.toContain('NaN');
    expect(text()).not.toContain('undefined');
  });
});
