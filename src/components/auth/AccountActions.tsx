'use client';

import { useActionState, useId, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { AlertTriangle, LogOut, Trash2 } from 'lucide-react';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { Modal } from '@/src/components/ui/Modal';
import {
  DELETE_ACCOUNT_CONFIRMATION,
  DELETE_ACCOUNT_CONSEQUENCES,
  IDLE_DELETE_ACCOUNT_STATE,
} from '@/src/lib/account/deletion-copy';
import { deleteAccountAction, signOutAction } from '@/app/auth/actions';

/**
 * The account controls, and the one irreversible thing on this page.
 *
 * The delete button opens a dialog rather than submitting, and the dialog is
 * built to be *hard to complete by accident and easy to complete on purpose*:
 * the consequences are listed before the fields, the confirmation phrase is in
 * the language the warning is written in, and the submit button stays disabled
 * until that phrase matches.
 *
 * Re-authentication is decided on the server and described here. An account with
 * a password re-enters it; an account that signs in with Google cannot, so it is
 * asked for a recent sign-in instead and told exactly that when its session is
 * too old. Nothing on this screen decides whether the deletion may proceed — the
 * action checks all of it again.
 */
export function AccountActions({
  reauthMethod,
  signInFresh,
}: {
  /** How this account can prove itself, read from its provider identities. */
  reauthMethod: 'password' | 'recent-sign-in';
  /** Whether the provider was asked for this session recently enough to count. */
  signInFresh: boolean;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [state, formAction] = useActionState(deleteAccountAction, IDLE_DELETE_ACCOUNT_STATE);
  const [confirmation, setConfirmation] = useState('');
  const confirmationId = useId();
  const passwordId = useId();
  const errorId = useId();
  const confirmationRef = useRef<HTMLInputElement>(null);

  /*
   * A failed attempt must not leave a typed phrase sitting in the field, or the
   * next submit is one click away from being unintentional.
   *
   * Adjusted during render against the previous action state rather than in an
   * effect: the field is derived from "has the answer changed since I last
   * looked", and an effect would render the stale value once before clearing it.
   */
  const [seenState, setSeenState] = useState(state);
  if (state !== seenState) {
    setSeenState(state);
    if (state.status === 'error') setConfirmation('');
  }

  const needsFreshSignIn = reauthMethod === 'recent-sign-in' && !signInFresh;
  const phraseMatches = confirmation.trim() === DELETE_ACCOUNT_CONFIRMATION;

  function close() {
    setDeleteOpen(false);
    setConfirmation('');
  }

  return (
    <div className="space-y-3">
      <form action={signOutAction}>
        <Button type="submit" variant="outline" className="w-full">
          <LogOut aria-hidden="true" size={16} className="mr-2" />ออกจากระบบ
        </Button>
      </form>
      <Button
        type="button"
        variant="danger"
        className="w-full"
        onClick={() => setDeleteOpen(true)}
        data-testid="open-delete-account"
      >
        <Trash2 aria-hidden="true" size={16} className="mr-2" />ลบบัญชี
      </Button>

      <Modal
        isOpen={deleteOpen}
        onClose={close}
        title="ลบบัญชีถาวร"
        initialFocusRef={confirmationRef}
      >
        <div className="space-y-4">
          <p className="flex items-start gap-2 rounded-xl border border-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] p-3 text-sm leading-6 text-[var(--text)]">
            <AlertTriangle aria-hidden="true" size={18} className="mt-0.5 shrink-0 text-[var(--danger)]" />
            <span>การลบบัญชีทำแล้วย้อนกลับไม่ได้ กรุณาอ่านให้ครบก่อนยืนยัน</span>
          </p>

          <ul className="list-disc space-y-2 pl-5 text-sm leading-6 text-[var(--text-secondary)]">
            {DELETE_ACCOUNT_CONSEQUENCES.map((line) => <li key={line}>{line}</li>)}
          </ul>

          {needsFreshSignIn ? (
            /* No password to re-enter, and the last sign-in is too old to count
               as proof. The way forward is a fresh one, so that is what is
               offered — the form is not rendered at all. */
            <div className="space-y-3" data-testid="delete-account-reauth-required">
              <p className="text-sm leading-6 text-[var(--warning)]">
                เพื่อความปลอดภัย กรุณาออกจากระบบและเข้าสู่ระบบด้วย Google อีกครั้ง แล้วกลับมาที่หน้านี้เพื่อลบบัญชี
              </p>
              <form action={signOutAction}>
                <Button type="submit" variant="outline" className="w-full">
                  <LogOut aria-hidden="true" size={16} className="mr-2" />ออกจากระบบเพื่อยืนยันตัวตนใหม่
                </Button>
              </form>
              <Button type="button" variant="outline" className="w-full" onClick={close}>ยกเลิก</Button>
            </div>
          ) : (
            <form action={formAction} className="space-y-4">
              {reauthMethod === 'password' && (
                <div>
                  <label htmlFor={passwordId} className="mb-1.5 block text-sm text-[var(--text-secondary)]">
                    ยืนยันตัวตนด้วยรหัสผ่านของคุณ
                  </label>
                  <Input
                    id={passwordId}
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    aria-describedby={state.status === 'error' ? errorId : undefined}
                  />
                </div>
              )}

              <div>
                <label htmlFor={confirmationId} className="mb-1.5 block text-sm text-[var(--text-secondary)]">
                  พิมพ์ “{DELETE_ACCOUNT_CONFIRMATION}” เพื่อยืนยัน
                </label>
                <Input
                  id={confirmationId}
                  ref={confirmationRef}
                  name="confirmation"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  required
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  aria-describedby={state.status === 'error' ? errorId : undefined}
                />
              </div>

              {state.status === 'error' && state.message && (
                <p id={errorId} role="alert" data-testid="delete-account-error" className="text-sm leading-6 text-[var(--danger)]">
                  {state.message}
                </p>
              )}

              <DeleteFormControls onCancel={close} canSubmit={phraseMatches} />
            </form>
          )}
        </div>
      </Modal>
    </div>
  );
}

/**
 * The buttons, in their own component so `useFormStatus` can see the submission.
 *
 * `pending` disables both controls, which is what makes a double-click one
 * deletion rather than two attempts racing each other through the pipeline.
 */
function DeleteFormControls({ onCancel, canSubmit }: { onCancel: () => void; canSubmit: boolean }) {
  const { pending } = useFormStatus();
  return (
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>ยกเลิก</Button>
      <Button type="submit" variant="danger" disabled={pending || !canSubmit} data-testid="confirm-delete-account">
        {pending ? 'กำลังลบบัญชี…' : 'ลบบัญชีถาวร'}
      </Button>
    </div>
  );
}
