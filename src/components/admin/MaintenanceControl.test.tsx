// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The toggle, pinned in both directions.
 *
 * This exists because of a real production regression: the control mapped its
 * own `'enable'`/`'disable'` names onto the wrong boolean, so pressing
 * "ปิดใช้งานเพื่ออัปเดต" asked the server to switch maintenance *off*. The
 * routine answered `unchanged` — correctly, it was already off — and the console
 * showed a green chip beside "สถานะไม่มีการเปลี่ยนแปลง".
 *
 * The assertions that matter are therefore about the *value sent*, not about the
 * button that was clicked. A test that only checked "the action was called"
 * would have passed throughout the bug.
 */

const setMaintenance = vi.fn<(formData: FormData) => Promise<unknown>>();
const refresh = vi.fn();

vi.mock('@/app/admin/system/actions', () => ({
  setMaintenanceAction: (formData: FormData) => setMaintenance(formData),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, replace: vi.fn(), push: vi.fn() }),
}));

const { MaintenanceControl } = await import('./MaintenanceControl');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const BASE = {
  message: null,
  expectedResumeAt: null,
  startedAt: null,
  startedByLabel: null,
  audit: [],
  releaseNotesHref: '/admin/system?compose=1',
};

beforeEach(() => {
  setMaintenance.mockReset();
  refresh.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(enabled: boolean): void {
  act(() => root.render(<MaintenanceControl {...BASE} enabled={enabled} />));
}

function click(testId: string): void {
  const node = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!node) throw new Error(`missing control: ${testId}`);
  act(() => { node.click(); });
}

/** The "ยืนยัน" button inside the confirmation dialog. */
async function confirm(): Promise<void> {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
    .find((candidate) => candidate.textContent?.includes('ยืนยัน'));
  if (!button) throw new Error('confirmation button not rendered');
  await act(async () => { button.click(); });
}

function status(): string {
  return document.querySelector('[data-testid="maintenance-status"]')?.textContent ?? '';
}

function sentEnabled(callIndex = 0): string | null {
  const formData = setMaintenance.mock.calls[callIndex]?.[0];
  const value = formData?.get('enabled');
  return typeof value === 'string' ? value : null;
}

describe('the maintenance toggle sends the state it names', () => {
  it('OFF → "ปิดใช้งานเพื่ออัปเดต" asks for maintenance ON and turns the chip orange', async () => {
    setMaintenance.mockResolvedValue({ ok: true, enabled: true, message: 'ปิดใช้งานแล้ว' });
    render(false);
    expect(status()).toContain('เปิดใช้งาน');

    click('maintenance-suspend');
    await confirm();

    expect(sentEnabled()).toBe('true');
    expect(status()).toContain('กำลังปรับปรุงระบบ');
    expect(status()).toContain('🟠');
    expect(refresh).toHaveBeenCalled();
  });

  it('ON → "เปิดใช้งานแอป" asks for maintenance OFF and turns the chip green', async () => {
    setMaintenance.mockResolvedValue({ ok: true, enabled: false, message: 'เปิดใช้งานแล้ว' });
    render(true);
    expect(status()).toContain('กำลังปรับปรุงระบบ');

    click('maintenance-resume');
    await confirm();

    expect(sentEnabled()).toBe('false');
    expect(status()).toContain('เปิดใช้งาน');
    expect(status()).toContain('🟢');
    expect(refresh).toHaveBeenCalled();
  });

  /*
   * The same inversion reached this button: saving the notice mid-window sent
   * `false`, which would have ended the outage because somebody fixed a typo.
   */
  it('saving the notice during a window keeps maintenance ON', async () => {
    setMaintenance.mockResolvedValue({ ok: true, enabled: true, message: 'บันทึกแล้ว' });
    render(true);

    click('maintenance-save-message');
    await act(async () => {});

    expect(sentEnabled()).toBe('true');
    expect(status()).toContain('กำลังปรับปรุงระบบ');
  });

  it('offers the announcement when the app comes back, not when it goes down', async () => {
    setMaintenance.mockResolvedValue({ ok: true, enabled: true, message: 'ปิดใช้งานแล้ว' });
    render(false);
    click('maintenance-suspend');
    await confirm();
    expect(document.body.textContent).not.toContain('ต้องการเขียนประกาศ');

    act(() => root.unmount());
    root = createRoot(container);
    setMaintenance.mockResolvedValue({ ok: true, enabled: false, message: 'เปิดใช้งานแล้ว' });
    render(true);
    click('maintenance-resume');
    await confirm();
    expect(document.body.textContent).toContain('ต้องการเขียนประกาศ');
  });
});

describe('a mutation that did not do what was asked says so', () => {
  it('reports a refusal as an error and leaves the chip where it was', async () => {
    setMaintenance.mockResolvedValue({ ok: false, message: 'บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้' });
    render(false);

    click('maintenance-suspend');
    await confirm();

    expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain('บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้');
    expect(status()).toContain('เปิดใช้งาน');
    expect(refresh).not.toHaveBeenCalled();
  });

  /*
   * The message the regression hid behind. `unchanged` now names the state the
   * switch is actually in, so it can never again read as "nothing happened"
   * beside a chip that disagrees.
   */
  it('an already-in-that-state answer names the state rather than saying nothing changed', async () => {
    setMaintenance.mockResolvedValue({
      ok: true, enabled: true, message: 'ระบบอยู่ในสถานะปิดปรับปรุงอยู่แล้ว (ข้อความและเวลาไม่มีการเปลี่ยนแปลง)',
    });
    render(false);

    click('maintenance-suspend');
    await confirm();

    const alert = document.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alert).not.toBe('สถานะไม่มีการเปลี่ยนแปลง');
    expect(alert).toContain('ปิดปรับปรุงอยู่แล้ว');
    // The chip follows the reported state, not the stale prop.
    expect(status()).toContain('กำลังปรับปรุงระบบ');
  });
});

describe('double submit and stale responses', () => {
  it('ignores a second confirm while the first is still in flight', async () => {
    let release: ((value: unknown) => void) | null = null;
    setMaintenance.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    render(false);

    click('maintenance-suspend');
    const button = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
      .find((candidate) => candidate.textContent?.includes('ยืนยัน'));
    act(() => { button?.click(); });
    act(() => { button?.click(); });
    act(() => { button?.click(); });

    expect(setMaintenance).toHaveBeenCalledTimes(1);
    await act(async () => { release?.({ ok: true, enabled: true, message: 'ok' }); });
  });
});
