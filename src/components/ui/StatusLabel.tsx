import { cn } from '@/src/utils/cn';
import { STATUS_PRESENTATION, type StatusLevel } from '@/src/lib/presentation/status';

/**
 * A status, said in one mark and one phrase.
 *
 * DELIBERATELY NOT A BADGE. It has no border, no fill and no radius, because
 * the product already had four different pill treatments for this and a page
 * carrying six of them reads as a dashboard rather than as a page — "ห้าม badge
 * รัว" is the rule it is built to satisfy. What separates a status from the text
 * around it is the mark and the colour, which is the least furniture that can
 * still do the job.
 *
 * The emoji is `aria-hidden`. A screen reader gets the Thai phrase and nothing
 * else — announcing "large green circle" before every row would make the mark
 * that helps a sighted reader skim actively worse for everyone else.
 *
 * Colour is the ONLY thing the level changes. It never changes weight, size or
 * order, so a screen of statuses stays scannable and a 🔴 does not shout over
 * the sentence next to it.
 */
export function StatusLabel({
  level,
  label,
  className,
  ...props
}: {
  level: StatusLevel;
  /**
   * The words. Each surface passes its OWN phrase — "ขาขึ้นชัดเจน",
   * "ใกล้แนวต้าน" — because the level is five buckets and the sentence is what
   * the reader actually came for. Falls back to the level's generic word only
   * when a caller genuinely has nothing more specific to say.
   */
  label?: string;
} & Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'>) {
  const presentation = STATUS_PRESENTATION[level];
  return (
    <span
      data-status={level}
      className={cn('inline-flex min-w-0 items-baseline gap-1.5', className)}
      style={{ color: `var(${presentation.token})` }}
      {...props}
    >
      <span aria-hidden="true" className="shrink-0 text-[0.8em] leading-none">
        {presentation.emoji}
      </span>
      <span className="min-w-0 break-words font-semibold">
        {label ?? presentation.fallbackLabel}
      </span>
    </span>
  );
}

/**
 * The same status with a name in front of it — "แนวโน้ม · 🟢 ขาขึ้นแรง".
 *
 * This is the row shape §2 of the Phase 1 brief describes, and the reason it is
 * a component rather than a snippet repeated at five call sites is the middle
 * dot: the separator, the muted name and the coloured status have to line up
 * identically on the stock page, the planner and the overview, or the three
 * stop reading as one product.
 */
export function StatusRow({
  name,
  level,
  label,
  note,
  className,
}: {
  name: string;
  level: StatusLevel;
  label?: string;
  /** An optional plain-text tail, e.g. a price. Never coloured. */
  note?: string;
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-sm leading-6', className)}>
      <span className="shrink-0 text-[var(--text-secondary)]">{name}</span>
      <span aria-hidden="true" className="shrink-0 text-[var(--text-muted)]">·</span>
      <StatusLabel level={level} label={label} />
      {note && <span className="min-w-0 break-words text-[var(--text-muted)]">{note}</span>}
    </div>
  );
}
