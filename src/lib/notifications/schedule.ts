export interface ZonedClock {
  date: string;
  time: string;
}

export function zonedClock(now: Date, timeZone: string): ZonedClock {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now).map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

export function isDailySummaryDue(input: {
  now: Date;
  timeZone: string;
  summaryTime: string;
  lastLocalDate: string | null;
}): boolean {
  const clock = zonedClock(input.now, input.timeZone);
  return input.lastLocalDate !== clock.date
    && clock.time >= input.summaryTime.slice(0, 5);
}

export function isQuietTime(input: {
  now: Date;
  timeZone: string;
  start: string;
  end: string;
}): boolean {
  const current = zonedClock(input.now, input.timeZone).time;
  const start = input.start.slice(0, 5);
  const end = input.end.slice(0, 5);
  if (start === end) return false;
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}
