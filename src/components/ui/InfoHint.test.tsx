// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InfoHint } from './InfoHint';
import { GLOSSARY } from '@/src/lib/analytics/glossary';

// The app compiles JSX with the classic runtime, so React must be a global here
// (mirrors the StockDetail hydration test), and act() needs the env flag.
vi.stubGlobal('React', React);
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(ui: React.ReactElement) {
  act(() => root.render(ui));
}
function trigger(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('button[aria-label^="คำอธิบาย:"]')!;
}
function popover(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[role="dialog"]');
}
function click(el: Element) {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

describe('InfoHint — accessible glossary popover', () => {
  it('renders a keyboard-focusable, ARIA-labelled trigger with the popover hidden initially', () => {
    render(<InfoHint term="support" />);
    const button = trigger();
    expect(button).toBeTruthy();
    expect(button.getAttribute('aria-label')).toBe(`คำอธิบาย: ${GLOSSARY.support.label}`);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.tabIndex).toBe(0);
    expect(popover()).toBeNull();
  });

  it('keeps the trigger a fixed, non-shrinking circle (no vertical-pill stretch in tight flex rows)', () => {
    render(<InfoHint term="support" />);
    const button = trigger();
    // aspect-ratio 1 + explicit equal block/inline size + flex:0 0 auto is the layout
    // contract that stops a parent grid/flex from squeezing it into a vertical bar.
    expect(button.style.aspectRatio).toBe('1');
    expect(button.style.inlineSize).toBe('18px');
    expect(button.style.blockSize).toBe('18px');
    const cls = button.className;
    expect(cls).toContain('flex-none');
    expect(cls).toContain('shrink-0');
    expect(cls).toContain('rounded-full');
    // The ≥44px touch target is a transparent ::after overlay that must not add layout size.
    expect(cls).toContain("after:-inset-[13px]");
  });

  it('opens on tap and shows the three beginner-Thai explanation sections, then closes on a second tap', () => {
    render(<InfoHint term="poc" />);
    click(trigger());
    const open = popover();
    expect(open).toBeTruthy();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    const text = open!.textContent ?? '';
    expect(text).toContain('คืออะไร');
    expect(text).toContain('มีไว้ทำไม');
    expect(text).toContain('ใช้ดูตอนไหน');
    expect(text).toContain(GLOSSARY.poc.what);

    click(trigger());
    expect(popover()).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('closes when the in-popover close button is pressed (touch dismissal)', () => {
    render(<InfoHint term="vah" />);
    click(trigger());
    const close = popover()!.querySelector<HTMLButtonElement>('button[aria-label="ปิดคำอธิบาย"]')!;
    expect(close).toBeTruthy();
    click(close);
    expect(popover()).toBeNull();
  });

  it('closes on Escape and on an outside pointer press', () => {
    render(<InfoHint term="avwap" />);

    click(trigger());
    expect(popover()).toBeTruthy();
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(popover()).toBeNull();

    click(trigger());
    expect(popover()).toBeTruthy();
    act(() => { document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    expect(popover()).toBeNull();
  });
});
