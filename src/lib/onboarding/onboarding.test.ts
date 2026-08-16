import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ONBOARDING_CHOICES,
  onboardingDestination,
  resolveOnboardingView,
  type OnboardingState,
} from './onboarding';

const actionsSource = readFileSync(join(process.cwd(), 'app/onboarding/actions.ts'), 'utf8');

function state(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return { path: null, chosenAt: null, dismissedAt: null, hintDoneAt: null, ...overrides };
}

describe('progressive onboarding', () => {
  it('asks a brand-new account once, and offers exactly the four starting points', () => {
    const view = resolveOnboardingView({ state: null, authenticated: true });
    expect(view.kind).toBe('question');
    expect(ONBOARDING_CHOICES.map((choice) => choice.path))
      .toEqual(['watchlist', 'portfolio', 'stock', 'options']);
  });

  it('asks nobody who is not signed in', () => {
    expect(resolveOnboardingView({ state: null, authenticated: false }).kind).toBe('none');
  });

  it('never asks again once the question has been dismissed', () => {
    expect(resolveOnboardingView({
      state: state({ dismissedAt: '2026-08-16T00:00:00.000Z' }),
      authenticated: true,
    }).kind).toBe('none');
  });

  it('follows a chosen path with one hint, and only one', () => {
    const view = resolveOnboardingView({ state: state({ path: 'portfolio' }), authenticated: true });
    expect(view.kind).toBe('hint');
    if (view.kind === 'hint') expect(view.hint.text).toBe('ลองเพิ่มหุ้นตัวแรกเข้าพอร์ต');
  });

  it('says nothing once the hint has been finished — on any device, forever', () => {
    expect(resolveOnboardingView({
      state: state({ path: 'portfolio', hintDoneAt: '2026-08-16T00:00:00.000Z' }),
      authenticated: true,
    }).kind).toBe('none');
    // Even if the goal is somehow no longer met, a finished hint stays finished.
    expect(resolveOnboardingView({
      state: state({ path: 'watchlist', hintDoneAt: '2026-08-16T00:00:00.000Z' }),
      authenticated: true,
      achieved: false,
    }).kind).toBe('none');
  });

  it('drops the hint the moment the thing it asks for has happened', () => {
    expect(resolveOnboardingView({
      state: state({ path: 'watchlist' }),
      authenticated: true,
      achieved: true,
    }).kind).toBe('none');
    // Unknown is not "done": a hint that cannot be observed is still offered.
    expect(resolveOnboardingView({
      state: state({ path: 'stock' }),
      authenticated: true,
      achieved: undefined,
    }).kind).toBe('hint');
  });

  it('sends every choice into a route that already exists', () => {
    expect(ONBOARDING_CHOICES.map((choice) => choice.href))
      .toEqual(['/watchlist', '/portfolio', '/search', '/tools']);
    expect(onboardingDestination('options')).toBe('/tools');
  });

  /*
    The deployment-ordering case. A page that cannot read the preference row —
    because the migration has not landed yet, or the query blipped — must show
    nothing, not a first-run question to an account that answered it months ago.
  */
  it('shows nothing at all when the preference row could not be read', () => {
    const page = readFileSync(join(process.cwd(), 'app/page.tsx'), 'utf8');
    expect(page).toContain("onboarding = !readable ? { kind: 'none' } : resolveOnboardingView({");
    expect(page).toContain('!onboardingResult.value.error');
  });

  it('ignores a stored path the product no longer recognises', () => {
    expect(resolveOnboardingView({
      state: state({ path: 'retired-path' }),
      authenticated: true,
    }).kind).toBe('none');
  });
});

describe('onboarding persistence', () => {
  it('writes the answer to the account, never to the browser', () => {
    expect(actionsSource).toContain("from('user_settings')");
    expect(actionsSource).toContain('onboarding_path: path');
    expect(actionsSource).toContain('onboarding_dismissed_at');
    expect(actionsSource).toContain('onboarding_hint_done_at');
    expect(actionsSource).not.toContain('localStorage');
  });

  it('refuses a path outside the four, before touching the database', () => {
    expect(actionsSource).toContain('if (!isOnboardingPath(path)) return { ok: false };');
  });

  it('records which path was chosen and nothing about the person who chose it', () => {
    expect(actionsSource).toContain("event: 'onboarding_path_chosen', featureKey: path");
    expect(actionsSource).not.toMatch(/email|user\.id.*featureKey|planKey: user/);
  });
});
