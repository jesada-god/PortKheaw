export const US_EQUITY_TIMEZONE = 'America/New_York';

export type EquitySessionType = 'premarket' | 'regular' | 'afterhours';

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', weekday: 'short',
  });
  formatters.set(timeZone, created);
  return created;
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const values = Object.fromEntries(
    formatter(timeZone).formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second),
    weekday: values.weekday,
  };
}

function localParts(value: string): Omit<ZonedParts, 'weekday'> | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const parts = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6] ?? 0),
  };
  const check = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
  if (
    check.getUTCFullYear() !== parts.year || check.getUTCMonth() !== parts.month - 1
    || check.getUTCDate() !== parts.day || check.getUTCHours() !== parts.hour
    || check.getUTCMinutes() !== parts.minute || check.getUTCSeconds() !== parts.second
  ) return null;
  return parts;
}

function offsetAt(timestamp: number, timeZone: string): number {
  const parts = zonedParts(new Date(timestamp), timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(timestamp / 1_000) * 1_000;
}

/** Convert a provider's exchange-local wall clock to a unique UTC instant. */
export function zonedLocalToUtc(value: string, timeZone: string): string | null {
  const parts = localParts(value);
  if (!parts) return null;
  const localEpoch = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let instant = localEpoch;
  for (let index = 0; index < 3; index += 1) {
    instant = localEpoch - offsetAt(instant, timeZone);
  }
  const verified = zonedParts(new Date(instant), timeZone);
  if (
    verified.year !== parts.year || verified.month !== parts.month || verified.day !== parts.day
    || verified.hour !== parts.hour || verified.minute !== parts.minute || verified.second !== parts.second
  ) return null;
  return new Date(instant).toISOString();
}

export function exchangeSessionDate(timestamp: string, timeZone: string): string | null {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.valueOf())) return null;
  const parts = zonedParts(parsed, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

/** Regular US-equity session in exchange-local minutes past midnight: [09:30, 16:00). */
export const REGULAR_SESSION_OPEN_MINUTE = 9 * 60 + 30;
export const REGULAR_SESSION_CLOSE_MINUTE = 16 * 60;

/**
 * Whether an OHLCV bucket that STARTS at `startMinuteOfDay` (exchange-local
 * minutes past midnight) and spans `durationMinutes` overlaps the regular
 * session [09:30, 16:00).
 *
 * This governs regular-session filtering of provider-native aggregates. A bucket
 * must be judged by its full [start, start+duration) span, not its start alone:
 * a provider-native multi-hour bucket (e.g. Polygon's 08:00–12:00 4h bar, or a
 * 09:00–10:00 1h bar) begins before 09:30 yet clearly overlaps the open, so it
 * must be kept — its provider OHLCV is preserved unchanged and never split,
 * interpolated or resampled. Consequently a kept multi-hour bucket may include
 * some data outside the exact regular boundary whenever the provider returns it
 * that way. Buckets lying entirely in pre-market or after-hours are excluded, as
 * is a bucket that only touches a boundary (ends exactly at 09:30, or starts
 * exactly at 16:00), since a half-open interval does not overlap at a shared
 * endpoint.
 */
export function bucketOverlapsRegularSession(startMinuteOfDay: number, durationMinutes: number): boolean {
  const endMinuteOfDay = startMinuteOfDay + durationMinutes;
  return startMinuteOfDay < REGULAR_SESSION_CLOSE_MINUTE
    && endMinuteOfDay > REGULAR_SESSION_OPEN_MINUTE;
}

export function classifyUsEquitySession(timestamp: string, timeZone = US_EQUITY_TIMEZONE): EquitySessionType | null {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.valueOf())) return null;
  const parts = zonedParts(parsed, timeZone);
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return null;
  const minute = parts.hour * 60 + parts.minute;
  if (minute >= 9 * 60 + 30 && minute < 16 * 60) return 'regular';
  if (minute >= 4 * 60 && minute < 9 * 60 + 30) return 'premarket';
  if (minute >= 16 * 60 && minute < 20 * 60) return 'afterhours';
  return null;
}

/**
 * Whether an instant is the moment a regular session ENDED, rather than a print
 * from the after-hours window that follows it.
 *
 * The two are impossible to separate by {@link classifyUsEquitySession} alone,
 * because the regular window is half-open at 16:00 and the closing print is not:
 * Yahoo stamps NVTS's official close at 16:00:01 ET, and Polygon's end-of-day row
 * at exactly 16:00:00. Both classify as `afterhours`, so a resolver that required
 * `regular` to recognise a close rejected every real one — and then fell back to
 * something that was not the close at all.
 *
 * The rule is the CLOSING MINUTE, not a tolerance window: `16:00:00`–`16:00:59` on
 * a normal day, `13:00:00`–`13:00:59` on a published half-day. A trade at 16:01 is
 * an after-hours trade and stays one.
 */
export function isRegularSessionCloseInstant(
  timestamp: string,
  closeMinuteOfDay = REGULAR_SESSION_CLOSE_MINUTE,
  timeZone = US_EQUITY_TIMEZONE,
): boolean {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.valueOf())) return false;
  const parts = zonedParts(parsed, timeZone);
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  return parts.hour * 60 + parts.minute === closeMinuteOfDay;
}

function dateOnly(parts: Pick<ZonedParts, 'year' | 'month' | 'day'>): string {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function previousWeekday(date: Date, timeZone: string): string {
  let cursor = date.getTime();
  for (let attempts = 0; attempts < 8; attempts += 1) {
    cursor -= 24 * 60 * 60_000;
    const parts = zonedParts(new Date(cursor), timeZone);
    if (parts.weekday !== 'Sat' && parts.weekday !== 'Sun') return dateOnly(parts);
  }
  throw new Error('Could not resolve previous weekday session');
}

/** Holidays are intentionally not guessed; callers may supply a verified holiday set. */
export function previousCompletedUsSession(
  now: Date,
  holidays: ReadonlySet<string> = new Set(),
  timeZone = US_EQUITY_TIMEZONE,
): string {
  const parts = zonedParts(now, timeZone);
  const today = dateOnly(parts);
  const weekday = parts.weekday !== 'Sat' && parts.weekday !== 'Sun';
  const afterClose = parts.hour * 60 + parts.minute >= 16 * 60;
  if (weekday && afterClose && !holidays.has(today)) return today;
  let candidate = previousWeekday(now, timeZone);
  while (holidays.has(candidate)) {
    const noon = zonedLocalToUtc(`${candidate} 12:00:00`, timeZone);
    if (!noon) throw new Error('Could not resolve holiday session');
    candidate = previousWeekday(new Date(noon), timeZone);
  }
  return candidate;
}
