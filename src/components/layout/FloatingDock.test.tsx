// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FloatingDock from './FloatingDock';
import { LONG_PRESS_MS, MOVE_SLOP, RELEASE_SLACK } from './dock-gesture';
import { isNavItemActive, primaryNavItems } from '@/src/config/navigation';

const pathname = vi.hoisted(() => ({ current: '/' }));
const push = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  usePathname: () => pathname.current,
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
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
const slots = () => Array.from(container.querySelectorAll<HTMLElement>('li.dock__slot'));
const dockEl = () => container.querySelector<HTMLElement>('nav.dock')!;
const dragTip = () => container.querySelector('.dock__drag-tip');

/* --------------------------------------------------------------------------
 * Pointer plumbing
 *
 * jsdom has neither a layout engine nor pointer capture, so both are supplied
 * here: a 296px capsule laid out as it is at 320px, and capture methods that
 * record what the component asked for. Everything the gesture decides is read
 * from these numbers, which is what makes the decisions assertable at all.
 * ------------------------------------------------------------------------ */

const DOCK_BOX = { left: 12, top: 646, width: 296, height: 62 };
const SLOT_WIDTH = 54.4;
const SLOT_GAP = 3;

function layOutDock() {
  const dock = dockEl();
  const rect = (left: number, top: number, width: number, height: number) => ({
    left, top, width, height, right: left + width, bottom: top + height, x: left, y: top,
    toJSON: () => ({}),
  }) as DOMRect;

  dock.getBoundingClientRect = () => rect(DOCK_BOX.left, DOCK_BOX.top, DOCK_BOX.width, DOCK_BOX.height);
  slots().forEach((slot, index) => {
    const left = DOCK_BOX.left + 6 + index * (SLOT_WIDTH + SLOT_GAP);
    slot.getBoundingClientRect = () => rect(left, DOCK_BOX.top + 6, SLOT_WIDTH, DOCK_BOX.height - 12);
  });

  const captured = new Set<number>();
  dock.setPointerCapture = (id: number) => { captured.add(id); };
  dock.releasePointerCapture = (id: number) => { captured.delete(id); };
  dock.hasPointerCapture = (id: number) => captured.has(id);
  return captured;
}

/** Centre of slot `index`, in the coordinates `layOutDock` establishes. */
const slotCenter = (index: number) => ({
  x: DOCK_BOX.left + 6 + index * (SLOT_WIDTH + SLOT_GAP) + SLOT_WIDTH / 2,
  y: DOCK_BOX.top + DOCK_BOX.height / 2,
});

/**
 * jsdom implements no `PointerEvent`, so the pointer fields React copies onto
 * its synthetic event are added to a MouseEvent by hand. React reads them off
 * the native event, so the component sees exactly what a browser would send.
 */
function pointer(
  type: string,
  { x = 0, y = 0, pointerId = 1, button = 0, pointerType = 'touch' } = {},
) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  return event;
}

const fire = (target: Element, event: Event) => act(() => { target.dispatchEvent(event); });

/** A click as a browser synthesises one after a real press. */
const clickEvent = (detail = 1) =>
  new MouseEvent('click', { bubbles: true, cancelable: true, detail });

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  stubMatchMedia(false);
  push.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

