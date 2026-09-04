// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Header, { navigateBackWithFallback } from './Header';

const router = vi.hoisted(() => ({
  back: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => router,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  router.back.mockReset();
  router.replace.mockReset();
  router.push.mockReset();
  vi.stubGlobal('fetch', vi.fn(async () => ({
    json: async () => ({ count: 0 }),
  })));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window.history, 'length');
});

describe('Header back navigation', () => {
  it('uses browser history when an earlier entry exists', () => {
    Object.defineProperty(window.history, 'length', { configurable: true, value: 2 });
    navigateBackWithFallback(router, '/settings');
    expect(router.back).toHaveBeenCalledOnce();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('falls back to settings without browser history', () => {
    Object.defineProperty(window.history, 'length', { configurable: true, value: 1 });
    navigateBackWithFallback(router, '/settings');
    expect(router.replace).toHaveBeenCalledWith('/settings');
    expect(router.back).not.toHaveBeenCalled();
  });

  it('renders the full alert title, a 44px back target, and hides secondary actions first on narrow screens', async () => {
    await act(async () => root.render(
      <Header title="การแจ้งเตือนราคา" backFallbackHref="/settings" />,
    ));
    const back = container.querySelector<HTMLButtonElement>('button[aria-label="ย้อนกลับ"]')!;
    const title = Array.from(container.querySelectorAll('h2'))
      .find((heading) => heading.textContent === 'การแจ้งเตือนราคา')!;
    const profile = container.querySelector<HTMLButtonElement>('button[aria-label="โปรไฟล์"]')!;
    const actions = profile.parentElement?.parentElement;

    expect(back.className).toContain('min-h-11');
    expect(back.className).toContain('min-w-11');
    expect(back.className).toContain('focus-visible:ring-2');
    expect(title.textContent).toBe('การแจ้งเตือนราคา');
    expect(title.className).toContain('whitespace-nowrap');
    expect(title.className).not.toContain('truncate');
    expect(actions?.className).toContain('hidden sm:flex');
  });
});

/*
 * ===========================================================================
 * A BACK CONTROL THAT IS A DESTINATION, NOT A HISTORY STEP
 * ===========================================================================
 * `/market-events` had no way out. The only arrow on it steps to the previous
 * MONTH, and readers arrive there from a card on the Overview, from a day cell
 * on that card, and from bookmarks and shared links.
 *
 * `backFallbackHref` was the wrong tool for it: it calls `router.back()`
 * whenever `window.history.length > 1`, which is true of any tab that has been
 * used at all, so a reader who opened the page cold is sent OUT of the product
 * and the fallback never fires. A link goes to the same place whatever route
 * they took.
 *
 * These assert the two are the SAME control — same slot, same accessible name,
 * same 44px target, same effect on the rest of the header — differing only in
 * what happens when it is pressed. Two kinds of back button that looked
 * different would be worse than one that occasionally goes to the wrong place.
 */
describe('Header back link', () => {
  const renderHeader = async (props: Record<string, unknown>) => {
    await act(async () => root.render(<Header title="ปฏิทินเศรษฐกิจ" {...props} />));
  };

  it('renders an anchor to the destination rather than a history button', async () => {
    await renderHeader({ backHref: '/' });
    const link = container.querySelector<HTMLAnchorElement>('a[aria-label="ย้อนกลับ"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('/');
    // And no history button beside it — one back control, not two.
    expect(container.querySelector('button[aria-label="ย้อนกลับ"]')).toBeNull();
  });

  it('does not call the router when it is pressed', async () => {
    await renderHeader({ backHref: '/' });
    const link = container.querySelector<HTMLAnchorElement>('a[aria-label="ย้อนกลับ"]')!;
    await act(async () => { link.click(); });
    expect(router.back).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('is the same 44px target and keeps the same header layout as the button', async () => {
    await renderHeader({ backHref: '/' });
    const link = container.querySelector<HTMLAnchorElement>('a[aria-label="ย้อนกลับ"]')!;
    const title = Array.from(container.querySelectorAll('h2'))
      .find((heading) => heading.textContent === 'ปฏิทินเศรษฐกิจ')!;
    const profile = container.querySelector<HTMLButtonElement>('button[aria-label="โปรไฟล์"]')!;

    expect(link.className).toContain('min-h-11');
    expect(link.className).toContain('min-w-11');
    expect(link.className).toContain('focus-visible:ring-2');
    expect(title.className).toContain('whitespace-nowrap');
    expect(profile.parentElement?.parentElement?.className).toContain('hidden sm:flex');
  });

  /*
   * The brand lockup steps aside for a back control. It did for the button
   * already; a header that kept it would put the brand between the arrow and
   * the page title on a handset.
   */
  it('drops the brand lockup, as the history button does', async () => {
    await renderHeader({ backHref: '/' });
    const withLink = container.innerHTML;
    await renderHeader({ backFallbackHref: '/' });
    const withButton = container.innerHTML;
    await renderHeader({});
    const withNeither = container.innerHTML;

    const lockups = (html: string) => (html.match(/brand-lockup/g) ?? []).length;
    expect(lockups(withNeither)).toBeGreaterThan(0);
    expect(lockups(withLink)).toBe(0);
    expect(lockups(withLink)).toBe(lockups(withButton));
  });
});
