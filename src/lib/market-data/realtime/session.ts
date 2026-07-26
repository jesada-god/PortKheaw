export const US_EQUITY_SESSIONS = ['pre-market', 'regular', 'after-hours', 'closed'] as const;
export type UsEquitySession = (typeof US_EQUITY_SESSIONS)[number];

const NEW_YORK_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/**
 * Classify a provider timestamp into the US-equities extended-hours sessions.
 * The provider/exchange timestamp is always the input; the browser clock is never
 * used as market time. Intl owns the America/New_York DST transition rules.
 * Exchange holidays remain closed because no trade is accepted on a day without
 * provider events; the Polygon market-status resource remains the UI calendar
 * authority when the wire is quiet.
 */
export function classifyUsEquityTimestamp(timestampMs: number): UsEquitySession {
  if (!Number.isFinite(timestampMs) || timestampMs < 0) return 'closed';
  const parts = Object.fromEntries(
    NEW_YORK_PARTS.formatToParts(new Date(timestampMs)).map((part) => [part.type, part.value]),
  );
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return 'closed';
  const seconds = Number(parts.hour) * 3_600 + Number(parts.minute) * 60 + Number(parts.second);
  if (seconds >= 4 * 3_600 && seconds < 9 * 3_600 + 30 * 60) return 'pre-market';
  if (seconds >= 9 * 3_600 + 30 * 60 && seconds < 16 * 3_600) return 'regular';
  if (seconds >= 16 * 3_600 && seconds < 20 * 3_600) return 'after-hours';
  return 'closed';
}
