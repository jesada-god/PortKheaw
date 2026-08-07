const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function calendarDateParts(value: string): [number, number, number] | null {
  const match = CALENDAR_DATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, date);
  const parsed = new Date(timestamp);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== date) return null;
  return [year, month, date];
}

export function addCalendarDays(value: string, amount: number): string {
  const parts = calendarDateParts(value);
  if (!parts) return value;
  const next = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + amount));
  return [next.getUTCFullYear(), String(next.getUTCMonth() + 1).padStart(2, '0'), String(next.getUTCDate()).padStart(2, '0')].join('-');
}

export function calendarDaysBetween(start: string, end: string): number {
  const startParts = calendarDateParts(start);
  const endParts = calendarDateParts(end);
  if (!startParts || !endParts) return 0;
  const startValue = Date.UTC(startParts[0], startParts[1] - 1, startParts[2]);
  const endValue = Date.UTC(endParts[0], endParts[1] - 1, endParts[2]);
  return Math.round((endValue - startValue) / 86_400_000);
}

/**
 * Today on the reader's own wall clock, read component-by-component.
 *
 * `toISOString().slice(0, 10)` is the tempting one-liner and it is wrong east of
 * UTC: at 07:00 in Bangkok it still answers yesterday, which is exactly the
 * off-by-one that lets a phone offer a Target Date the server then rejects.
 */
export function todayCalendarDate(now: Date = new Date()): string {
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
}

export interface TargetDateBounds {
  /** The first day a Target Date may sit on, as `YYYY-MM-DD`. */
  minimum: string;
  /** The last day a Target Date may sit on — the expiration day itself. */
  maximum: string;
}

/*
  The single Target Date rule, stated once.

  Two facts decide the window. The model needs at least one day of time between
  the valuation date and the day being valued, and a contract cannot be valued
  after it has expired — but it *can* be valued on the expiration day, where the
  pricing engine already returns intrinsic value at T=0. So the window is
  inclusive at the top: expiration passes, the day after it does not.

  `today` is a floor rather than the minimum, because a simulation saved weeks
  ago still carries its old valuation date and must not offer a Target Date in
  the past. Pass an empty string to opt out — a prerendered first paint has no
  calendar day yet, and reading a clock during render would bake the build date
  into the markup.
*/
export function targetDateBounds(valuationDate: string, expiration: string, today = ''): TargetDateBounds {
  const afterValuation = addCalendarDays(valuationDate, 1);
  const floor = calendarDateParts(today) && today > afterValuation ? today : afterValuation;
  return { minimum: floor, maximum: expiration };
}

export type TargetDateViolation = 'malformed' | 'before-minimum' | 'after-expiration';

/** Why a Target Date is not usable, or `null` when it is. */
export function targetDateViolation(
  value: string,
  valuationDate: string,
  expiration: string,
  today = '',
): TargetDateViolation | null {
  if (!calendarDateParts(value)) return 'malformed';
  if (!calendarDateParts(expiration)) return null;
  const { minimum, maximum } = targetDateBounds(valuationDate, expiration, today);
  if (value > maximum) return 'after-expiration';
  if (calendarDateParts(minimum) && value < minimum) return 'before-minimum';
  return null;
}

/**
 * The onChange path: refuse an out-of-range pick and keep the last good value.
 *
 * iOS honours `min`/`max` on the wheel but still fires a change for a value
 * outside them in several reachable states — a typed entry, an autofill, a
 * locale where the wheel rolls past the cap. Silently clamping there would move
 * the date under the reader's finger; refusing leaves what they already had.
 */
export function acceptTargetDate(
  next: string,
  current: string,
  valuationDate: string,
  expiration: string,
  today = '',
): string {
  return targetDateViolation(next, valuationDate, expiration, today) === null ? next : current;
}

/**
 * The restore path: pull a stored or imported value back to the nearest edge.
 *
 * A saved simulation whose expiration has since moved, or a draft restored from
 * localStorage, arrives with no reader to refuse on behalf of — so it is clamped
 * into the window instead, and only stays in error when the window is empty.
 */
export function clampTargetDate(value: string, valuationDate: string, expiration: string, today = ''): string {
  const { minimum, maximum } = targetDateBounds(valuationDate, expiration, today);
  if (!calendarDateParts(maximum)) return calendarDateParts(value) ? value : minimum;
  if (!calendarDateParts(value)) return minimum <= maximum ? minimum : maximum;
  if (value > maximum) return maximum;
  if (calendarDateParts(minimum) && value < minimum) return minimum <= maximum ? minimum : maximum;
  return value;
}
