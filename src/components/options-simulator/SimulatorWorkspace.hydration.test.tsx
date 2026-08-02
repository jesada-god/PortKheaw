// @vitest-environment jsdom

/**
 * `/tools/what-if` and `/tools/monte-carlo` are statically prerendered, so the
 * markup a reader hydrates was produced once, on the build machine, in the build
 * machine's timezone. The simulator used to seed its workspace with `new Date()`
 * and `crypto.randomUUID()` inside `useState`, which froze the build day into the
 * date inputs and into the "วันหมดอายุ … DTE …" line — every visit on a later
 * calendar day hydrated against stale text and raised React #418 in production.
 *
 * These tests hold the invariant that made that impossible to notice: the server
 * markup must carry no clock and no randomness, and the reader's own calendar day
 * must arrive only after hydration has committed.
 *
 * `Header` is stubbed because it needs the App Router context; everything the
 * hydration contract depends on is rendered by SimulatorWorkspace itself.
 */

import React, { act } from 'react';
import { hydrateRoot, createRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/tools/what-if',
}));
vi.mock('@/src/components/layout/Header', () => ({
  default: ({ title }: { title: string }) => <header>{title}</header>,
}));
vi.mock('@/src/lib/market-data/fx/client', () => ({
  fetchFxRate: () => Promise.resolve({ quote: null }),
}));

import SimulatorWorkspace, { seedWorkspace, withCalendarDates } from './SimulatorWorkspace';

const BUILD_INSTANT = new Date('2026-08-02T09:00:00Z');
const VISIT_INSTANT = new Date('2026-08-04T17:30:00Z');
const ISO_DATE = /\b20\d{2}-\d{2}-\d{2}\b/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

let consoleError: ReturnType<typeof vi.spyOn>;
let originalTimezone: string | undefined;

function hydrationComplaints(): string[] {
  return consoleError.mock.calls
    .map((call) => call.map((part) => String(part)).join(' '))
    .filter((text) => /hydrat|did not match|didn't match|server rendered|Text content/i.test(text));
}

function setTimezone(timeZone: string): void {
  process.env.TZ = timeZone;
}

/** Renders the page exactly as the build machine would, then throws its clock away. */
function prerender(timeZone: string, instant: Date, type: 'what-if' | 'monte-carlo' = 'what-if'): string {
  setTimezone(timeZone);
  vi.setSystemTime(instant);
  return renderToString(<SimulatorWorkspace initialType={type} />);
}

beforeEach(() => {
  originalTimezone = process.env.TZ;
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 401 }))));
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  if (originalTimezone === undefined) delete process.env.TZ; else process.env.TZ = originalTimezone;
});

