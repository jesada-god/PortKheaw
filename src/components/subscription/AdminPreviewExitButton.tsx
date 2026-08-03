'use client';

import { useTransition } from 'react';
import { clearAdminAccessPreviewAction } from '@/app/settings/subscription/actions';
import { reloadAfterAccessChange } from './admin-preview-reload';

/**
 * The way out, on every page.
 *
 * It calls the trusted action and nothing else — no local state pretends the
 * preview has ended. When the server confirms, the page is reloaded rather than
 * merely re-rendered, because leaving a preview is a downgrade for every premium
 * surface that is currently mounted and a full reload is the only thing that
 * provably drops all of their in-memory state.
 */
export function AdminPreviewExitButton() {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      data-testid="admin-preview-exit"
      disabled={pending}
      onClick={() => startTransition(async () => {
        const result = await clearAdminAccessPreviewAction();
        if (result.ok) reloadAfterAccessChange();
      })}
      className="inline-flex min-h-8 shrink-0 items-center rounded-full border border-[var(--role-admin)] px-3 text-[11px] font-semibold text-[var(--role-admin)] motion-safe:transition-colors hover:bg-[color-mix(in_srgb,var(--role-admin)_18%,transparent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] disabled:opacity-60"
    >
      {pending ? 'กำลังกลับสู่สิทธิ์จริง…' : 'กลับสู่สิทธิ์จริง'}
    </button>
  );
}
