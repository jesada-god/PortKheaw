// @vitest-environment jsdom

import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Modal } from './Modal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Fixture() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)}>เปิด</button>
    <Modal isOpen={open} onClose={() => setOpen(false)} title="เพิ่มรายการ">
      <input aria-label="ช่องแรก" />
      <button type="button">ปุ่มสุดท้าย</button>
    </Modal>
  </>;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.style.overflow = '';
});

describe('Modal accessibility', () => {
  it('keeps SSR deterministic before the portal is mounted', () => {
    expect(renderToString(
      <Modal isOpen onClose={() => undefined} title="ทดสอบ">เนื้อหา</Modal>,
    )).toBe('');
  });

  it('portals above navigation and confines scrolling to the body with a safe-area footer', async () => {
    await act(async () => root.render(
      <Modal
        isOpen
        onClose={() => undefined}
        title="ทดสอบ"
        footer={<button type="submit">บันทึก</button>}
      >
        เนื้อหา
      </Modal>,
    ));

    const backdrop = document.body.querySelector<HTMLElement>('[data-testid="modal-backdrop"]')!;
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    const body = dialog.querySelector<HTMLElement>('[data-testid="modal-body"]')!;
    const footer = dialog.querySelector<HTMLElement>('[data-testid="modal-footer"]')!;
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(backdrop.className).toContain('z-[100]');
    expect(backdrop.className).toContain('h-[100dvh]');
    expect(dialog.className).toContain('max-h-[100dvh]');
    expect(dialog.className).toContain('overflow-hidden');
    expect(body.className).toContain('overflow-y-auto');
    expect(body.className).toContain('overflow-x-hidden');
    expect(footer.className).toContain('sticky');
    expect(footer.className).toContain('safe-area-inset-bottom');
  });

  it('traps focus, closes with Escape and restores trigger focus', async () => {
    await act(async () => root.render(<Fixture />));
    const trigger = container.querySelector<HTMLButtonElement>('button')!;
    trigger.focus();
    await act(async () => trigger.click());
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 1)));
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.body.style.overflow).toBe('hidden');
    const buttons = dialog.querySelectorAll<HTMLButtonElement>('button');
    buttons[buttons.length - 1].focus();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
    expect(document.activeElement).toBe(dialog.querySelector('button'));
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
