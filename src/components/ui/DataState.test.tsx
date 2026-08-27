// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataState, StaleNote, reportDataError } from './DataState';

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
  vi.restoreAllMocks();
});

function render(node: React.ReactNode) {
  act(() => root.render(node));
}

describe('DataState', () => {
  it('draws a skeleton while loading, never a sentence', () => {
    render(<DataState state="loading">ผลลัพธ์</DataState>);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
    expect(container.textContent).toBe('');
  });

  it('takes a caller’s own skeleton so the shape matches what replaces it', () => {
    render(<DataState state="loading" skeleton={<div data-testid="rows" />}>ผลลัพธ์</DataState>);
    expect(container.querySelector('[data-testid="rows"]')).not.toBeNull();
  });

  /*
   * Empty is an ANSWER — the request worked and there is nothing there — so it
   * must not carry an alert role, a retry button, or the error's wording. A
   * reader who is told "โหลดข้อมูลไม่สำเร็จ" for an empty range will retry
   * forever against a service that is working perfectly.
   */
  it('says empty as a result, not as a failure', () => {
    render(<DataState state="empty" onRetry={() => undefined}>ผลลัพธ์</DataState>);
    expect(container.textContent).toBe('ไม่มีข้อมูลสำหรับช่วงเวลานี้');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });

  it('lets a surface name what is missing when the default noun is wrong', () => {
    render(<DataState state="empty" emptyMessage="ไม่พบหุ้นที่ตรงกับคำค้นนี้" />);
    expect(container.textContent).toBe('ไม่พบหุ้นที่ตรงกับคำค้นนี้');
  });

  it('offers one sentence and a retry when the load failed', () => {
    const onRetry = vi.fn();
    render(<DataState state="error" onRetry={onRetry}>ผลลัพธ์</DataState>);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('โหลดข้อมูลไม่สำเร็จ');
    const button = container.querySelector('button')!;
    act(() => button.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('disables the retry while one is already running', () => {
    render(<DataState state="error" onRetry={() => undefined} retrying />);
    expect(container.querySelector('button')?.hasAttribute('disabled')).toBe(true);
  });

  it('drops the retry where there is nothing to retry', () => {
    render(<DataState state="error" />);
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toContain('โหลดข้อมูลไม่สำเร็จ');
  });

  it('renders its children once the data is ready', () => {
    render(<DataState state="ready">ผลลัพธ์จริง</DataState>);
    expect(container.textContent).toBe('ผลลัพธ์จริง');
  });

  /*
   * The one rule that outranks every other in this file: nothing a service
   * returned reaches the screen. `reportDataError` is where the real cause goes,
   * and it goes only to the console.
   */
  it('never renders the cause of the failure', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const cause = new Error('ECONNREFUSED https://api.example.com/v3/quote?key=SECRET');
    reportDataError('search', cause);
    render(<DataState state="error" onRetry={() => undefined} />);

    expect(container.textContent).not.toContain('ECONNREFUSED');
    expect(container.textContent).not.toContain('api.example.com');
    expect(container.textContent).not.toContain('SECRET');
    expect(spy).toHaveBeenCalledWith('[search]', cause);
  });

  /*
   * The nulls, in every state. A `undefined` or a `NaN` printed into a panel is
   * the single most common way this product has shown a reader something it did
   * not mean, and it has never once been informative.
   */
  it.each(['loading', 'empty', 'error', 'ready'] as const)('prints no null, undefined or NaN in %s', (state) => {
    render(<DataState state={state} onRetry={() => undefined} />);
    const text = container.textContent ?? '';
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('Infinity');
  });
});

describe('StaleNote', () => {
  it('names when the data was last true, in Bangkok time', () => {
    render(<StaleNote asOf="2026-08-27T04:30:00.000Z" />);
    const text = container.textContent ?? '';
    expect(text).toContain('ข้อมูลล่าสุด');
    // 04:30Z is 11:30 in Bangkok.
    expect(text).toContain('11:30');
    /*
     * 2569, not 2026: this goes through `formatMarketDataAsOf`, whose `th-TH`
     * locale is the Buddhist calendar, and that is the right answer here. The
     * Gregorian variant of the formatter exists for surfaces that print a
     * machine timestamp beside a formatted one, where 2569 next to 2026 asks the
     * reader to work out that they are the same day. A stale note has no ISO
     * string beside it, so it reads the Thai year like every other date in the
     * product.
     */
    expect(text).toContain('2569');
  });

  it('carries the 🟡 mark, so stale data cannot read as live', () => {
    render(<StaleNote asOf="2026-08-27T04:30:00.000Z" />);
    expect(container.querySelector('[data-status]')?.getAttribute('data-status')).toBe('neutral');
  });

  /*
   * No timestamp, no note. "ข้อมูลเก่า" on its own tells a reader their data is
   * wrong without telling them how wrong, which is worse than staying quiet and
   * letting the content speak.
   */
  it.each([null, undefined, '', 'not-a-date'])('says nothing when asOf is %p', (asOf) => {
    render(<StaleNote asOf={asOf} />);
    expect(container.textContent).toBe('');
  });
});
