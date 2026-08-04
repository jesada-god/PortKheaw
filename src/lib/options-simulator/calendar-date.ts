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
