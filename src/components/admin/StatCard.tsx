import type { ReactNode } from 'react';

/**
 * One number, said plainly.
 *
 * The dashboard is a grid of these rather than a page of charts on purpose: an
 * operator opening it at 09:00 is asking "is anything wrong, and how many?", and
 * a sparkline answers neither question faster than a figure does. Charts are
 * worth their space where a *shape* carries meaning; a count of dead-lettered
 * webhooks has no shape worth drawing.
 *
 * `tone` marks the two cards that mean "go and look" — nothing else is coloured,
 * so the two that are cannot be missed.
 */
export type StatTone = 'neutral' | 'attention' | 'critical';

/**
 * Two ways to be the figure a group is *about*, and they are not the same thing.
 *
 * `lead` is size only: a larger figure on the ordinary surface, for the number a
 * band opens with. `hero` adds the accent surface on top of that, and there is
 * exactly **one** on the page — "ผู้ใช้งานทั้งหมด". Spending the accent on every
 * band's first card would have made four of them equally loud, which is the same
 * as none of them being loud; and the accent has to stay distinguishable from
 * the two tones that mean "go and look".
 */
export type StatEmphasis = 'default' | 'lead' | 'hero';

const TONE_CLASS: Readonly<Record<StatTone, string>> = {
  neutral: 'border-[var(--border)]',
  attention: 'border-[color-mix(in_srgb,var(--warning,var(--text-muted))_50%,var(--border))]',
  critical: 'border-[color-mix(in_srgb,var(--negative)_45%,var(--border))]',
};

const VALUE_CLASS: Readonly<Record<StatTone, string>> = {
  neutral: 'text-[var(--text)]',
  attention: 'text-[var(--text)]',
  critical: 'text-[var(--negative)]',
};

export function StatCard({
  label,
  value,
  hint,
  tone = 'neutral',
  emphasis = 'default',
}: {
  label: string;
  value: string;
  hint?: ReactNode;
  tone?: StatTone;
  emphasis?: StatEmphasis;
}) {
  const hero = emphasis === 'hero';
  const large = hero || emphasis === 'lead';
  return (
    /*
      A column, so the hint can be pushed to the bottom edge: grid rows stretch
      every card to the tallest in the row, and without this the cards that carry
      a hint sit their figure at a different height from the ones that do not.
    */
    <div
      className={`flex min-w-0 flex-col rounded-2xl border p-3 shadow-[var(--shadow)] sm:p-4 ${
        hero
          ? 'border-[color-mix(in_srgb,var(--accent)_35%,var(--border))] bg-[var(--accent-soft)]'
          : `${TONE_CLASS[tone]} bg-[var(--surface)]`
      }`}
    >
      {/*
        A large card's label is the full text colour rather than the muted one
        every small card uses — required on the hero, and kept on `lead` so a
        band's headline reads as one thing at both sizes. Measured on the
        deployed page for the case that forced it: against the accent
        surface in the light theme, both `--accent` and `--text-muted` come out
        at 4.34:1 — under AA for 12px — because that surface is darker than the
        `--surface` those colours were chosen against. `--text` measures 15.5:1
        on it. The emphasis is the surface and the figure; the label just has to
        be readable.

        It wraps rather than truncates, for the same reason: a label is the only
        thing on the card that says what the figure counts, and an ellipsis in
        the middle of one ("เปลี่ยนเป็นแพ็กเกจเสียเงิน…") leaves a number nobody
        can name. The grid stretches every card in a row to the tallest, so a
        second line costs alignment nothing; `break-words` is what keeps a long
        unbroken token from widening the column instead.
      */}
      <p className={`text-xs break-words ${large ? 'font-medium text-[var(--text)]' : 'text-[var(--text-muted)]'}`}>
        {label}
      </p>
      {/*
        `tabular-nums` so a column of figures does not jitter as it refreshes, and
        `break-all` so a long baht figure wraps inside a 320px card instead of
        widening the grid and giving the whole page a horizontal scrollbar.
      */}
      <p
        className={`mt-1 font-semibold tabular-nums break-all ${
          large ? 'text-3xl sm:text-4xl' : 'text-xl sm:text-2xl'
        } ${VALUE_CLASS[tone]}`}
      >
        {value}
      </p>
      {hint && (
        <p className={`mt-auto pt-1 text-xs ${hero ? 'text-[var(--text)]' : 'text-[var(--text-muted)]'}`}>
          {hint}
        </p>
      )}
    </div>
  );
}
