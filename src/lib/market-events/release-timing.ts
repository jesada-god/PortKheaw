import { usSessionCloseMinute } from '@/src/lib/market-data/us-market-calendar';
import { dayKeyOf, newYorkParts } from './time';

/**
 * WHERE A RELEASE FALLS INSIDE THE US TRADING DAY — and why anything cares.
 *
 * ===========================================================================
 * THE MEASUREMENT PROBLEM THIS EXISTS TO MAKE VISIBLE
 * ===========================================================================
 * A close-to-close change on a release day means two different things
 * depending on when the release happened.
 *
 * A BLS or BEA print lands at 8:30 a.m. ET, an hour before the opening bell.
 * The whole of that session is after it, so the day's change is a window that
 * CONTAINS the release.
 *
 * An FOMC statement lands at 2:00 p.m. ET, four and a half hours into the
 * session. The same close-to-close number then contains a morning that
 * happened BEFORE the statement — a morning that could have been driven by
 * anything, including a different release.
 *
 * Both are honest numbers. They are not the same quantity, and printing them
 * under one heading would be this product doing exactly what it refuses to do
 * elsewhere: presenting two measurements as one.
 *
 * ===========================================================================
 * DERIVED FROM THE INSTANT, NEVER STORED BESIDE IT
 * ===========================================================================
 * There is no `releaseWindow` field on a calendar row and there must not be
 * one. It would be a second fact about a time that `at` already answers, free
 * to disagree with it the first time somebody edits one and not the other —
 * the same "wall clock plus a label" shape `time.ts` exists to keep out of this
 * feature, and that its contract test forbids.
 *
 * So the timing is read off the instant through the one New York converter.
 * Today that classifies exactly the FOMC rows as `intraday` and everything else
 * as `beforeOpen`, and it will keep classifying correctly if a 10:00 a.m.
 * release is ever added — which naming FOMC in a condition would not.
 *
 * `afterClose` cannot happen with any row in the shipped file. It is here
 * because the alternative is a release published at 4:30 p.m. ET being silently
 * filed as `intraday`, which is the precise failure the split is for.
 */
export type ReleaseTiming = 'beforeOpen' | 'intraday' | 'afterClose';

/** 9:30 a.m. ET, as minutes past midnight. */
const OPEN_MINUTE = 9 * 60 + 30;

/**
 * The timing of a release, or null when the instant cannot be read.
 *
 * Null rather than a default: guessing `beforeOpen` for an unreadable instant
 * would file it under the measurement that most flatters it.
 */
export function releaseTimingOf(at: string | Date): ReleaseTiming | null {
  const parts = newYorkParts(at);
  if (!parts) return null;
  const minute = parts.hour * 60 + parts.minute;
  if (minute < OPEN_MINUTE) return 'beforeOpen';
  /*
   * The close is asked for PER DAY, because it is 1:00 p.m. on a published
   * half-day. A hard-coded 16:00 would file a 1:30 p.m. release on the day
   * after Thanksgiving as intraday, when the session it would be compared
   * against had already ended.
   */
  return minute < usSessionCloseMinute(dayKeyOf(parts)) ? 'intraday' : 'afterClose';
}
