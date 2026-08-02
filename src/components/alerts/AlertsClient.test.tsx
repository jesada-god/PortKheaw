// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PriceAlert } from '@/src/lib/alerts/types';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  toggle: vi.fn(),
  remove: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  addToast: vi.fn(),
}));

vi.mock('@/app/alerts/actions', () => ({
  createAlertAction: mocks.create,
  updateAlertAction: mocks.update,
  setAlertEnabledAction: mocks.toggle,
  deleteAlertAction: mocks.remove,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mocks.refresh, back: mocks.back }),
}));

vi.mock('@/src/components/ui/Toast', () => ({
  useToast: () => ({ addToast: mocks.addToast }),
}));

vi.mock('@/src/lib/alerts/client', () => ({
  requestAlertEvaluation: vi.fn(),
}));

import { AlertsClient, parsePositiveDecimal } from './AlertsClient';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const savedAlert: PriceAlert = {
  id: '9ce8ac70-ed32-4ef4-bd4f-edf2b86ae735',
  symbol: 'AAPL',
  condition: 'above',
  targetValue: 6,
  enabled: true,
  cooldownMinutes: 60,
  lastEvaluatedAt: null,
  lastTriggeredAt: null,
  createdAt: '2026-08-02T00:00:00.000Z',
};

function buttonWithText(scope: ParentNode, text: string) {
  return Array.from(scope.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => button.textContent?.includes(text));
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function openCreate(container: HTMLElement) {
  await act(async () => buttonWithText(container, 'สร้าง Alert')!.click());
  return document.body.querySelector<HTMLElement>('[role="dialog"]')!;
}

function fields(dialog: HTMLElement) {
  return {
    symbol: dialog.querySelector<HTMLInputElement>('input[placeholder="เช่น AAPL"]')!,
    target: dialog.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!,
    cooldown: dialog.querySelector<HTMLInputElement>('input[type="number"]')!,
    form: dialog.querySelector<HTMLFormElement>('form')!,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  window.requestAnimationFrame = (callback) => window.setTimeout(callback, 0);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);
  Object.values(mocks).forEach((mock) => mock.mockReset());
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.style.overflow = '';
});

describe('Price Alert target input', () => {
  it('starts empty, preserves typed decimals and clears without injecting a leading zero', async () => {
    await act(async () => root.render(<AlertsClient initialAlerts={[]} />));
    const dialog = await openCreate(container);
    const { target } = fields(dialog);
    expect(target.value).toBe('');
    expect(target.placeholder).toBe('เช่น 150.50');

    await act(async () => setInput(target, '6'));
    expect(target.value).toBe('6');
    await act(async () => setInput(target, ''));
    expect(target.value).toBe('');
    await act(async () => setInput(target, '.5'));
    expect(target.value).toBe('.5');
  });

  it('formats an existing value without a leading zero', async () => {
    await act(async () => root.render(<AlertsClient initialAlerts={[savedAlert]} />));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="แก้ไข AAPL"]')!.click());
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(fields(dialog).target.value).toBe('6');
  });

  it.each(['', '0', '-1', 'NaN', 'Infinity', '1e3', '+5'])('rejects invalid target %j', (value) => {
    expect(parsePositiveDecimal(value)).toBeNull();
  });

  it.each([
    ['6', 6],
    ['150.50', 150.5],
    ['.5', 0.5],
    ['6.', 6],
  ])('accepts decimal target %j', (value, expected) => {
    expect(parsePositiveDecimal(value)).toBe(expected);
  });

  it('shows the required error and does not call the server for scientific notation', async () => {
    await act(async () => root.render(<AlertsClient initialAlerts={[]} />));
    const dialog = await openCreate(container);
    const { symbol, target, form } = fields(dialog);
    await act(async () => {
      setInput(symbol, 'aapl');
      setInput(target, '1e3');
    });
    await act(async () => form.requestSubmit());
    expect(document.body.textContent).toContain('กรุณาใส่ราคาเป้าหมายที่มากกว่า 0');
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('Price Alert modal submission', () => {
  it('disables incomplete saves, prevents double-submit, preserves failed input, then closes and refreshes on retry', async () => {
    let resolveCreate: ((value: unknown) => void) | undefined;
    mocks.create.mockImplementationOnce(() => new Promise((resolve) => {
      resolveCreate = resolve;
    }));
    await act(async () => root.render(<AlertsClient initialAlerts={[]} />));
    const dialog = await openCreate(container);
    const { symbol, target, form } = fields(dialog);
    const save = buttonWithText(dialog, 'บันทึกการแจ้งเตือน')!;
    expect(save.disabled).toBe(true);

    await act(async () => {
      setInput(symbol, ' aapl ');
      setInput(target, '6.25');
    });
    expect(save.disabled).toBe(false);

    await act(async () => {
      form.requestSubmit();
      form.requestSubmit();
      await Promise.resolve();
    });
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.create).toHaveBeenCalledWith({
      symbol: 'AAPL',
      condition: 'above',
      targetValue: 6.25,
      cooldownMinutes: 60,
      enabled: true,
    });
    expect(buttonWithText(dialog, 'กำลังบันทึก...')).toBeDefined();
    expect(buttonWithText(dialog, 'ยกเลิก')?.disabled).toBe(true);
    expect(dialog.querySelector<HTMLButtonElement>('button[aria-label="ปิดหน้าต่าง"]')?.disabled).toBe(true);

    await act(async () => {
      resolveCreate?.({ ok: false, code: 'database', message: 'ลองใหม่' });
      await Promise.resolve();
    });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(fields(dialog).symbol.value).toBe(' AAPL ');
    expect(fields(dialog).target.value).toBe('6.25');
    expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));

    mocks.create.mockResolvedValueOnce({ ok: true, alert: { ...savedAlert, targetValue: 6.25 } });
    await act(async () => {
      form.requestSubmit();
      await Promise.resolve();
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.addToast).toHaveBeenLastCalledWith({
      title: 'สร้างการแจ้งเตือนแล้ว',
      type: 'success',
    });
  });

  it('submits from the form owner and cancel/X close only the modal', async () => {
    mocks.create.mockResolvedValue({ ok: true, alert: savedAlert });
    await act(async () => root.render(<AlertsClient initialAlerts={[]} />));
    let dialog = await openCreate(container);
    let current = fields(dialog);
    await act(async () => {
      setInput(current.symbol, 'AAPL');
      setInput(current.target, '6');
      current.form.requestSubmit();
      await Promise.resolve();
    });
    expect(mocks.create).toHaveBeenCalledOnce();

    dialog = await openCreate(container);
    await act(async () => buttonWithText(dialog, 'ยกเลิก')!.click());
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.back).not.toHaveBeenCalled();

    dialog = await openCreate(container);
    await act(async () => dialog.querySelector<HTMLButtonElement>('button[aria-label="ปิดหน้าต่าง"]')!.click());
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.back).not.toHaveBeenCalled();
  });
});
