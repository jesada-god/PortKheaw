// @vitest-environment jsdom

import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Switch } from './Switch';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Fixture({ disabled = false, onChange = () => undefined }: {
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
}) {
  const [checked, setChecked] = useState(false);
  return <Switch
    checked={checked}
    disabled={disabled}
    label="ข้อความตั้งค่าที่ยาวมากและต้องยอมให้ตัดบรรทัดโดยไม่ดันสวิตช์ออกนอกกรอบ"
    onCheckedChange={(next) => {
      setChecked(next);
      onChange(next);
    }}
  />;
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
});

describe('Switch', () => {
  it('keeps a fixed border-box track and places the knob inside its grid in off and on states', async () => {
    await act(async () => root.render(<Fixture />));
    const control = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    const knob = control.querySelector<HTMLElement>('span')!;

    expect(control.className).toContain('box-border');
    expect(control.className).toContain('flex-none');
    expect(control.className).toContain('h-11');
    expect(control.className).toContain('w-14');
    expect(control.className).toContain('grid-cols-2');
    expect(control.className).toContain('focus-visible:ring-2');
    expect(control.getAttribute('aria-checked')).toBe('false');
    expect(knob.className).toContain('col-start-1');
    expect(knob.className).not.toContain('absolute');

    await act(async () => control.click());
    expect(control.getAttribute('aria-checked')).toBe('true');
    expect(knob.className).toContain('col-start-2');
    expect(knob.className).not.toContain('absolute');
  });

  it('does not change while disabled', async () => {
    const changed = vi.fn();
    await act(async () => root.render(<Fixture disabled onChange={changed} />));
    const control = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await act(async () => control.click());
    expect(control.disabled).toBe(true);
    expect(control.getAttribute('aria-checked')).toBe('false');
    expect(changed).not.toHaveBeenCalled();
  });
});
