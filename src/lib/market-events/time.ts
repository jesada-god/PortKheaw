/**
 * THE ONLY PLACE A UTC INSTANT BECOMES A THAI WALL CLOCK.
 *
 * ===========================================================================
 * WHY THERE IS EXACTLY ONE OF THESE
 * ===========================================================================
 * The calendar is rendered on a Vercel server whose clock is UTC and read on a
 * handset whose clock is Bangkok. Every host-local date method — `getDate`,
 * `getMonth`, `getDay`, `getHours` — answers in the HOST's zone, so the same
 * event lands on two different days depending on which machine drew it. A FOMC
 * statement at 2:00 p.m. ET is 01:00 the NEXT DAY in Bangkok: a server using
 * `getDate()` puts it on the 16th, the reader's phone puts it on the 17th, and
 * the two disagree in production while agreeing on every developer's laptop.
 *
 * So the conversion happens once, here, through `Intl.DateTimeFormat` with an
 * explicit `Asia/Bangkok`, and `eslint-rules/no-host-local-time.mjs` makes the
 * host-local methods a build error anywhere under `src/lib/market-events` or
 * `src/components/market-events`. The rule is not advice; it is the reason this
 * module can promise what it promises.
 *
 * ===========================================================================
 * THE INSTANT IS THE VALUE. THE LABEL IS NOT.
 * ===========================================================================
 * Events carry `at` (an ISO 8601 instant ending in Z) and `etDisplay` (the
 * string "8:30 a.m. ET"). Only `at` is ever computed with. `etDisplay` exists
 * so a reader can line the row up against an American headline, and nothing
 * reads it back — a "date + time + zone name" triple re-parsed at render time
 * is the bug this whole module is arranged to prevent, because it re-derives a
 * DST offset on every machine that draws it and gets it wrong on the two
 * Sundays a year when it matters.
 *
 * `market-events.contract.test.ts` asserts that no shipped file parses it.
 */

const BANGKOK = 'Asia/Bangkok';
const NEW_YORK = 'America/New_York';
const THAI = 'th-TH';

/** A wall clock somewhere, already resolved. Never a `Date` with host methods. */
export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Monday … 6 = Sunday. The grid is Mon-first, so the index is too. */
  weekdayIndex: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
};

const partsFormatter = (timeZone: string) => new Intl.DateTimeFormat('en-US', {
  timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  weekday: 'short',
});

const BANGKOK_PARTS = partsFormatter(BANGKOK);
const NEW_YORK_PARTS = partsFormatter(NEW_YORK);

function resolve(formatter: Intl.DateTimeFormat, instant: string | Date): ZonedParts | null {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.valueOf())) return null;
  const found = formatter.formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    found.find((part) => part.type === type)?.value ?? '';
  /*
   * `hour12: false` renders midnight as "24" in some ICU versions rather than
   * "00". Both mean the same instant; only one of them is an hour number.
   */
  const hour = read('hour') === '24' ? 0 : Number(read('hour'));
  return {
    year: Number(read('year')),
    month: Number(read('month')),
    day: Number(read('day')),
    hour,
    minute: Number(read('minute')),
    weekdayIndex: WEEKDAY_INDEX[read('weekday')] ?? 0,
  };
}

/** The Bangkok wall clock for an instant, or null if the instant is unreadable. */
export function bangkokParts(instant: string | Date): ZonedParts | null {
  return resolve(BANGKOK_PARTS, instant);
}

/** The New York wall clock for an instant. Used only to LABEL a row, never to place it. */
export function newYorkParts(instant: string | Date): ZonedParts | null {
  return resolve(NEW_YORK_PARTS, instant);
}

/** `YYYY-MM-DD` in Bangkok — the key every grouping in this feature is done on. */
export function bangkokDayKey(instant: string | Date): string | null {
  const parts = bangkokParts(instant);
  return parts ? dayKeyOf(parts) : null;
}

