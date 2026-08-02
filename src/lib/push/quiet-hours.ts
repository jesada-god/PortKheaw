function minuteInTimezone(now: Date, timezone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
  } catch { return null; }
}

function timeToMinute(value: string): number {
  const [hour = '0', minute = '0'] = value.split(':');
  return Number(hour) * 60 + Number(minute);
}

export function isQuietHour(now: Date, timezone: string, start: string, end: string): boolean {
  const current = minuteInTimezone(now, timezone);
  if (current == null) return false;
  const from = timeToMinute(start); const until = timeToMinute(end);
  if (from === until) return true;
  return from < until ? current >= from && current < until : current >= from || current < until;
}

export function nextQuietHoursEnd(
  now: Date,
  timezone: string,
  start: string,
  end: string,
): Date {
  if (!isQuietHour(now, timezone, start, end)) return now;
  // Search by absolute minutes so daylight-saving transitions remain correct
  // for every timezone offered in Settings. The longest civil day is bounded
  // well below this 26-hour window.
  for (let minutes = 1; minutes <= 26 * 60; minutes += 1) {
    const candidate = new Date(now.getTime() + minutes * 60_000);
    if (!isQuietHour(candidate, timezone, start, end)) return candidate;
  }
  return new Date(now.getTime() + 26 * 60 * 60_000);
}
