// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrialCountdown } from './TrialCountdown';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENDS_AT = '2026-08-10T12:00:00.000Z';
const REMAINING = 3 * 24 * 60 * 60 * 1000 + 4 * 60 * 60 * 1000;

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TrialCountdown', () => {
  it('hydrates the server markup without a mismatch, whatever the device clock says', () => {
    // A device clock hours away from the server's is exactly the case that
    // makes a locally computed countdown hydrate differently than it rendered.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-09T23:00:00.000Z'));

    const markup = renderToString(
      <TrialCountdown endsAt={ENDS_AT} initialRemainingMs={REMAINING} />,
    );
    expect(markup).toContain('3 วัน 4 ชั่วโมง');
    container.innerHTML = markup;

    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    act(() => {
      root = hydrateRoot(container, <TrialCountdown endsAt={ENDS_AT} initialRemainingMs={REMAINING} />);
    });

    expect(errors).not.toHaveBeenCalled();
    expect(container.textContent).toBe('3 วัน 4 ชั่วโมง');
  });

  it('keeps counting from the server value instead of jumping by the clock skew', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    act(() => {
      root = createRoot(container);
      root.render(<TrialCountdown endsAt={ENDS_AT} initialRemainingMs={REMAINING} />);
    });
    expect(container.textContent).toBe('3 วัน 4 ชั่วโมง');

    // One hour of real time passes; the label follows by one hour, not by the
    // seven-month gap between this device's clock and the trial's end date.
    act(() => { vi.advanceTimersByTime(60 * 60 * 1000); });
    expect(container.textContent).toBe('3 วัน 3 ชั่วโมง');
  });

  it('reports an elapsed trial rather than a negative one', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T11:59:00.000Z'));

    act(() => {
      root = createRoot(container);
      root.render(<TrialCountdown endsAt={ENDS_AT} initialRemainingMs={60_000} />);
    });
    expect(container.textContent).toBe('1 นาที');

    act(() => { vi.advanceTimersByTime(5 * 60 * 1000); });
    expect(container.textContent).toBe('หมดอายุแล้ว');
  });
});
