// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FloatingDock from './FloatingDock';
import { isNavItemActive, primaryNavItems } from '@/src/config/navigation';

const pathname = vi.hoisted(() => ({ current: '/' }));

vi.mock('next/navigation', () => ({
  usePathname: () => pathname.current,
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: React.ComponentProps<'a'> & { href: string }) =>
    <a href={href} {...rest}>{children}</a>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

/**
 * Every query this component asks — the pointer-device test and, through
 * AppRuntime, reduced motion — has to answer something. `matches` is what a
 * handset reports: no fine pointer, so no magnification.
 */
function stubMatchMedia(matches: boolean) {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
}

async function render(path: string) {
  pathname.current = path;
  await act(async () => root.render(<FloatingDock />));
}

const links = () => Array.from(container.querySelectorAll('a'));

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  stubMatchMedia(false);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-reduce-motion');
});

describe('FloatingDock navigation', () => {
  it('renders every destination from the shared menu configuration, in order', async () => {
    await render('/');
    expect(links().map((link) => link.getAttribute('href')))
      .toEqual(['/', '/watchlist', '/search', '/portfolio', '/tools']);
    expect(links().map((link) => link.textContent))
      .toEqual(['ภาพรวมภาพรวม', 'รายการติดตามรายการติดตาม', 'ค้นหาค้นหา', 'พอร์ตพอร์ต', 'เครื่องมือเครื่องมือ']);
    // The visible label and the tooltip are the same string, and the tooltip is
    // the copy that is hidden from assistive technology.
    expect(container.querySelectorAll('.dock__tip[aria-hidden="true"]')).toHaveLength(5);
    expect(primaryNavItems).toHaveLength(5);
  });

  it('is a single labelled navigation landmark', async () => {
    await render('/');
    const navs = container.querySelectorAll('nav');
    expect(navs).toHaveLength(1);
    expect(navs[0].getAttribute('aria-label')).toBe('เมนูหลัก');
    expect(container.querySelectorAll('nav nav')).toHaveLength(0);
  });

  it('marks the current page, including a nested route', async () => {
    await render('/tools/what-if');
    const current = links().filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current).toHaveLength(1);
    expect(current[0].getAttribute('href')).toBe('/tools');
  });

  it('keeps overview selected only on overview', async () => {
    await render('/watchlist');
    const current = links().filter((link) => link.getAttribute('aria-current') === 'page');
    expect(current.map((link) => link.getAttribute('href'))).toEqual(['/watchlist']);
  });

  it('widens exactly the current slot, which is what gives its name room', async () => {
    await render('/tools/monte-carlo');
    const active = container.querySelectorAll('li[data-active="true"]');
    expect(active).toHaveLength(1);
    expect(active[0].querySelector('a')?.getAttribute('href')).toBe('/tools');
    expect(active[0].querySelector('.dock__label')?.textContent).toBe('เครื่องมือ');
    // Every name is in the DOM whether or not it is painted, so each link keeps
    // its accessible name at every width.
    expect(container.querySelectorAll('.dock__label')).toHaveLength(5);
  });

  it('never puts a button role or a menu affordance on a link', async () => {
    await render('/');
    for (const link of links()) {
      expect(link.getAttribute('role')).toBeNull();
      expect(link.getAttribute('aria-haspopup')).toBeNull();
      expect(link.getAttribute('href')).toBeTruthy();
      // Links navigate on their own; a click handler faking it would break
      // middle-click, Ctrl-click and "open in new tab".
      expect(link.getAttribute('onclick')).toBeNull();
    }
  });

  it('is reachable and operable from the keyboard', async () => {
    await render('/');
    for (const link of links()) {
      expect(link.tabIndex).toBe(0);
      expect(link.getAttribute('tabindex')).not.toBe('-1');
    }
    links()[1].focus();
    expect(document.activeElement).toBe(links()[1]);
  });

  it('leaves icons unmagnified without a fine pointer', async () => {
    await render('/');
    for (const bubble of container.querySelectorAll<HTMLElement>('.dock__bubble')) {
      // No inline size: the stylesheet owns the resting size, and nothing on a
      // touch screen can leave an icon stuck at its hover size.
      expect(bubble.style.width).toBe('');
      expect(bubble.style.height).toBe('');
    }
  });

  it('leaves icons unmagnified when the reader asks for reduced motion', async () => {
    stubMatchMedia(true);
    document.documentElement.setAttribute('data-reduce-motion', '');
    await render('/');
    for (const bubble of container.querySelectorAll<HTMLElement>('.dock__bubble')) {
      expect(bubble.style.width).toBe('');
    }
  });
});

describe('active-route mapping', () => {
  it.each([
    ['/', '/', true],
    ['/watchlist', '/', false],
    ['/watchlist', '/watchlist', true],
    ['/stock/AAPL', '/watchlist', false],
    ['/tools/monte-carlo', '/tools', true],
    ['/toolsomething', '/tools', false],
  ])('%s against %s', (path, href, expected) => {
    expect(isNavItemActive(path, href)).toBe(expected);
  });
});

describe('the shell it replaces', () => {
  const read = (path: string) => readFileSync(resolve(path), 'utf8');
  const shell = read('src/components/layout/MainLayout.tsx');

  it('renders the dock and nothing of the navigation it replaced', () => {
    expect(shell).toContain('<FloatingDock />');
    expect(shell).not.toContain('Sidebar');
    expect(shell).not.toContain('BottomNav');
    for (const path of ['src/components/layout/Sidebar.tsx', 'src/components/layout/BottomNav.tsx']) {
      expect(() => read(path)).toThrow();
    }
  });

  it('reserves the dock its space instead of letting it cover the page', () => {
    expect(shell).toContain('pb-[var(--dock-clearance)]');
    const styles = read('app/globals.css');
    expect(styles).toContain('--dock-clearance:');
    expect(styles).toContain('--dock-inset: max(12px, env(safe-area-inset-bottom));');
    // The capsule is a capsule at every width, and it floats.
    expect(styles).toContain('border-radius: 9999px;');
    // Names are clipped, never removed, so assistive technology keeps them.
    expect(styles).toContain('clip-path: inset(50%);');
    expect(styles).not.toContain('.dock__label { display: none');
    // Hover-only affordances are gated on a real pointer, so a tap cannot leave
    // a tooltip stranded on a touch screen.
    expect(styles).toContain('@media (hover: hover) and (pointer: fine) and (min-width: 1024px)');
  });

  it('declares no menu of its own', () => {
    const dock = read('src/components/layout/FloatingDock.tsx');
    expect(dock).toContain("from '@/src/config/navigation'");
    for (const item of primaryNavItems) expect(dock).not.toContain(item.name);
    // Keyed by route, never by array position.
    expect(dock).toContain('key={item.href}');
  });
});
