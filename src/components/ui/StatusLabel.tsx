import { cn } from '@/src/utils/cn';
import { STATUS_PRESENTATION, type StatusIconName, type StatusLevel } from '@/src/lib/presentation/status';

/**
 * The five levels' direction glyphs, drawn from Google's Material Symbols set.
 *
 * The outlines are the Material Symbols paths (Rounded, weight 400, 24px design
 * grid, shipped by `@material-symbols/svg-400` on its 960-unit box) inlined as
 * SVG rather than loaded from a web font — the same call `SessionIcon` makes and
 * for the same reason: this app's Content-Security-Policy is `font-src 'self'
 * data:` and `style-src 'self' 'unsafe-inline'`, so a `fonts.googleapis.com`
 * stylesheet and its font file are both blocked and the icons would silently
 * render as the literal text "trending_up". Inlining keeps the official artwork,
 * costs zero network requests, and cannot regress when the CSP is tightened.
 *
 * The viewBox is Material's own `0 -960 960 960` rather than a hand-rescaled
 * `0 0 24 24`, so the geometry is byte-for-byte what the set publishes and no
 * transcription error can creep into a curve.
 */
const GLYPHS: Record<StatusIconName, string> = {
  trending_up: 'M102-252q-9-9-9-21.5t9-21.5l228-227q16.93-17 41.97-17Q397-539 414-522l125 125 241-241h-97q-12.75 0-21.37-8.68-8.63-8.67-8.63-21.5 0-12.82 8.63-21.32 8.62-8.5 21.37-8.5h167q12.75 0 21.38 8.62Q880-680.75 880-668v167q0 12-8.27 21t-20.5 9Q839-471 830-480t-9-21v-93L580-354q-16.93 17-41.97 17Q513-337 496-354L371-478 145-252q-9 9-21.5 9t-21.5-9Z',
  trending_flat: 'M765-449H150q-13 0-21.5-8.5T120-479q0-13 8.5-21.5T150-509h616l-85-85q-9-9-9-21t9-21q9-9 21-9t21 9l136 136q9 9 9 21t-9 21L723-322q-9 9-21 9t-21-9q-9-9-9-21.5t9-21.5l84-84Z',
  trending_down: 'M780-300 539-541 414-416q-16.93 17-41.97 17Q347-399 330-416L102-644q-9-9-9-21.5t9-21.5q9-9 21.5-9t21.5 9l226 227 125-125q16.93-17 41.97-17Q563-602 580-585l241 241v-94q0-12.33 9-20.66 9-8.34 21.23-8.34t20.5 8.34Q880-450.33 880-438v168q0 12.75-8.62 21.37Q862.75-240 850-240H683q-12.75 0-21.37-8.68-8.63-8.67-8.63-21.5 0-12.82 8.63-21.32 8.62-8.5 21.37-8.5h97Z',
  horizontal_rule: 'M190-450q-12.75 0-21.37-8.68-8.63-8.67-8.63-21.5 0-12.82 8.63-21.32 8.62-8.5 21.37-8.5h580q12.75 0 21.38 8.68 8.62 8.67 8.62 21.5 0 12.82-8.62 21.32-8.63 8.5-21.38 8.5H190Z',
};

/** Which mark a render site wants: the direction, or the direction-free circle. */
export type StatusMarkKind = 'direction' | 'dot';

/**
 * One status level, as a mark and nothing else.
 *
 * ALWAYS `aria-hidden`, in both kinds. The mark never says anything the text
 * beside it does not already say — an arrow next to "ขาลงชัดเจน" and a percentage
 * that already carries a minus sign is the third time a screen reader would hear
 * the same fact — so it carries no `<title>`, no `role="img"` and no label. That
 * is the deliberate difference from `SessionIcon`, whose glyph IS the only place
 * its meaning appears and which therefore announces itself.
 *
 * It is sized in `em` and inherits `currentColor`, so it tracks whatever text it
 * is dropped beside: at `text-xs` it is a small arrow, at `text-lg` a larger one,
 * and it never grows into competition with the figure it annotates. The nudge
 * down is because a flex baseline puts an SVG's bottom edge ON the baseline,
 * which leaves the glyph's optical centre sitting above the text's.
 */
export function StatusMark({
  level,
  kind = 'direction',
  className,
}: {
  level: StatusLevel;
  kind?: StatusMarkKind;
  className?: string;
}) {
  const presentation = STATUS_PRESENTATION[level];
  if (kind === 'dot') {
    return (
      <span
        aria-hidden="true"
        data-status-mark="dot"
        className={cn('shrink-0 text-[0.8em] leading-none', className)}
      >
        {presentation.dot}
      </span>
    );
  }
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      data-status-mark={presentation.icon}
      viewBox="0 -960 960 960"
      width="1em"
      height="1em"
      fill="currentColor"
      className={cn('shrink-0 translate-y-[0.15em]', className)}
    >
      <path d={GLYPHS[presentation.icon]} />
    </svg>
  );
}

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
 * The mark is `aria-hidden`. A screen reader gets the Thai phrase and nothing
 * else — announcing "trending up" before every row would make the mark that
 * helps a sighted reader skim actively worse for everyone else.
 *
 * Colour is the ONLY thing the level changes. It never changes weight, size or
 * order, so a screen of statuses stays scannable and a falling arrow does not
 * shout over the sentence next to it.
 */
export function StatusLabel({
  level,
  label,
  mark = 'direction',
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
  /**
   * `dot` for a status that has no direction — a connection state, a
   * data-freshness note, an event's importance, the shape of a stated plan. An
   * arrow on any of those would point somewhere the status never claimed to
   * point, so those four callers say so here rather than inventing a mark of
   * their own.
   */
  mark?: StatusMarkKind;
} & Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'>) {
  const presentation = STATUS_PRESENTATION[level];
  return (
    <span
      data-status={level}
      className={cn('inline-flex min-w-0 items-baseline gap-1.5', className)}
      style={{ color: `var(${presentation.token})` }}
      {...props}
    >
      <StatusMark level={level} kind={mark} />
      <span className="min-w-0 break-words font-semibold">
        {label ?? presentation.fallbackLabel}
      </span>
    </span>
  );
}

/**
 * The same status with a name in front of it — "แนวโน้ม · ↗ ขาขึ้นแรง".
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
  mark,
  className,
}: {
  name: string;
  level: StatusLevel;
  label?: string;
  /** An optional plain-text tail, e.g. a price. Never coloured. */
  note?: string;
  /** Passed straight through to {@link StatusLabel}; see the note there. */
  mark?: StatusMarkKind;
  className?: string;
}) {
  return (
    <div className={cn('flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-sm leading-6', className)}>
      <span className="shrink-0 text-[var(--text-secondary)]">{name}</span>
      <span aria-hidden="true" className="shrink-0 text-[var(--text-muted)]">·</span>
      <StatusLabel level={level} label={label} mark={mark} />
      {note && <span className="min-w-0 break-words text-[var(--text-muted)]">{note}</span>}
    </div>
  );
}
