// @vitest-environment jsdom

import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ResponsiveDialog } from './ResponsiveDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Fixture({ long = false }: { long?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden">
      <button type="button" onClick={() => setOpen(true)}>Open details</button>
      <ResponsiveDialog isOpen={open} onClose={() => setOpen(false)} title="Source details">
        <a href="https://example.com/a/very/long/source/url">First focusable</a>
        <button type="button">Last focusable</button>
        {long && <p>{'very-long-provider-error-without-breaks-'.repeat(80)}</p>}
      </ResponsiveDialog>
    </div>
  );
}

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
  document.body.style.overflow = '';
});

describe('ResponsiveDialog', () => {
  it('keeps SSR and the first client render portal-free', () => {
    expect(renderToString(
      <ResponsiveDialog isOpen title="Deterministic" onClose={() => undefined}>Body</ResponsiveDialog>,
    )).toBe('');
  });

  it('portals above clipped parents with viewport, safe-area, and content-only overflow constraints', async () => {
    await act(async () => root.render(<Fixture long />));
    const trigger = container.querySelector('button')!;
    await act(async () => trigger.click());
    const backdrop = document.body.querySelector<HTMLElement>('[data-testid="dialog-backdrop"]');
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(backdrop).not.toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(backdrop?.className).toContain('fixed inset-0');
    expect(backdrop?.style.paddingBottom).toContain('safe-area-inset-bottom');
    expect(dialog?.className).toContain('max-w-[35rem]');
    const content = dialog?.lastElementChild as HTMLElement;
    expect(content.className).toContain('overflow-y-auto');
    expect(content.className).toContain('overflow-x-hidden');
    expect(content.className).toContain('[overflow-wrap:anywhere]');
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('closes with Escape/backdrop, traps focus, and restores the trigger focus', async () => {
    await act(async () => root.render(<Fixture />));
    const trigger = container.querySelector<HTMLButtonElement>('button')!;
    trigger.focus();
    await act(async () => trigger.click());
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    const focusable = dialog.querySelectorAll<HTMLElement>('a,button');
    focusable[focusable.length - 1].focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(document.activeElement).toBe(focusable[0]);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await act(async () => trigger.click());
    const backdrop = document.body.querySelector<HTMLElement>('[data-testid="dialog-backdrop"]')!;
    await act(async () => backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});
