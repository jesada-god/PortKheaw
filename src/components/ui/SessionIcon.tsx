import type { SessionIconName, SessionTone } from '@/src/lib/market-data/current-session';

/**
 * Market-session icons, drawn from Google's Material Symbols set.
 *
 * The glyph outlines below are the Material Symbols paths (Rounded, weight 400,
 * 24px grid) inlined as SVG rather than loaded from a web font. That is not a
 * stylistic preference: this app's Content-Security-Policy is `font-src 'self'
 * data:` and `style-src 'self' 'unsafe-inline'`, so a `fonts.googleapis.com`
 * stylesheet and its font file are both blocked — the icons would silently render
 * as the literal text "wb_twilight". Inlining keeps the official artwork, costs zero
 * network requests, and cannot regress when the CSP is tightened further.
 *
 * Color comes from the session tone tokens in `globals.css`, never from a hardcoded
 * hex here, so light and dark are handled by the theme and no value is duplicated
 * across call sites. Every icon is decorative in the DOM (`aria-hidden`) and its
 * meaning is carried by the adjacent Thai status text plus this element's `title` —
 * so a screen reader hears the meaning once, not twice.
 */

/** Material Symbols outlines, 0 0 24 24 viewBox. */
const GLYPHS: Record<SessionIconName, string> = {
  // wb_twilight — sun low over a horizon line: the pre-market window.
  wb_twilight: 'M4 20h16a1 1 0 0 0 0-2H4a1 1 0 0 0 0 2Zm8-14a5 5 0 0 1 4.9 4h-9.8A5 5 0 0 1 12 6Zm-6.9 4H3a1 1 0 0 0 0 2h2.1a1 1 0 0 0 0-2Zm15.9 0h-2.1a1 1 0 0 0 0 2H21a1 1 0 0 0 0-2ZM12 2a1 1 0 0 0-1 1v1.06a1 1 0 0 0 2 0V3a1 1 0 0 0-1-1ZM5.64 4.22a1 1 0 0 0-1.42 1.42l.75.74a1 1 0 0 0 1.41-1.41l-.74-.75Zm12.72 0-.74.75a1 1 0 0 0 1.41 1.41l.75-.74a1 1 0 0 0-1.42-1.42ZM4 15h16a1 1 0 0 0 0-2H4a1 1 0 0 0 0 2Z',
  // sunny — the regular session.
  sunny: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 8a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm0-11a1 1 0 0 0 1-1V2a1 1 0 0 0-2 0v1a1 1 0 0 0 1 1Zm0 16a1 1 0 0 0-1 1v1a1 1 0 0 0 2 0v-1a1 1 0 0 0-1-1ZM4 12a1 1 0 0 0-1-1H2a1 1 0 0 0 0 2h1a1 1 0 0 0 1-1Zm18-1h-1a1 1 0 0 0 0 2h1a1 1 0 0 0 0-2ZM5.99 4.58a1 1 0 0 0-1.41 1.41l.71.71a1 1 0 0 0 1.41-1.42l-.71-.7Zm12.02 12.02a1 1 0 0 0-1.41 1.41l.7.71a1 1 0 0 0 1.42-1.41l-.71-.71ZM19.42 4.58l-.71.7a1 1 0 0 0 1.41 1.42l.71-.71a1 1 0 0 0-1.41-1.41ZM5.29 17.3l-.71.7a1 1 0 0 0 1.41 1.42l.71-.71a1 1 0 0 0-1.41-1.41Z',
  // bedtime — crescent moon: after-hours, and an ordinary/weekend close.
  bedtime: 'M12.34 2.02A10 10 0 1 0 22 14.66a1 1 0 0 0-1.35-1.2A7.5 7.5 0 0 1 13.5 3.3a1 1 0 0 0-1.16-1.28Zm-1.11 2.4a9.5 9.5 0 0 0 8.85 10.72A8 8 0 1 1 11.23 4.42Z',
  // event — calendar with a marked day: a holiday or an exchange event closure.
  event: 'M19 3h-1V2a1 1 0 0 0-2 0v1H8V2a1 1 0 0 0-2 0v1H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Zm0 16H5V9h14v10Zm0-12H5V5h14v2Zm-2 5h-5v5h5v-5Z',
};

/**
 * Theme-token class per tone. Both appearances resolve through the same variable,
 * so a single token change moves light and dark together.
 *
 * Deliberately disjoint from the gain/loss palette: `--positive`/`--negative` mean
 * "the price went up / down", and reusing green for "market open" or red for
 * "closed" makes the session icon read as a price signal. The `event` tone is a warm
 * amber-red rather than the error red — a scheduled holiday is not a fault.
 */
const TONE_CLASS: Record<SessionTone, string> = {
  pre: 'text-session-pre',
  regular: 'text-session-regular',
  post: 'text-session-post',
  closed: 'text-session-closed',
  event: 'text-session-event',
};

export interface SessionIconProps {
  name: SessionIconName;
  tone: SessionTone;
  /** Thai description of what this icon means; its accessible name and tooltip. */
  title: string;
  size?: number;
  className?: string;
}

export function SessionIcon({ name, tone, title, size = 16, className = '' }: SessionIconProps) {
  return (
    <svg
      // Announced as an image named by the Thai description, so the meaning of the
      // glyph is available to a screen reader and not only to a sighted reader.
      role="img"
      aria-label={title}
      data-testid="session-icon"
      data-session-icon={name}
      data-session-tone={tone}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      className={`shrink-0 ${TONE_CLASS[tone]} ${className}`}
    >
      <title>{title}</title>
      <path d={GLYPHS[name]} />
    </svg>
  );
}