export function dayKeyOf(parts: Pick<ZonedParts, 'year' | 'month' | 'day'>): string {
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** `HH:mm` in Bangkok. */
export function bangkokTimeLabel(instant: string | Date): string | null {
  const parts = bangkokParts(instant);
  return parts ? `${pad(parts.hour)}:${pad(parts.minute)}` : null;
}

/**
 * Which ET DAY the instant falls on, in Thai, so a reader can line a row up
 * against an American headline.
 *
 * This is the whole reason the detail feed prints an ET note. A release the
 * feed files under Thursday 10 December was reported in New York on Wednesday
 * the 9th, and a reader searching for "Fed decision December 9" needs to know
 * they are looking at the same event rather than a different one.
 */
export function newYorkDayKey(instant: string | Date): string | null {
  const parts = newYorkParts(instant);
  return parts ? dayKeyOf(parts) : null;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/*
 * Day arithmetic done on the KEY, not on a Date.
 *
 * A day key is a calendar label, so stepping it is integer arithmetic on the
 * label. Doing it by adding 86_400_000 to a timestamp would be wrong twice a
 * year in zones that observe DST; Bangkok does not, but the grid code must not
 * depend on that being true forever, and `Date.UTC` has no such seam.
 */
export function addDays(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return moved.toISOString().slice(0, 10);
}

/** Monday-first weekday index for a day key. */
export function weekdayIndexOf(dayKey: string): number {
  const [year, month, day] = dayKey.split('-').map(Number);
  /*
   * `getUTCDay` and not `getDay`: the value is built from `Date.UTC`, so the
   * UTC reading is the one that means anything. The banned host-local `getDay`
   * would answer in whatever zone the machine happens to be set to.
   */
  const sundayFirst = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return (sundayFirst + 6) % 7;
}

/** `YYYY-MM` for a day key — the month a grid is drawn for. */
export function monthKeyOf(dayKey: string): string {
  return dayKey.slice(0, 7);
}

const THAI_DAY = new Intl.DateTimeFormat(THAI, {
  timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
});
const THAI_MONTH = new Intl.DateTimeFormat(THAI, {
  timeZone: 'UTC', month: 'long', year: 'numeric',
});
const THAI_SHORT_DAY = new Intl.DateTimeFormat(THAI, {
  timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric',
});

/*
 * The pattern for every label below: a day KEY is turned back into a UTC
 * midnight and formatted in UTC.
 *
 * That looks like a round trip through the thing this module exists to avoid,
 * and it is not. The key has already been resolved to Bangkok; it is a label
 * now, with no zone left in it. Formatting it in UTC is what keeps the
 * formatter from shifting it a second time — passing `Asia/Bangkok` here would
 * move a UTC midnight forward seven hours, which is harmless for the date but
 * only by luck, and would be a real bug for any zone west of Greenwich.
 *
 * `th-TH` defaults to the Buddhist calendar, so the year comes out as 2569
 * without anybody adding 543 by hand — which is the other half of why this is
 * `Intl` and not string surgery.
 */
function utcMidnight(dayKey: string): Date {
  const [year, month, day] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/** "วันศุกร์ที่ 11 กันยายน 2569" — the detail feed's day heading. */
export function thaiDayLabel(dayKey: string): string {
  return THAI_DAY.format(utcMidnight(dayKey));
}

/** "11 ก.ย. 2569" — the compact form, for notes beside a heading. */
export function thaiShortDayLabel(dayKey: string): string {
  return THAI_SHORT_DAY.format(utcMidnight(dayKey));
}

/** "กันยายน 2569" — the calendar card's month heading. */
export function thaiMonthLabel(monthKey: string): string {
  return THAI_MONTH.format(utcMidnight(`${monthKey}-01`));
}

/*
 * Month arithmetic on the KEY, for exactly the reason `addDays` does days on it.
 *
 * A month key is a label, so stepping it is integer arithmetic on the label,
 * and `Date.UTC` normalises the overflow — month 13 becomes January of the next
 * year, month 0 becomes December of the previous one — without this file
 * owning a table of month lengths or a leap-year rule.
 *
 * The 1st is used as the day deliberately: it is the only day number every
 * month has, so stepping from a 31-day month into a 30-day one cannot slide.
 */
export function addMonths(monthKey: string, months: number): string {
  const [year, month] = monthKey.split('-').map(Number);
  const moved = new Date(Date.UTC(year, month - 1 + months, 1));
  return moved.toISOString().slice(0, 7);
}
