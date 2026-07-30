// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Renders the real forms and inspects the DOM a screen reader and a keyboard
 * would meet: labels bound to inputs, an announced error region, autocomplete
 * hints password managers understand, and a show/hide control that is a button
 * and not a second submit.
 *
 * The server actions are stubbed because none of this is about the network —
 * `useActionState` only needs something callable to hold.
 */
vi.mock('@/app/auth/actions', () => ({
  signInAction: async () => ({ status: 'idle' }),
  signUpAction: async () => ({ status: 'idle' }),
  forgotPasswordAction: async () => ({ status: 'idle' }),
  resetPasswordAction: async () => ({ status: 'idle' }),
}));

vi.mock('@/src/lib/supabase/client', () => ({ createClient: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function render(element: React.ReactElement): void {
  act(() => root.render(element));
}

function labelTextFor(input: HTMLInputElement): string {
  const label = container.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`);
  return label?.textContent ?? '';
}

describe('sign-in form accessibility', () => {
  it('gives every field a bound visible label and the right input semantics', async () => {
    const { SignInForm } = await import('./SignInForm');
    render(<SignInForm next="/portfolio" />);

    const email = container.querySelector<HTMLInputElement>('input[name="email"]')!;
    const password = container.querySelector<HTMLInputElement>('input[name="password"]')!;

    expect(email.id).toBeTruthy();
    expect(labelTextFor(email)).toBe('อีเมล');
    expect(email.type).toBe('email');
    expect(email.getAttribute('autocomplete')).toBe('email');
    expect(email.getAttribute('inputmode')).toBe('email');

    expect(labelTextFor(password)).toBe('รหัสผ่าน');
    expect(password.type).toBe('password');
    // Password managers key off this to offer the saved credential.
    expect(password.getAttribute('autocomplete')).toBe('current-password');
  });

  it('carries the return path in the form, so a deep link survives sign-in', async () => {
    const { SignInForm } = await import('./SignInForm');
    render(<SignInForm next="/stock/AAPL?tab=options" />);
    const hidden = container.querySelector<HTMLInputElement>('input[name="next"]')!;
    expect(hidden.value).toBe('/stock/AAPL?tab=options');
  });

  it('announces a server error and keeps it associated with the field it belongs to', async () => {
    const { AuthField } = await import('./AuthField');
    render(
      <AuthField
        name="email"
        label="อีเมล"
        value="not-an-email"
        onValueChange={() => {}}
        error="กรุณากรอกอีเมลให้ถูกต้อง"
      />,
    );
    const input = container.querySelector<HTMLInputElement>('input[name="email"]')!;
    expect(input.getAttribute('aria-invalid')).toBe('true');

    const describedBy = input.getAttribute('aria-describedby')!;
    expect(describedBy).toBeTruthy();
    const errorNode = document.getElementById(describedBy.split(' ').at(-1)!)!;
    expect(errorNode.getAttribute('role')).toBe('alert');
    expect(errorNode.textContent).toBe('กรุณากรอกอีเมลให้ถูกต้อง');
  });

  it('drops aria-invalid once the field is no longer rejected', async () => {
    const { AuthField } = await import('./AuthField');
    render(<AuthField name="email" label="อีเมล" value="someone@example.com" onValueChange={() => {}} />);
    const input = container.querySelector<HTMLInputElement>('input[name="email"]')!;
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(input.getAttribute('aria-describedby')).toBeNull();
  });
});

describe('password field', () => {
  it('toggles visibility with a labelled button that cannot submit the form', async () => {
    const { PasswordField } = await import('./AuthField');
    render(
      <form>
        <PasswordField name="password" label="รหัสผ่าน" value="secret" onValueChange={() => {}} />
      </form>,
    );

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-pressed]')!;
    const input = container.querySelector<HTMLInputElement>('input[name="password"]')!;

    // A toggle that defaults to type="submit" posts the form on every tap.
    expect(toggle.type).toBe('button');
    expect(toggle.getAttribute('aria-label')).toBe('แสดงรหัสผ่าน');
    expect(input.type).toBe('password');

    act(() => toggle.click());
    expect(container.querySelector<HTMLInputElement>('input[name="password"]')!.type).toBe('text');
    expect(container.querySelector<HTMLButtonElement>('button[aria-pressed]')!.getAttribute('aria-label')).toBe('ซ่อนรหัสผ่าน');
  });

  it('keeps the toggle at a 44px touch target', async () => {
    const { PasswordField } = await import('./AuthField');
    render(<PasswordField name="password" label="รหัสผ่าน" value="" onValueChange={() => {}} />);
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-pressed]')!;
    // h-11/w-11 in Tailwind is 2.75rem = 44px.
    expect(toggle.className).toContain('h-11');
    expect(toggle.className).toContain('w-11');
  });

  it('ticks exactly the requirements the password meets, and states each one for a screen reader', async () => {
    const { PasswordChecklist } = await import('./AuthField');
    const { PASSWORD_RULES } = await import('@/src/lib/auth/password-policy');

    render(<PasswordChecklist password="portkheaw1234" />);
    const rows = [...container.querySelectorAll('li')];
    expect(rows).toHaveLength(PASSWORD_RULES.length);
    const passed = rows.filter((row) => row.textContent?.includes('ผ่านแล้ว'));
    const failed = rows.filter((row) => row.textContent?.includes('ยังไม่ผ่าน'));
    expect(passed).toHaveLength(2);
    expect(failed).toHaveLength(2);
  });
});

describe('sign-up form', () => {
  it('asks for the display name the profile schema actually stores, not a username it has no column for', async () => {
    const { SignUpForm } = await import('./SignUpForm');
    render(<SignUpForm next="/" />);
    const name = container.querySelector<HTMLInputElement>('input[name="fullName"]')!;
    expect(labelTextFor(name)).toBe('ชื่อที่แสดง');
    expect(name.getAttribute('autocomplete')).toBe('name');
    expect(container.querySelector('input[name="username"]')).toBeNull();
  });

  it('marks the password as a new one so managers offer to generate and save it', async () => {
    const { SignUpForm } = await import('./SignUpForm');
    render(<SignUpForm next="/" />);
    const password = container.querySelector<HTMLInputElement>('input[name="password"]')!;
    expect(password.getAttribute('autocomplete')).toBe('new-password');
    expect(container.querySelectorAll('li').length).toBeGreaterThan(0);
  });
});

describe('sign-in page copy', () => {
  it('asks for an email, never "email or username", because username sign-in does not exist', async () => {
    const { SignInForm } = await import('./SignInForm');
    render(<SignInForm next="/" />);
    expect(container.textContent).not.toContain('ชื่อผู้ใช้');
  });

  it('offers no "remember me" control, because the provider exposes no such option', async () => {
    const { SignInForm } = await import('./SignInForm');
    render(<SignInForm next="/" />);
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(container.textContent).not.toContain('จดจำ');
  });
});
