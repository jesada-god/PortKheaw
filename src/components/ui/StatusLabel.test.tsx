// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StatusLabel, StatusRow } from './StatusLabel';
import { STATUS_PRESENTATION, type StatusLevel } from '@/src/lib/presentation/status';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function render(node: React.ReactNode) {
  act(() => root.render(node));
}

const LEVELS: StatusLevel[] = ['good', 'neutral', 'weak', 'bad', 'unknown'];

describe('StatusLabel', () => {
  it('prints the caller’s own phrase, not the generic word', () => {
    render(<StatusLabel level="good" label="ขาขึ้นชัดเจน" />);
    expect(container.textContent).toContain('ขาขึ้นชัดเจน');
    expect(container.textContent).not.toContain(STATUS_PRESENTATION.good.fallbackLabel);
  });

  it('falls back to the level’s word when a caller has nothing specific', () => {
    render(<StatusLabel level="weak" />);
    expect(container.textContent).toContain('อ่อนแรง');
  });

  /*
   * The mark is for the eye only. A reader on a screen reader should hear
   * "แนวโน้ม ขาขึ้นชัดเจน", not the arrow's own name in front of every row —
   * which on a stock page with five rows is five interruptions carrying nothing.
   *
   * Asserted on the DIRECTION rather than on the glyph's geometry: the claim is
   * "a falling reading draws a falling mark", and a test that pinned the path
   * data would fail the next time Material reissues the outline without
   * changing anything a reader can see.
   */
  it('hides the mark from assistive technology, and points it downwards', () => {
    render(<StatusLabel level="bad" label="ขาลงชัดเจน" />);
    const mark = container.querySelector('[aria-hidden="true"]')!;
    expect(mark.getAttribute('data-status-mark')).toBe('trending_down');
    // It says nothing a reader could hear or copy: the phrase carries it alone.
    expect(mark.textContent).toBe('');
  });

  /*
   * The whole reason the arrows exist: the direction survives colour being
   * taken away — a greyscale screenshot, a dimmed screen, a red/green-blind
   * reader. So a rise and a fall must differ in SHAPE, not only in hue.
   */
  it.each([
    ['good', 'trending_up'],
    ['weak', 'trending_up'],
    ['neutral', 'trending_flat'],
    ['bad', 'trending_down'],
    ['unknown', 'horizontal_rule'],
  ] as const)('draws %s as %s', (level, icon) => {
    render(<StatusLabel level={level} label="ทดสอบ" />);
    expect(container.querySelector('[aria-hidden="true"]')!.getAttribute('data-status-mark'))
      .toBe(icon);
  });

  /*
   * The opt-out, and the four callers it exists for: the service-status row, the
   * stale-data note, an event's importance and the planner's plan status. None
   * of those has read a price, so none of them may point at one.
   */
  it('draws the direction-free dot when a caller asks for one', () => {
    render(<StatusLabel level="neutral" label="กำลังเชื่อมต่อ" mark="dot" />);
    const mark = container.querySelector('[aria-hidden="true"]')!;
    expect(mark.getAttribute('data-status-mark')).toBe('dot');
    expect(mark.textContent).toBe(STATUS_PRESENTATION.neutral.dot);
  });

  it.each(LEVELS)('paints %s with its token and nothing hardcoded', (level) => {
    render(<StatusLabel level={level} label="ทดสอบ" />);
    const node = container.querySelector<HTMLElement>('[data-status]')!;
    expect(node.dataset.status).toBe(level);
    expect(node.style.color).toContain(STATUS_PRESENTATION[level].token);
  });

  /*
   * Colour is the only thing that varies. If a level also changed weight or
   * size, a column of statuses would stop being scannable — the eye would sort
   * them by prominence instead of reading them.
   */
  it('changes nothing but colour between levels', () => {
    const shapes = LEVELS.map((level) => {
      render(<StatusLabel level={level} label="ทดสอบ" />);
      return container.querySelector<HTMLElement>('[data-status]')!.className;
    });
    expect(new Set(shapes).size).toBe(1);
  });

  it('is not a badge: no border, no fill, no radius', () => {
    render(<StatusLabel level="good" label="ดี" />);
    const className = container.querySelector<HTMLElement>('[data-status]')!.className;
    expect(className).not.toMatch(/border|bg-|rounded/);
  });
});

describe('StatusRow', () => {
  /*
   * The mark contributes no text at all now, which is the accepted cost of the
   * arrow: a reader copying this row out of the page gets "แนวโน้ม·ขาขึ้นชัดเจน"
   * and no glyph. The words were always the half that carried the meaning, and
   * they are all still here.
   */
  it('reads as "name · status"', () => {
    render(<StatusRow name="แนวโน้ม" level="good" label="ขาขึ้นชัดเจน" />);
    expect(container.textContent).toBe('แนวโน้ม·ขาขึ้นชัดเจน');
  });

  it('passes the caller’s choice of mark through to the label', () => {
    render(<StatusRow name="สถานะแผน" level="good" label="สมเหตุสมผล" mark="dot" />);
    expect(container.querySelector('[data-status] [aria-hidden="true"]')!.getAttribute('data-status-mark'))
      .toBe('dot');
  });

  it('appends a plain note without colouring it', () => {
    render(<StatusRow name="แนวต้าน" level="neutral" label="ใกล้แนวต้าน" note="1,240.00" />);
    expect(container.textContent).toContain('1,240.00');
    const coloured = container.querySelector<HTMLElement>('[data-status]')!;
    expect(coloured.textContent).not.toContain('1,240.00');
  });

  it('leaves no stray separator when there is no note', () => {
    render(<StatusRow name="แรงส่ง" level="weak" label="แผ่วลง" />);
    expect(container.textContent?.endsWith('แผ่วลง')).toBe(true);
  });
});
