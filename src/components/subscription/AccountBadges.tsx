import { ShieldCheck } from 'lucide-react';
import type { AccountBadges as AccountBadgeState, PlanBadgeKind } from '@/src/lib/subscription/account-badges';
import { ADMIN_BADGE_LABEL } from '@/src/lib/subscription/account-badges';

/**
 * Plan and role badges.
 *
 * Every tone is a theme token, so a plan is the same colour on the profile card,
 * in the subscription centre and on the preview banner, and both appearances are
 * covered by one definition. Nothing here hard-codes a hex value.
 *
 * Colour is never the only signal: each badge carries its plan name as text, and
 * a simulated plan says `TEST` and is drawn as a dashed outline rather than a
 * filled chip. A reader who cannot separate gold from green still reads
 * "ELITE TRIAL TEST".
 */

const PLAN_TONE: Readonly<Record<PlanBadgeKind, string>> = {
  basic: 'text-[var(--plan-basic)] border-[var(--plan-basic)]',
  pro: 'text-[var(--plan-pro)] border-[var(--plan-pro)]',
  elite: 'text-[var(--plan-elite)] border-[var(--plan-elite)]',
  // Operator access opens exactly the Elite surface, so it is painted in the
  // Elite gold; the word ACCESS is what says it was granted, not bought.
  elite_access: 'text-[var(--plan-elite)] border-[var(--plan-elite)]',
  elite_trial: 'text-[var(--plan-elite-trial)] border-[var(--plan-elite-trial)]',
  // An expired trial grants exactly Basic, so it is painted as Basic; the word
  // on the badge is what says which scenario is being simulated.
  expired_trial: 'text-[var(--plan-basic)] border-[var(--plan-basic)]',
};

const PLAN_FILL: Readonly<Record<PlanBadgeKind, string>> = {
  basic: 'bg-[color-mix(in_srgb,var(--plan-basic)_14%,transparent)]',
  pro: 'bg-[color-mix(in_srgb,var(--plan-pro)_14%,transparent)]',
  elite: 'bg-[color-mix(in_srgb,var(--plan-elite)_14%,transparent)]',
  elite_access: 'bg-[color-mix(in_srgb,var(--plan-elite)_14%,transparent)]',
  elite_trial: 'bg-[color-mix(in_srgb,var(--plan-elite-trial)_14%,transparent)]',
  expired_trial: 'bg-[color-mix(in_srgb,var(--plan-basic)_14%,transparent)]',
};

const BADGE_BASE = 'inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold tracking-wide whitespace-nowrap';

export function PlanBadge({ kind, label, preview }: {
  kind: PlanBadgeKind;
  label: string;
  preview: boolean;
}) {
  return (
    <span
      data-testid="plan-badge"
      data-plan={kind}
      data-preview={preview ? 'true' : 'false'}
      className={`${BADGE_BASE} ${PLAN_TONE[kind]} ${preview ? 'border-dashed' : PLAN_FILL[kind]}`}
    >
      {label}
    </span>
  );
}

/**
 * The operator badge. It answers "who is this account", never "what did they
 * buy", so it is a crimson that no plan uses and it sits first in the row.
 *
 * The three tones are separate tokens rather than one colour mixed three ways,
 * because the fill has to be a lighter wash in the light appearance than in the
 * dark one to stay a tint rather than a smear. Red here means authority, not
 * danger: the hue is held measurably off --negative in both appearances, and the
 * shield and the word ADMIN carry the meaning even where colour cannot.
 */
export function RoleBadge() {
  return (
    <span
      data-testid="role-badge"
      className={`${BADGE_BASE} border-[var(--role-admin-border)] bg-[var(--role-admin-bg)] text-[var(--role-admin-text)]`}
    >
      <ShieldCheck aria-hidden="true" size={12} className="shrink-0" />
      {ADMIN_BADGE_LABEL}
    </span>
  );
}

/**
 * The name, then its badges.
 *
 * One wrapping flex row does the whole responsive story: on a desktop width the
 * name and both badges sit on one line; when they no longer fit, the badges wrap
 * underneath instead of squeezing the name. The name itself truncates rather
 * than pushing the row wide, which is what keeps a long display name from
 * introducing a horizontal scrollbar at 320px.
 */
export function AccountIdentity({ name, badges, nameClassName }: {
  name: string;
  badges: AccountBadgeState;
  nameClassName?: string;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
      <h2 className={`min-w-0 max-w-full truncate ${nameClassName ?? 'text-xl font-bold text-[var(--text)] sm:text-2xl'}`}>
        {name}
      </h2>
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        {badges.showAdminBadge && <RoleBadge />}
        <PlanBadge kind={badges.plan} label={badges.planLabel} preview={badges.isPreview} />
      </span>
    </div>
  );
}
