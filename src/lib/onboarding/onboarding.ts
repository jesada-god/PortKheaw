/**
 * Progressive onboarding: one question, then one hint, then silence forever.
 *
 * The whole feature is a function of four nullable columns on the preference row
 * the account already has. There is no tour, no step counter and no walkthrough
 * state machine — because there is no sequence: a reader is either being asked
 * where to start, being nudged once, or being left alone, and which of those it
 * is can be read from the row in one expression.
 *
 * Every path out of the question leads into a flow that already exists. Nothing
 * here creates a screen a reader could get stuck in.
 */

export const onboardingPaths = ['watchlist', 'portfolio', 'stock', 'options'] as const;
export type OnboardingPath = typeof onboardingPaths[number];

export function isOnboardingPath(value: unknown): value is OnboardingPath {
  return onboardingPaths.includes(value as OnboardingPath);
}

export interface OnboardingChoice {
  path: OnboardingPath;
  label: string;
  detail: string;
  /** An existing route. This feature adds no destination of its own. */
  href: string;
}

export const ONBOARDING_CHOICES: readonly OnboardingChoice[] = [
  { path: 'watchlist', label: 'ติดตามหุ้น', detail: 'เพิ่มหุ้นที่สนใจไว้ดูราคาและความเคลื่อนไหว', href: '/watchlist' },
  { path: 'portfolio', label: 'สร้างพอร์ต', detail: 'บันทึกหุ้นและเงินสดที่ถืออยู่เพื่อดูภาพรวม', href: '/portfolio' },
  { path: 'stock', label: 'วิเคราะห์หุ้น', detail: 'ค้นหาหุ้นแล้วดูราคา กราฟ และข้อมูลประกอบ', href: '/search' },
  { path: 'options', label: 'วิเคราะห์ Options', detail: 'ลองจำลองสถานการณ์ของสัญญาออปชัน', href: '/tools' },
];

/** The state stored on `user_settings`, read as the product sees it. */
export interface OnboardingState {
  path: string | null;
  chosenAt: string | null;
  dismissedAt: string | null;
  hintDoneAt: string | null;
}

/** One hint, tied to the path the reader chose and to a fact about their account. */
export interface OnboardingHint {
  path: OnboardingPath;
  text: string;
  actionLabel: string;
  href: string;
}

const HINTS: Readonly<Record<OnboardingPath, Omit<OnboardingHint, 'path'>>> = {
  watchlist: { text: 'ลองเพิ่มหุ้นตัวแรกเข้ารายการติดตาม', actionLabel: 'ไปที่รายการติดตาม', href: '/watchlist' },
  portfolio: { text: 'ลองเพิ่มหุ้นตัวแรกเข้าพอร์ต', actionLabel: 'ไปที่พอร์ต', href: '/portfolio' },
  stock: { text: 'ลองค้นหาหุ้นตัวแรกที่อยากดู', actionLabel: 'ไปที่ค้นหา', href: '/search' },
  options: { text: 'ลองเปิดเครื่องมือวิเคราะห์ Options ดูสักครั้ง', actionLabel: 'ไปที่เครื่องมือ', href: '/tools' },
};

export type OnboardingView =
  | { kind: 'question'; choices: readonly OnboardingChoice[] }
  | { kind: 'hint'; hint: OnboardingHint }
  | { kind: 'none' };

/**
 * What, if anything, to show.
 *
 * The order of the guards is the whole rule. Somebody who has finished being
 * helped is never asked again, whatever else changes about their account; a
 * reader who dismissed the question is not asked a second time; and a hint whose
 * job is already done — they added the holding, they built the watchlist —
 * resolves to nothing rather than nagging about something that happened.
 */
export function resolveOnboardingView({
  state,
  authenticated,
  achieved,
}: {
  state: OnboardingState | null;
  authenticated: boolean;
  /**
   * Whether the thing the hint asks for has already happened, read from state
   * the caller already holds. `undefined` means unknown, which shows the hint —
   * a hint is cheap and dismissible, and guessing "done" would silently drop it.
   */
  achieved?: boolean;
}): OnboardingView {
  if (!authenticated) return { kind: 'none' };
  if (!state) return { kind: 'question', choices: ONBOARDING_CHOICES };
  if (state.hintDoneAt) return { kind: 'none' };
  if (!state.path) {
    return state.dismissedAt ? { kind: 'none' } : { kind: 'question', choices: ONBOARDING_CHOICES };
  }
  if (!isOnboardingPath(state.path)) return { kind: 'none' };
  if (achieved === true) return { kind: 'none' };
  return { kind: 'hint', hint: { path: state.path, ...HINTS[state.path] } };
}

/** The existing route a choice leads to. Never a new screen. */
export function onboardingDestination(path: OnboardingPath): string {
  return ONBOARDING_CHOICES.find((choice) => choice.path === path)!.href;
}
