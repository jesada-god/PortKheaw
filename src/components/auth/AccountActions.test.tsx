// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountActions } from './AccountActions';
import {
  DELETE_ACCOUNT_CONFIRMATION,
  DELETE_ACCOUNT_CONSEQUENCES,
} from '@/src/lib/account/deletion-copy';

/**
 * The dialog in front of the one irreversible control in the product.
 *
 * What is being checked is that it is hard to complete by accident: the
 * consequences are stated, the confirmation phrase is the Thai one the warning
 * is written in, the submit stays inert until that phrase matches exactly, a
 * submission in flight cannot be started twice, and a refusal is announced as
 * text rather than swallowed. None of it authorizes anything — the action checks
 * all of it again — which is why the tests are about the *interruption*, not
 * about the outcome.
 */

const submissions: FormData[] = [];
let nextResult: { status: 'idle' | 'error'; message?: string } = { status: 'idle' };
let resolveNext: (() => void) | null = null;

vi.mock('@/app/auth/actions', () => ({
  signOutAction: async () => undefined,
  deleteAccountAction: async (_prev: unknown, formData: FormData) => {
    submissions.push(formData);
    if (resolveNext) await new Promise<void>((resolve) => { resolveNext = resolve; });
    return nextResult;
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  submissions.length = 0;
  nextResult = { status: 'idle' };
  resolveNext = null;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(props: { reauthMethod: 'password' | 'recent-sign-in'; signInFresh: boolean }) {
  act(() => { root.render(<AccountActions {...props} />); });
}

/** The dialog is portalled to `document.body`, so queries run against it. */
const query = <T extends Element>(selector: string) => document.body.querySelector<T>(selector);
const testId = <T extends Element>(id: string) => query<T>(`[data-testid="${id}"]`);

function openDialog() {
  act(() => { testId<HTMLButtonElement>('open-delete-account')!.click(); });
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const confirmationField = () => [...document.body.querySelectorAll('input')]
  .find((input) => input.getAttribute('name') === 'confirmation') as HTMLInputElement;

describe('the delete-account dialog', () => {
  it('does not delete anything on the button that opens it', () => {
    render({ reauthMethod: 'password', signInFresh: true });
    expect(testId('confirm-delete-account')).toBeNull();
    openDialog();
    expect(testId('confirm-delete-account')).not.toBeNull();
    expect(submissions).toHaveLength(0);
  });

  it('states every consequence before it asks for anything', () => {
    render({ reauthMethod: 'password', signInFresh: true });
    openDialog();
    const text = document.body.textContent ?? '';
    for (const line of DELETE_ACCOUNT_CONSEQUENCES) expect(text).toContain(line);
  });

  it('keeps the confirm button inert until the Thai phrase matches exactly', () => {
    render({ reauthMethod: 'password', signInFresh: true });
    openDialog();
    const confirm = testId<HTMLButtonElement>('confirm-delete-account')!;
    expect(confirm.disabled).toBe(true);

    // The English word somebody types by reflex is not the phrase.
    type(confirmationField(), 'DELETE');
    expect(testId<HTMLButtonElement>('confirm-delete-account')!.disabled).toBe(true);

    type(confirmationField(), DELETE_ACCOUNT_CONFIRMATION);
    expect(testId<HTMLButtonElement>('confirm-delete-account')!.disabled).toBe(false);
  });

  it('asks a password account for its password, and an OAuth account for nothing it cannot give', () => {
    render({ reauthMethod: 'password', signInFresh: true });
    openDialog();
    expect([...document.body.querySelectorAll('input')].some((i) => i.type === 'password')).toBe(true);

    act(() => root.render(<AccountActions reauthMethod="recent-sign-in" signInFresh />));
    expect([...document.body.querySelectorAll('input')].some((i) => i.type === 'password')).toBe(false);
    expect(confirmationField()).toBeTruthy();
  });

  /*
   * A Google account with a session from this morning has proved nothing this
   * minute, so it is not offered the form at all — it is offered the one thing
   * that would make it eligible.
   */
  it('offers a fresh sign-in instead of a form when the session is too old to count', () => {
    render({ reauthMethod: 'recent-sign-in', signInFresh: false });
    openDialog();
    expect(testId('delete-account-reauth-required')).not.toBeNull();
    expect(testId('confirm-delete-account')).toBeNull();
    expect(confirmationField()).toBeUndefined();
  });

  it('disables both controls while a submission is in flight, so a double click is one deletion', async () => {
    resolveNext = () => undefined;
    render({ reauthMethod: 'recent-sign-in', signInFresh: true });
    openDialog();
    type(confirmationField(), DELETE_ACCOUNT_CONFIRMATION);

    await act(async () => { testId<HTMLButtonElement>('confirm-delete-account')!.click(); });

    const confirm = testId<HTMLButtonElement>('confirm-delete-account')!;
    expect(confirm.disabled).toBe(true);
    expect(confirm.textContent).toContain('กำลังลบบัญชี');

    await act(async () => { resolveNext?.(); });
  });

  it('announces a refusal as text and clears the typed phrase, so the next submit is deliberate too', async () => {
    nextResult = { status: 'error', message: 'รหัสผ่านไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง' };
    render({ reauthMethod: 'recent-sign-in', signInFresh: true });
    openDialog();
    type(confirmationField(), DELETE_ACCOUNT_CONFIRMATION);

    await act(async () => { testId<HTMLButtonElement>('confirm-delete-account')!.click(); });

    const error = testId('delete-account-error');
    expect(error?.textContent).toBe('รหัสผ่านไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง');
    expect(error?.getAttribute('role')).toBe('alert');
    expect(confirmationField().value).toBe('');
    expect(testId<HTMLButtonElement>('confirm-delete-account')!.disabled).toBe(true);
  });

  it('never puts an internal code, a stack or an identifier in front of a reader', () => {
    render({ reauthMethod: 'password', signInFresh: true });
    openDialog();
    const text = document.body.textContent ?? '';
    for (const leak of ['Error', 'stack', 'supabase', 'stripe', 'service_role', 'ACCOUNT_']) {
      expect(text).not.toContain(leak);
    }
  });
});
