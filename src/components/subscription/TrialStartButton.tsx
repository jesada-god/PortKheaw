'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { CircleAlert, Sparkles } from 'lucide-react';
import { Button } from '@/src/components/ui/Button';
import { startEliteTrialAction, type StartTrialResult } from '@/app/settings/subscription/actions';

/**
 * The one control that starts the trial.
 *
 * Nothing is unlocked here. The action returns, the router refreshes, and the
 * page re-renders from a freshly read server snapshot — so what the reader sees
 * after a success is the database's answer, not this component's guess.
 */
export function TrialStartButton({ disabled = false }: { disabled?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<StartTrialResult | null>(null);
  /*
   * `useTransition` alone does not close the double-submit window: a second
   * click can land in the same tick as the first, before `pending` has flipped.
   * The ref is the real latch and is read only inside the handler, never during
   * render. It is released on failure; after a success the control disappears
   * with the re-render instead.
   */
  const submitting = useRef(false);

  function start() {
    if (submitting.current || disabled) return;
    submitting.current = true;
    setResult(null);
    startTransition(async () => {
      const outcome = await startEliteTrialAction();
      setResult(outcome);
      if (outcome.ok) router.refresh();
      else submitting.current = false;
    });
  }

  return (
    <div className="flex w-full flex-col gap-3">
      <Button
        type="button"
        size="lg"
        className="w-full sm:w-auto"
        disabled={disabled}
        isLoading={pending}
        onClick={start}
      >
        {!pending && <Sparkles aria-hidden="true" size={18} className="mr-2" />}
        {pending ? 'กำลังเริ่มทดลอง…' : 'ทดลอง Elite ฟรี 7 วัน'}
      </Button>
      {result && !result.ok && (
        <p
          role="alert"
          className="flex items-start gap-2 text-sm text-[var(--negative)]"
        >
          <CircleAlert aria-hidden="true" size={16} className="mt-0.5 shrink-0" />
          <span>{result.message}</span>
        </p>
      )}
      {result?.ok && (
        <p role="status" className="text-sm text-[var(--brand-green)]">
          {result.message}
        </p>
      )}
    </div>
  );
}