/* Regression 1 — the reported handset defect. */
describe('the active item is the same size as every other item', () => {
  const styles = readFileSync(resolve('app/globals.css'), 'utf8');

  it('gives no slot a width of its own, on any route', async () => {
    for (const path of ['/', '/watchlist', '/tools/monte-carlo']) {
      await render(path);
      const marked = slots().filter((slot) => slot.dataset.active === 'true');
      expect(marked).toHaveLength(1);
      // Nothing sizes a slot inline, so all five take the identical flex share.
      for (const slot of slots()) expect(slot.getAttribute('style')).toBeNull();
    }
  });

  it('never widens the current slot in the stylesheet either', () => {
    // The rule that made the active destination a wide pill. It is gone, and
    // the equal share that replaced it is what every slot now gets.
    expect(styles).not.toContain('.dock__slot[data-active="true"] {');
    expect(styles).toMatch(/\.dock__slot\s*\{[^}]*flex:\s*1 1 0;/);
  });

  it('marks the current destination with colour alone, never with size', () => {
    const rule = styles.slice(styles.indexOf('.dock__item[aria-current="page"] .dock__bubble'));
    const body = rule.slice(0, rule.indexOf('}'));
    expect(body).toContain('background:');
    expect(body).toContain('box-shadow: inset');
    // A transform is how the icon used to grow when it became current.
    expect(body).not.toContain('transform');
    expect(body).not.toContain('width');
  });

  it('paints no name in the capsule while keeping every name accessible', async () => {
    await render('/tools/monte-carlo');
    // Clipped at every width — the rule that unclipped the active one is gone.
    expect(styles).toContain('clip-path: inset(50%);');
    expect(styles).not.toContain('.dock__slot[data-active="true"] .dock__label');
    expect(container.querySelectorAll('.dock__label')).toHaveLength(5);
    expect(links().map((link) => link.getAttribute('aria-label')))
      .toEqual(primaryNavItems.map((item) => item.name));
  });
});

