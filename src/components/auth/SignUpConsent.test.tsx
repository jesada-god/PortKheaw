// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The consent line under the create-account button.
 *
 * It is informational, and these tests pin exactly that: the sentence and its
 * two policy links are present, and the form around it gained no checkbox, no
 * extra field and no new required input — creating the account is still the
 * whole of the acceptance, as the Terms themselves say.
 */
vi.mock('server-only', () => ({}));
vi.mock('@/app/auth/actions', () => ({
  signUpAction: async () => ({ status: 'idle' as const }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: {
    href: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

import { SignUpForm } from './SignUpForm';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<SignUpForm next="/" />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function links(): HTMLAnchorElement[] {
  return [...container.querySelectorAll('a')] as HTMLAnchorElement[];
}

describe('sign-up consent copy', () => {
  it('states the acceptance under the create-account action', () => {
    const text = container.textContent ?? '';
    expect(text).toContain('เมื่อสร้างบัญชี ถือว่าคุณยอมรับ');
    expect(text).toContain('ข้อกำหนดการใช้งาน');
    expect(text).toContain('และรับทราบ');
    expect(text).toContain('นโยบายความเป็นส่วนตัว');
  });

  it('points each policy at the route that already serves it', () => {
    const terms = links().find((link) => link.textContent === 'ข้อกำหนดการใช้งาน');
    const privacy = links().find((link) => link.textContent === 'นโยบายความเป็นส่วนตัว');
    expect(terms?.getAttribute('href')).toBe('/terms');
    expect(privacy?.getAttribute('href')).toBe('/privacy');
  });

  it('adds no consent control to the form', () => {
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    const named = [...container.querySelectorAll('input')].map((input) => input.name).sort();
    expect(named).toEqual(['email', 'fullName', 'next', 'password']);
    expect(container.querySelector('button[type="submit"]')?.textContent)
      .toContain('สร้างบัญชี');
  });
});
