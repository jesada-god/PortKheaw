import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CurrentPlanHero } from './CurrentPlanHero';
import type { TrialState } from '@/src/lib/subscription/trial';

// The button is a client component in the real tree; here only its markup
// matters, so the router and the server action are stubbed rather than run.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock('@/app/settings/subscription/actions', () => ({
  startEliteTrialAction: async () => ({ ok: true, trialEndsAt: '', message: '' }),
}));

const TRIAL_CTA = 'ทดลอง Elite ฟรี 7 วัน';
const NO_CARD_NOTE = 'ไม่ต้องใช้บัตร และไม่มีการหักเงินอัตโนมัติ';

function render(state: TrialState, tier: 'basic' | 'pro' | 'elite' = 'basic') {
  return renderToStaticMarkup(<CurrentPlanHero state={state} effectiveTier={tier} />);
}

/** Counts real occurrences of the call to action, not incidental prose. */
function ctaCount(markup: string) {
  return markup.split(TRIAL_CTA).length - 1;
}

describe('CurrentPlanHero', () => {
  it('offers exactly one enabled trial call to action to an eligible Basic reader', () => {
    const markup = render({ kind: 'eligible' });
    expect(ctaCount(markup)).toBe(1);
    expect(markup).toContain(NO_CARD_NOTE);
    expect(markup).toContain('Basic');
    expect(markup).not.toContain('disabled=""');
  });

  it('disables the call to action and explains verification for an unverified mailbox', () => {
    const markup = render({ kind: 'email-unverified' });
    expect(ctaCount(markup)).toBe(1);
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('ยืนยันอีเมลของคุณก่อน');
    expect(markup).toContain('/profile');
    expect(markup).toContain(NO_CARD_NOTE);
  });

  it('shows the Elite Trial badge, the remaining time and the expiry while trialing', () => {
    const markup = render({
      kind: 'trialing',
      endsAt: '2026-08-10T12:00:00.000Z',
      remainingMs: 3 * 24 * 60 * 60 * 1000 + 4 * 60 * 60 * 1000,
    }, 'elite');
    expect(markup).toContain('Elite Trial');
    expect(markup).toContain('3 วัน 4 ชั่วโมง');
    expect(markup).toContain('10 ส.ค. 2569 เวลา 19:00 น.');
    // No second chance to start something already running.
    expect(ctaCount(markup)).toBe(0);
    expect(markup).toContain('ไม่มีการหักเงิน');
  });

  it('drops back to Basic without a repeat offer once the trial is used', () => {
    const markup = render({ kind: 'used' });
    expect(ctaCount(markup)).toBe(0);
    expect(markup).toContain('ฟรีตลอดชีพ');
    expect(markup).toContain('ข้อมูลทั้งหมดยังอยู่ครบ');
    expect(markup).toContain('ครั้งเดียวต่อบัญชี');
  });

  it.each(['pro', 'elite'] as const)('names an active paid %s plan and hides the trial', (tier) => {
    const markup = render({ kind: 'paid', tier }, tier);
    expect(ctaCount(markup)).toBe(0);
    expect(markup).toContain(tier === 'pro' ? 'Pro' : 'Elite');
    expect(markup).toContain('ใช้งานได้เต็มรูปแบบ');
  });

  it('renders no absolute clock reading of its own in any state', () => {
    const states: TrialState[] = [
      { kind: 'eligible' },
      { kind: 'email-unverified' },
      { kind: 'used' },
      { kind: 'paid', tier: 'elite' },
      { kind: 'trialing', endsAt: '2026-08-10T12:00:00.000Z', remainingMs: 60_000 },
    ];
    // The current year would only appear if something read the local clock
    // during render, which is the shape of every hydration mismatch here.
    const currentYear = String(new Date().getFullYear());
    for (const state of states) {
      const markup = render(state);
      expect(markup).not.toContain(currentYear);
    }
  });
});