describe('Options Portfolio Simulator hydration', () => {
  it('seeds a workspace that carries no clock and no randomness', () => {
    setTimezone('UTC');
    vi.setSystemTime(BUILD_INSTANT);
    const first = seedWorkspace('what-if');
    setTimezone('Asia/Bangkok');
    vi.setSystemTime(VISIT_INSTANT);
    const second = seedWorkspace('what-if');

    expect(second).toEqual(first);
    expect(first.valuationDate).toBe('');
    expect(first.entryDate).toBe('');
    expect(first.legs[0].expiration).toBe('');
    expect(first.scenarios[0].valuationDate).toBe('');
    expect(first.legs[0].id).not.toMatch(UUID);
    expect(first.scenarios[0].id).not.toMatch(UUID);
  });

  it('prerenders identical markup on two different build days and timezones', () => {
    const built = prerender('UTC', BUILD_INSTANT);
    const rebuilt = prerender('Asia/Bangkok', VISIT_INSTANT);

    expect(rebuilt).toBe(built);
    expect(built).not.toMatch(ISO_DATE);
    expect(built).not.toMatch(UUID);
  });

  it.each([
    ['Asia/Bangkok', 'what-if'],
    ['America/New_York', 'what-if'],
    ['UTC', 'monte-carlo'],
  ] as const)('hydrates a build-day prerender in %s without a single mismatch (%s)', async (timeZone, type) => {
    const html = prerender('UTC', BUILD_INSTANT, type);

    // A different machine, a different zone, two calendar days later.
    setTimezone(timeZone);
    vi.setSystemTime(VISIT_INSTANT);
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.append(container);

    let root: ReturnType<typeof hydrateRoot> | null = null;
    await act(async () => { root = hydrateRoot(container, <SimulatorWorkspace initialType={type} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    expect(hydrationComplaints()).toEqual([]);
    await act(async () => { root?.unmount(); });
  });

  it('applies the reader\'s own calendar day only after hydration', async () => {
    const html = prerender('UTC', BUILD_INSTANT);
    // The prerender must show the placeholder, never the build machine's day.
    expect(html).toContain('—');
    expect(html).not.toContain('2026-09-01');

    setTimezone('Asia/Bangkok');
    vi.setSystemTime(VISIT_INSTANT);
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.append(container);

    let root: ReturnType<typeof hydrateRoot> | null = null;
    await act(async () => { root = hydrateRoot(container, <SimulatorWorkspace initialType="what-if" />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    // 2026-08-04T17:30Z is already 2026-08-05 in Bangkok, so the target date is the 6th.
    const target = container.querySelector<HTMLInputElement>('input[type="date"]');
    expect(target?.value).toBe('2026-08-06');
    expect(container.textContent).toContain('2026-09-04');
    expect(hydrationComplaints()).toEqual([]);
    await act(async () => { root?.unmount(); });
  });

  it('keeps the loading, unavailable and failed-request states free of mismatches', async () => {
    // Saved simulations 500, the quote endpoint refuses: the states a reader hits
    // when the app is cold or a provider is down must hydrate like any other.
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    const html = prerender('UTC', BUILD_INSTANT);

    setTimezone('Pacific/Kiritimati');
    vi.setSystemTime(VISIT_INSTANT);
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.append(container);

    let root: ReturnType<typeof hydrateRoot> | null = null;
    await act(async () => { root = hydrateRoot(container, <SimulatorWorkspace initialType="what-if" />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(hydrationComplaints()).toEqual([]);
    await act(async () => { root?.unmount(); });
  });

  it('still shows a live provider price and its timestamp after mount', async () => {
    const quotedAt = '2026-08-04T13:45:00.000Z';
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/market/search')) {
        return Promise.resolve(new Response(JSON.stringify({
          data: [{ symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', assetType: 'Stock', status: 'active', currency: 'USD' }],
        }), { status: 200 }));
      }
      if (url.includes('/api/market/quote/')) {
        return Promise.resolve(new Response(JSON.stringify({
          data: { price: 231.42 },
          meta: { provider: 'alpaca', timestamp: quotedAt, freshness: { status: 'realtime', asOf: quotedAt } },
        }), { status: 200 }));
      }
      return Promise.resolve(new Response('{}', { status: 401 }));
    }));

    setTimezone('Asia/Bangkok');
    vi.setSystemTime(VISIT_INSTANT);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => { root.render(<SimulatorWorkspace initialType="what-if" />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    const search = container.querySelector<HTMLInputElement>('input[data-validation-path="symbol"]');
    expect(search).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      setter?.call(search, 'AAPL');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });

    const match = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Apple Inc.'));
    expect(match).toBeDefined();
    await act(async () => { match?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });

    const text = container.textContent ?? '';
    expect(text).toContain('231.42');
    expect(text).toContain('ข้อมูลเรียลไทม์');
    // 13:45Z is 20:45 in Bangkok; the pinned Thai format is what the reader sees.
    expect(text).toContain('4 ส.ค. 2026 20:45');
    expect(hydrationComplaints()).toEqual([]);
    await act(async () => { root.unmount(); });
  });

  it('fills only undated fields so a restored draft keeps its own dates', () => {
    const seeded = withCalendarDates(seedWorkspace('what-if'), '2026-08-05');
    expect(seeded.valuationDate).toBe('2026-08-05');
    expect(seeded.entryDate).toBe('2026-08-05');
    expect(seeded.scenarios[0].valuationDate).toBe('2026-08-06');
    expect(seeded.legs[0].expiration).toBe('2026-09-04');

    const restored = withCalendarDates({ ...seeded, valuationDate: '2026-01-02' }, '2026-08-05');
    expect(restored.valuationDate).toBe('2026-01-02');
    expect(restored.legs[0].expiration).toBe('2026-09-04');
  });
});
