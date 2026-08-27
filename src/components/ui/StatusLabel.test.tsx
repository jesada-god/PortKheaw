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
   * "แนวโน้ม ขาขึ้นชัดเจน", not the emoji's own name in front of every row —
   * which on a stock page with five rows is five interruptions carrying nothing.
   */
  it('hides the emoji from assistive technology', () => {
    render(<StatusLabel level="bad" label="ขาลงชัดเจน" />);
    const mark = container.querySelector('[aria-hidden="true"]')!;
    expect(mark.textContent).toBe('🔴');
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
  it('reads as "name · status"', () => {
    render(<StatusRow name="แนวโน้ม" level="good" label="ขาขึ้นชัดเจน" />);
    expect(container.textContent).toBe('แนวโน้ม·🟢ขาขึ้นชัดเจน');
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
