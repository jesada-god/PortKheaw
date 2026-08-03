import Link from 'next/link';
import { CircleCheck, MailWarning, ShieldCheck } from 'lucide-react';
import { BrandMark } from '@/src/components/brand/BrandMark';
import { TrialCountdown } from './TrialCountdown';
import { TrialStartButton } from './TrialStartButton';
import { planDescriptor } from '@/src/lib/subscription/plan-catalog';
import {
  formatBangkokDateTime,
  TRIAL_DURATION_DAYS,
  type TrialState,
} from '@/src/lib/subscription/trial';
import type { SubscriptionTier } from '@/src/lib/subscription/subscription-types';

/** The reassurance that belongs beside the button, never on its own elsewhere. */
const NO_CARD_NOTE = 'ไม่ต้องใช้บัตร และไม่มีการหักเงินอัตโนมัติ';

function StatusBadge({ tone, children }: { tone: 'trial' | 'paid' | 'free'; children: string }) {
  const palette = {
    trial: 'border-[var(--brand-green)] text-[var(--brand-green)] bg-[color-mix(in_srgb,var(--brand-green)_12%,transparent)]',
    paid: 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-soft)]',
    free: 'border-[var(--border-strong)] text-[var(--text-secondary)] bg-[var(--surface-hover)]',
  }[tone];
  return (
    <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${palette}`}>
      {children}
    </span>
  );
}

function planNameFor(tier: SubscriptionTier): string {
  return planDescriptor(tier).name;
}

/**
 * The Current Plan hero. Every fact on it — the plan, the trial window, whether
 * the mailbox is confirmed — arrives already resolved from the server, so the
 * card renders one state and there is never a second trial call to action
 * elsewhere on the page.
 */
export function CurrentPlanHero({
  state,
  effectiveTier,
  trialBlockedReason,
}: {
  state: TrialState;
  effectiveTier: SubscriptionTier;
  /**
   * Set when the reader is eligible for the trial but must not be offered it —
   * today, an administrator, whose single real grant would be spent for nothing.
   * The control stays visible and inert so the reason sits on the thing it
   * blocks, exactly as the unconfirmed-mailbox case does.
   */
  trialBlockedReason?: string;
}) {
  return (
    <section
      aria-labelledby="current-plan-heading"
      className="relative overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--surface-elevated)] p-5 shadow-[var(--shadow)] sm:p-7"
    >
      {/* A single soft wash of the mascot's own green. Decorative, so it is
          hidden from assistive technology and never carries meaning alone. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_100%_at_100%_0%,color-mix(in_srgb,var(--brand-green)_16%,transparent),transparent_62%)]"
      />
      <div className="relative flex flex-col gap-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-2">
            <p className="text-xs font-medium tracking-wide text-[var(--text-muted)]">แพ็กเกจปัจจุบัน</p>
            <h2 id="current-plan-heading" className="text-2xl font-bold text-[var(--text)] sm:text-3xl">
              {planNameFor(effectiveTier)}
            </h2>
            <HeroSummary state={state} />
          </div>
          {/* Kheaw is support, not the subject: one small mark, and it steps out
              entirely at 320px so the text column keeps its width. */}
          <span className="hidden shrink-0 rounded-2xl bg-[var(--brand-mark-bg)] p-2 min-[360px]:block sm:p-2.5">
            <BrandMark className="h-10 w-10 sm:h-12 sm:w-12" />
          </span>
        </div>
        <HeroAction state={state} trialBlockedReason={trialBlockedReason} />
      </div>
    </section>
  );
}

function HeroSummary({ state }: { state: TrialState }) {
  if (state.kind === 'trialing') {
    return (
      <div className="space-y-2">
        <StatusBadge tone="trial">Elite Trial</StatusBadge>
        <p className="text-sm text-[var(--text-secondary)]">
          เหลืออีก <TrialCountdown endsAt={state.endsAt} initialRemainingMs={state.remainingMs} />
          {' · '}หมดอายุ {formatBangkokDateTime(state.endsAt)}
        </p>
      </div>
    );
  }
  if (state.kind === 'paid') {
    return (
      <div className="space-y-2">
        <StatusBadge tone="paid">{planNameFor(state.tier)}</StatusBadge>
        <p className="text-sm text-[var(--text-secondary)]">
          แพ็กเกจของคุณใช้งานได้เต็มรูปแบบอยู่แล้ว
        </p>
      </div>
    );
  }
  if (state.kind === 'used') {
    return (
      <div className="space-y-2">
        <StatusBadge tone="free">ฟรีตลอดชีพ</StatusBadge>
        <p className="text-sm text-[var(--text-secondary)]">
          ช่วงทดลอง Elite ของคุณสิ้นสุดแล้ว ข้อมูลทั้งหมดยังอยู่ครบและเปิดดูได้ตามปกติ
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <StatusBadge tone="free">ฟรีตลอดชีพ</StatusBadge>
      <p className="text-sm text-[var(--text-secondary)]">
        เปิดใช้ Elite ได้ {TRIAL_DURATION_DAYS} วันเต็ม เพื่อดูว่าเครื่องมือชุดเต็มช่วยพอร์ตคุณได้แค่ไหน
      </p>
    </div>
  );
}

function HeroAction({ state, trialBlockedReason }: { state: TrialState; trialBlockedReason?: string }) {
  if (state.kind === 'eligible' && trialBlockedReason) {
    return (
      <div className="flex flex-col gap-3 border-t border-[var(--border)] pt-5">
        <TrialStartButton disabled />
        <p data-testid="trial-blocked-note" className="flex items-start gap-2 text-sm leading-6 text-[var(--text-secondary)]">
          <ShieldCheck aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-[var(--role-admin)]" />
          <span>{trialBlockedReason}</span>
        </p>
      </div>
    );
  }

  if (state.kind === 'eligible') {
    return (
      <div className="flex flex-col gap-3 border-t border-[var(--border)] pt-5">
        <TrialStartButton />
        <p className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <ShieldCheck aria-hidden="true" size={14} className="shrink-0" />
          {NO_CARD_NOTE}
        </p>
      </div>
    );
  }

  if (state.kind === 'email-unverified') {
    return (
      <div className="flex flex-col gap-3 border-t border-[var(--border)] pt-5">
        {/* The control stays visible but inert, so the reason it cannot be used
            is attached to the thing it blocks rather than hidden. */}
        <TrialStartButton disabled />
        <p className="flex items-start gap-2 text-sm text-[var(--warning)]">
          <MailWarning aria-hidden="true" size={16} className="mt-0.5 shrink-0" />
          <span>
            ยืนยันอีเมลของคุณก่อน จึงจะเริ่มทดลอง Elite ได้{' '}
            <Link href="/profile" className="font-medium underline underline-offset-2">
              ไปที่หน้าโปรไฟล์
            </Link>
          </span>
        </p>
        <p className="text-xs text-[var(--text-muted)]">{NO_CARD_NOTE}</p>
      </div>
    );
  }

  if (state.kind === 'trialing') {
    return (
      <p className="flex items-start gap-2 border-t border-[var(--border)] pt-5 text-sm text-[var(--text-secondary)]">
        <CircleCheck aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-[var(--brand-green)]" />
        <span>สิทธิ์ Elite เปิดใช้งานอยู่ เมื่อครบกำหนดระบบจะกลับไปที่ Basic ให้อัตโนมัติ โดยไม่มีการหักเงิน</span>
      </p>
    );
  }

  if (state.kind === 'used') {
    return (
      <p className="border-t border-[var(--border)] pt-5 text-sm text-[var(--text-secondary)]">
        สิทธิ์ทดลองใช้ได้ครั้งเดียวต่อบัญชี เลือกแพ็กเกจด้านล่างเพื่อใช้เครื่องมือชุดเต็มต่อ
      </p>
    );
  }

  return (
    <p className="border-t border-[var(--border)] pt-5 text-sm text-[var(--text-secondary)]">
      ดูรายละเอียดสิ่งที่แต่ละแพ็กเกจให้ได้ที่ตารางเปรียบเทียบด้านล่าง
    </p>
  );
}