/* Regression 3, 4, 5 — the press-and-drag gesture. */
describe('press-and-drag selection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  async function pressAt(index: number, pointerId = 1) {
    const dock = dockEl();
    const captured = layOutDock();
    const start = slotCenter(index);
    await fire(dock, pointer('pointerdown', { ...start, pointerId }));
    return { dock, captured, start };
  }

  async function hold() {
    await act(async () => { vi.advanceTimersByTime(LONG_PRESS_MS); });
  }

  it('navigates once, immediately, on an ordinary tap', async () => {
    await render('/');
    const { dock } = await pressAt(3);
    const target = links()[3];

    // Released well inside the press window: nothing has engaged, so the link's
    // own click is what navigates and the component adds nothing to it.
    await fire(dock, pointer('pointerup', slotCenter(3)));
    expect(dragTip()).toBeNull();
    expect(push).not.toHaveBeenCalled();

    const click = clickEvent();
    await fire(target, click);
    // Not prevented: the browser follows the href exactly as it always did.
    expect(click.defaultPrevented).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });

  it('does not make a tap wait for the long-press timer', async () => {
    await render('/');
    const { dock } = await pressAt(1);
    const press = pointer('pointerdown', slotCenter(1));
    // The press itself is never consumed, so the browser is free to raise its
    // click at once rather than after LONG_PRESS_MS.
    await fire(dock, press);
    expect(press.defaultPrevented).toBe(false);
    expect(dragTip()).toBeNull();
  });

  it('shows a tooltip and highlights the icon once the hold is recognised', async () => {
    await render('/');
    const { captured } = await pressAt(0);
    expect(dragTip()).toBeNull();

    await hold();
    expect(dragTip()?.textContent).toBe(primaryNavItems[0].name);
    expect(slots()[0].dataset.pressed).toBe('true');
    expect(dockEl().dataset.pressing).toBe('true');
    // Capture is taken only now, never on the press that might still be a tap.
    expect(captured.has(1)).toBe(true);
  });

  it('follows the drag across icons, then navigates once on release', async () => {
    await render('/');
    const { dock } = await pressAt(0);
    await hold();

    await fire(dock, pointer('pointermove', slotCenter(2)));
    expect(dragTip()?.textContent).toBe(primaryNavItems[2].name);
    expect(slots().map((slot) => slot.dataset.pressed)).toEqual([undefined, undefined, 'true', undefined, undefined]);

    await fire(dock, pointer('pointermove', slotCenter(4)));
    expect(dragTip()?.textContent).toBe(primaryNavItems[4].name);

    await fire(dock, pointer('pointerup', slotCenter(4)));
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(primaryNavItems[4].href);
    // The gesture leaves nothing on screen.
    expect(dragTip()).toBeNull();
    expect(dockEl().dataset.pressing).toBeUndefined();
  });

  it('swallows the click the browser raises after the gesture, so nothing goes twice', async () => {
    await render('/');
    const { dock } = await pressAt(1);
    await hold();
    await fire(dock, pointer('pointerup', slotCenter(1)));
    expect(push).toHaveBeenCalledTimes(1);

    const click = clickEvent();
    await fire(links()[1], click);
    expect(click.defaultPrevented).toBe(true);
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('releases capture when the gesture ends', async () => {
    await render('/');
    const { dock, captured } = await pressAt(2);
    await hold();
    expect(captured.has(1)).toBe(true);
    await fire(dock, pointer('pointerup', slotCenter(2)));
    expect(captured.size).toBe(0);
  });

  it('abandons the gesture when the reader scrolls vertically instead', async () => {
    await render('/');
    const { dock, start } = await pressAt(2);
    // Movement past the slop before the hold is recognised — a scroll, not a press.
    await fire(dock, pointer('pointermove', { x: start.x, y: start.y - (MOVE_SLOP + 5) }));
    await hold();

    expect(dragTip()).toBeNull();
    await fire(dock, pointer('pointerup', { x: start.x, y: start.y - (MOVE_SLOP + 5) }));
    expect(push).not.toHaveBeenCalled();

    // And the tap path is still intact afterwards.
    const click = clickEvent();
    await fire(links()[2], click);
    expect(click.defaultPrevented).toBe(false);
  });

  it('cancels without navigating when the pointer is taken away', async () => {
    await render('/');
    const { dock, captured } = await pressAt(3);
    await hold();
    expect(dragTip()).not.toBeNull();

    await fire(dock, pointer('pointercancel', slotCenter(3)));
    expect(push).not.toHaveBeenCalled();
    expect(dragTip()).toBeNull();
    expect(captured.size).toBe(0);
  });

  it('cancels without navigating when the release lands off the dock', async () => {
    await render('/');
    const { dock } = await pressAt(1);
    await hold();

    const away = { x: slotCenter(1).x, y: DOCK_BOX.top - RELEASE_SLACK - 30 };
    await fire(dock, pointer('pointermove', away));
    // The highlight drops too, so it is visible that releasing here does nothing.
    expect(dragTip()).toBeNull();
    expect(slots().every((slot) => slot.dataset.pressed === undefined)).toBe(true);

    await fire(dock, pointer('pointerup', away));
    expect(push).not.toHaveBeenCalled();
  });

  it('drops a mouse press that is released somewhere else entirely', async () => {
    await render('/');
    // No implicit capture for a mouse, so nothing about this release comes back
    // to the capsule. Without the window-level net the pending timer would go on
    // to open a selection for a button that is no longer held.
    await pressAt(2, 7);
    await act(async () => {
      window.dispatchEvent(pointer('pointerup', { x: 5, y: 5, pointerId: 7, pointerType: 'mouse' }));
    });
    await hold();

    expect(dragTip()).toBeNull();
    expect(dockEl().dataset.pressing).toBeUndefined();
    expect(push).not.toHaveBeenCalled();
  });

  it('drops a mouse press that is dragged off the capsule before it engages', async () => {
    await render('/');
    const { start } = await pressAt(2, 9);
    await act(async () => {
      window.dispatchEvent(pointer('pointermove', {
        x: start.x, y: start.y - 400, pointerId: 9, pointerType: 'mouse',
      }));
    });
    await hold();
    expect(dragTip()).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it('ignores a secondary button, which belongs to the platform', async () => {
    await render('/');
    layOutDock();
    await fire(dockEl(), pointer('pointerdown', { ...slotCenter(0), button: 2, pointerType: 'mouse' }));
    await hold();
    expect(dragTip()).toBeNull();
    expect(push).not.toHaveBeenCalled();
  });

  it('runs the same gesture for a mouse and a stylus', async () => {
    for (const pointerType of ['mouse', 'pen'] as const) {
      await render('/');
      const dock = dockEl();
      layOutDock();
      await fire(dock, pointer('pointerdown', { ...slotCenter(0), pointerType }));
      await hold();
      await fire(dock, pointer('pointermove', { ...slotCenter(3), pointerType }));
      expect(dragTip()?.textContent).toBe(primaryNavItems[3].name);
      await fire(dock, pointer('pointerup', { ...slotCenter(3), pointerType }));
      expect(push).toHaveBeenLastCalledWith(primaryNavItems[3].href);
      push.mockClear();
    }
  });

  it('does not let a stray press flag swallow a keyboard activation', async () => {
    await render('/');
    const { dock } = await pressAt(0);
    await hold();
    await fire(dock, pointer('pointerup', slotCenter(0)));
    push.mockClear();

    // `detail: 0` is how a browser reports Enter on a focused link. It has no
    // press behind it and must always reach the link.
    const keyboardClick = clickEvent(0);
    await fire(links()[2], keyboardClick);
    expect(keyboardClick.defaultPrevented).toBe(false);
  });
});

/* Regression 6 — the dock stays operable without a pointer at all. */
describe('keyboard operation', () => {
  it('is reachable, focusable and named for every destination', async () => {
    await render('/');
    for (const link of links()) {
      expect(link.tabIndex).toBe(0);
      expect(link.getAttribute('tabindex')).not.toBe('-1');
      expect(link.getAttribute('aria-label')).toBeTruthy();
    }
    links()[1].focus();
    expect(document.activeElement).toBe(links()[1]);
  });

  it('leaves an activated link to navigate itself, with no gesture in the way', async () => {
    await render('/');
    links()[4].focus();
    const activation = clickEvent(0);
    await fire(links()[4], activation);
    expect(activation.defaultPrevented).toBe(false);
    expect(push).not.toHaveBeenCalled();
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

const read = (path: string) => readFileSync(resolve(path), 'utf8');

describe('the shell it replaces', () => {
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

/* Regression 2 and 7 — the same capsule, in the same place, on every route. */
describe('dock placement and content clearance', () => {
  const styles = read('app/globals.css');
  const shell = read('src/components/layout/MainLayout.tsx');

  it('pins the capsule to the viewport, so no page can move it', () => {
    const rule = styles.slice(styles.indexOf('\n.dock {'));
    const body = rule.slice(0, rule.indexOf('\n}'));
    expect(body).toContain('position: fixed;');
    expect(body).toContain('bottom: var(--dock-inset);');
    expect(body).toContain('left: 50%;');
    // Centred on the viewport and inset from both edges: it cannot overflow at
    // 320px any more than it can at 1440px.
    expect(body).toContain('width: calc(100% - 24px);');
    expect(body).toContain('max-width: 430px;');
  });

  it('reserves the dock exactly once, in the shell and nowhere else', () => {
    // Every route renders through this one <main>, Stock Detail included.
    expect(shell).toContain('pb-[var(--dock-clearance)]');
    expect(shell.match(/pb-\[var\(--dock-clearance\)\]/g)).toHaveLength(1);
  });

  it('leaves Stock Detail no bottom padding of its own', () => {
    const stockDetail = read('src/components/stock/StockDetailClient.tsx');
    // `pb-20` here stacked 80px on top of the shell's clearance — an empty band
    // above the capsule that existed on this route and no other.
    expect(stockDetail).not.toMatch(/className="pb-20"/);
    expect(stockDetail).not.toMatch(/\bpb-\[var\(--dock-clearance\)\]/);
  });

  it('derives the clearance from the capsule and the safe area, in one place', () => {
    expect(styles).toContain('--dock-clearance: calc(var(--dock-height) + var(--dock-inset) + 20px);');
    // The safe area is read once, by the inset every other measurement builds on.
    expect(styles.match(/--dock-inset:/g)).toHaveLength(1);
  });

  it('keeps a vertical swipe scrolling the page and a pinch zooming it', () => {
    const rule = styles.slice(styles.indexOf('\n.dock {'));
    expect(rule.slice(0, rule.indexOf('\n}'))).toContain('touch-action: pan-y pinch-zoom;');
    // `none` would take page scrolling away from anyone whose thumb starts on
    // the capsule, and would remove the zoom this app deliberately keeps.
    expect(styles).not.toContain('.dock { touch-action: none');
  });

  it('keeps the drag tooltip above the capsule and out of the way', () => {
    const rule = styles.slice(styles.indexOf('.dock__drag-tip {'));
    const body = rule.slice(0, rule.indexOf('}'));
    expect(body).toContain('bottom: calc(100% + 10px);');
    expect(body).toContain('pointer-events: none;');
    // Bounded, so a long Thai name cannot stretch it past the capsule it is
    // clamped inside.
    expect(body).toContain('max-width: min(60vw, 240px);');
  });
});
