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
