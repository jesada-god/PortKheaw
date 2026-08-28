import type { DayChangeSource } from './day-change';

/**
 * The words that go around the day figure.
 *
 * ---------------------------------------------------------------------------
 * NO TRADING VOCABULARY
 * ---------------------------------------------------------------------------
 * Every string here is written for a reader who owns some shares and does not
 * work in a dealing room. "Pre-market", "after-hours", "session", "P&L" and
 * "previous close" are all absent on purpose — each one asks the reader to
 * already know how an exchange is scheduled in order to understand what their
 * own money did.
 *
 * What replaces them is the plain fact underneath: either the market is trading
 * right now and the number is moving, or the number came from the close of a
 * named day. A date the reader recognises ("วันศุกร์ที่ 29 ส.ค.") carries all
 * the meaning "after-hours" was carrying, and carries it to everybody.
 *
 * ---------------------------------------------------------------------------
 * "ไม่มีข้อมูล" IS NOT AN ANSWER
 * ---------------------------------------------------------------------------
 * The old card printed that phrase, or printed nothing at all, whenever the
 * figure would not compute — which told the reader that something was wrong but
 * not what, and not whether it was their fault, the market's, or ours. Nothing
 * in this module may produce it. When the figure is genuinely unavailable the
 * copy says WHICH part is missing and what will change it, because that is the
 * difference between a dead end and a wait.
 */

/*
  Locale and calendar are pinned, matching the rest of the product: a bare
  `toLocaleDateString()` follows whatever the runtime happens to be set to, so
  the same date rendered on a US-defaulted server and in a th-TH browser
  produced two different strings for one number. The zone is fixed to UTC and
  the input is always a bare exchange-local date at midnight — the date is
  already the answer, and re-interpreting it in the reader's zone would move it
  by a day for anyone east of London.
*/
const DATE_LOCALE = 'th-TH-u-ca-gregory';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseSessionDate(date: string): Date | null {
  if (!DATE_PATTERN.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

/** "วันศุกร์ที่ 29 ส.ค. 2025", or null when the date is unusable. */
export function thaiSessionDate(date: string): string | null {
  const parsed = parseSessionDate(date);
  return parsed === null
    ? null
    : parsed.toLocaleDateString(DATE_LOCALE, {
      weekday: 'long', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
    });
}

/** "วันศุกร์" alone, for the short label where the full date will not fit. */
export function thaiSessionWeekday(date: string): string | null {
  const parsed = parseSessionDate(date);
  return parsed === null
    ? null
    : parsed.toLocaleDateString(DATE_LOCALE, { weekday: 'long', timeZone: 'UTC' });
}

export interface DayChangeCopy {
  /** Short label printed beside the number. */
  label: string;
  /** One sentence saying where the number came from. Always present. */
  caption: string;
}

export interface DayChangeCopyInput {
  source: DayChangeSource;
  /** Completed trading date the figure is about; null while it is live. */
  sessionDate: string | null;
  /**
   * Exchange-local date of the reader's "now". When it equals `sessionDate` the
   * captured close IS today's, so the label stays "วันนี้" — the market having
   * shut for the evening does not make today's move belong to another day, and
   * relabelling it would look to a reader like the number had been replaced.
   */
  todayExchangeDate?: string | null;
}

/**
 * Label and caption for a day figure that exists.
 *
 * Three shapes, and the caption is never omitted for the live one: "this is
 * moving" is information too, and a caption that appears only when something is
 * stale trains the reader to read its presence as a warning.
 */
export function dayChangeCopy(input: DayChangeCopyInput): DayChangeCopy {
  if (input.source === 'live') {
    return {
      label: 'วันนี้',
      caption: 'ตลาดกำลังซื้อขายอยู่ ตัวเลขนี้ขยับตามราคาล่าสุด',
    };
  }

  const date = input.sessionDate;
  const formatted = date === null ? null : thaiSessionDate(date);
  if (date === null || formatted === null) {
    /*
      A snapshot basis with no date should not reach here — the calculators
      attach the date the row was keyed on. If one ever does, the honest reading
      is that the figure is finished but we cannot say which day finished it,
      and that is what this says. It does not guess "วันนี้".
    */
    return {
      label: 'ครั้งล่าสุด',
      caption: 'ตัวเลขนี้มาจากราคาปิดครั้งล่าสุด แต่ยังระบุวันที่ไม่ได้',
    };
  }

  if (input.todayExchangeDate && input.todayExchangeDate === date) {
    return {
      label: 'วันนี้',
      caption: `ตลาดปิดแล้ว ตัวเลขนี้คือราคาปิดของ${formatted}`,
    };
  }

  return {
    label: thaiSessionWeekday(date) ?? 'ครั้งล่าสุด',
    caption: `ตลาดยังไม่เปิด ตัวเลขนี้คือราคาปิดของ${formatted}`,
  };
}

/**
 * What to say when the figure could not be produced at all.
 *
 * Reached only when neither a live pair nor a captured close exists for at
 * least one thing the reader holds. The sentence names the cause and implies
 * the fix (wait), which is the whole distinction between this and the phrase it
 * replaces.
 */
export function dayChangeUnavailableCopy(): DayChangeCopy {
  return {
    label: 'วันนี้',
    caption: 'ยังไม่ได้ราคาปิดของบางรายการในพอร์ต จึงยังคำนวณตัวเลขวันนี้ไม่ได้ ระบบจะอัปเดตให้เมื่อได้ราคามาครบ',
  };
}
