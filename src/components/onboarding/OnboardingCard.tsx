'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, Compass, X } from 'lucide-react';
import {
  chooseOnboardingPathAction,
  completeOnboardingHintAction,
  dismissOnboardingAction,
} from '@/app/onboarding/actions';
import type { OnboardingView } from '@/src/lib/onboarding/onboarding';

/**
 * One question, or one hint, or nothing.
 *
 * It is a card at the top of Home rather than a modal, and that is the whole
 * design: a reader who wants to get on with looking at their portfolio simply
 * scrolls past it, and one nobody wants is gone in one tap and never returns.
 * There is no step counter, no next button and no way to be trapped — every
 * choice is a link into a flow that already existed.
 */
export function OnboardingCard({ view }: { view: OnboardingView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  /*
   * Hidden the moment the reader acts, without waiting for the round trip. The
   * write is what makes it permanent; this is what makes it feel answered.
   */
  const [hidden, setHidden] = useState(false);

  if (view.kind === 'none' || hidden) return null;

  function choose(path: string) {
    setHidden(true);
    startTransition(async () => {
      const result = await chooseOnboardingPathAction(path);
      if (result.href) router.push(result.href);
    });
  }

  function dismiss() {
    setHidden(true);
    startTransition(async () => { await dismissOnboardingAction(); });
  }

  function finishHint(href?: string) {
    setHidden(true);
    startTransition(async () => {
      await completeOnboardingHintAction();
      if (href) router.push(href);
    });
  }

  if (view.kind === 'question') {
    return (
      <section
        className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5"
        data-testid="onboarding-question"
      >
        <div className="flex min-w-0 items-start justify-between gap-3">
          <h2 className="flex min-w-0 items-center gap-2 text-base font-bold text-[var(--text)]">
            <Compass aria-hidden="true" size={18} className="shrink-0 text-[var(--accent)]" />
            อยากเริ่มจากอะไร?
          </h2>
          <button
            type="button"
            onClick={dismiss}
            disabled={pending}
            aria-label="ปิดคำถามเริ่มต้นใช้งาน"
            data-testid="onboarding-dismiss"
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)]"
          >
            <X size={18} />
          </button>
        </div>
        <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
          เลือกหนึ่งอย่างเพื่อเริ่ม เปลี่ยนใจภายหลังได้เสมอ และข้ามได้ถ้ายังไม่อยากเลือก
        </p>
        <div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2">
          {view.choices.map((choice) => (
            <button
              key={choice.path}
              type="button"
              disabled={pending}
              onClick={() => choose(choice.path)}
              data-testid={`onboarding-choice-${choice.path}`}
              className="flex min-h-16 min-w-0 items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-elevated)] p-3 text-left transition-colors hover:border-[var(--accent)] disabled:opacity-50"
            >
              <span className="min-w-0 flex-1">
                <strong className="block break-words text-sm text-[var(--text)]">{choice.label}</strong>
                <span className="mt-0.5 block break-words text-xs leading-5 text-[var(--text-muted)]">{choice.detail}</span>
              </span>
              <ChevronRight aria-hidden="true" size={16} className="shrink-0 text-[var(--text-muted)]" />
            </button>
          ))}
        </div>
      </section>
    );
  }

  return (
    <section
      className="flex min-w-0 flex-wrap items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4"
      data-testid="onboarding-hint"
      data-path={view.hint.path}
    >
      <p className="min-w-0 flex-1 break-words text-sm leading-6 text-[var(--text-secondary)]">
        {view.hint.text}
      </p>
      <button
        type="button"
        disabled={pending}
        onClick={() => finishHint(view.hint.href)}
        data-testid="onboarding-hint-action"
        className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-xl bg-[var(--accent)] px-4 text-sm font-bold text-[var(--accent-fg)] disabled:opacity-50"
      >
        {view.hint.actionLabel}
        <ChevronRight aria-hidden="true" size={16} />
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => finishHint()}
        aria-label="ไม่ต้องแสดงคำแนะนำนี้อีก"
        data-testid="onboarding-hint-dismiss"
        className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-[var(--text-muted)] hover:bg-[var(--surface-hover)]"
      >
        <X size={18} />
      </button>
    </section>
  );
}
