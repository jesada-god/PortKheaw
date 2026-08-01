export const DEFAULT_TRANSACTION_TIME_ZONE = 'Asia/Bangkok';
export const TRANSACTION_FUTURE_TOLERANCE_MS = 2 * 60 * 1_000;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const OFFSET_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

type DateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  formatterCache.set(timeZone, created);
  return created;
}

export function isValidTimeZone(value: string): boolean {
  try {
    formatter(value).format(new Date(0));
    return true;
  } catch {
    formatterCache.delete(value);
    return false;
  }
}

export function resolveTransactionTimeZone(value: string | null | undefined): string {
  const candidate = value?.trim();
  return candidate && isValidTimeZone(candidate)
    ? candidate
    : DEFAULT_TRANSACTION_TIME_ZONE;
}

function partsAt(instant: Date | number, timeZone: string): DateTimeParts {
  const values = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(new Date(instant))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function sameParts(left: DateTimeParts, right: DateTimeParts): boolean {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute
    && left.second === right.second;
}

function offsetAt(instantMs: number, timeZone: string): number {
  const parts = partsAt(instantMs, timeZone);
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return localAsUtc - Math.floor(instantMs / 1_000) * 1_000;
}

function localParts(value: string): DateTimeParts | null {
  const date = DATE_ONLY.exec(value);
  if (date) {
    return {
      year: Number(date[1]),
      month: Number(date[2]),
      day: Number(date[3]),
      hour: 12,
      minute: 0,
      second: 0,
    };
  }
  const dateTime = LOCAL_DATE_TIME.exec(value);
  if (!dateTime) return null;
  return {
    year: Number(dateTime[1]),
    month: Number(dateTime[2]),
    day: Number(dateTime[3]),
    hour: Number(dateTime[4]),
    minute: Number(dateTime[5]),
    second: Number(dateTime[6] ?? 0),
  };
}

/**
 * Converts one offset-less wall time in an explicit IANA time zone to one UTC
 * instant. Invalid calendar values and nonexistent DST wall times are rejected.
 */
export function transactionDateTimeToInstant(
  value: string,
  rawTimeZone: string | null | undefined,
): Date | null {
  const trimmed = value.trim();
  if (OFFSET_DATE_TIME.test(trimmed)) {
    const instant = new Date(trimmed);
    return Number.isFinite(instant.getTime()) ? instant : null;
  }
  const requested = localParts(trimmed);
  if (!requested) return null;
  const timeZone = resolveTransactionTimeZone(rawTimeZone);
  const desiredWallAsUtc = Date.UTC(
    requested.year,
    requested.month - 1,
    requested.day,
    requested.hour,
    requested.minute,
    requested.second,
  );
  if (
    new Date(desiredWallAsUtc).getUTCFullYear() !== requested.year
    || new Date(desiredWallAsUtc).getUTCMonth() + 1 !== requested.month
    || new Date(desiredWallAsUtc).getUTCDate() !== requested.day
  ) return null;

  const possibleOffsets = new Set([
    offsetAt(desiredWallAsUtc - 12 * 60 * 60 * 1_000, timeZone),
    offsetAt(desiredWallAsUtc, timeZone),
    offsetAt(desiredWallAsUtc + 12 * 60 * 60 * 1_000, timeZone),
  ]);
  const candidates = [...possibleOffsets]
    .map((offset) => desiredWallAsUtc - offset)
    .filter((candidate) => sameParts(partsAt(candidate, timeZone), requested))
    .sort((left, right) => left - right);
  return candidates.length ? new Date(candidates[0]!) : null;
}

export function transactionDateTimeToUtcIso(
  value: string,
  timeZone: string | null | undefined,
): string {
  const instant = transactionDateTimeToInstant(value, timeZone);
  if (!instant) throw new Error('Invalid transaction wall time or time zone');
  return instant.toISOString();
}

export function formatDateTimeLocal(
  instant: Date | number | string,
  rawTimeZone: string | null | undefined,
): string {
  const parsed = new Date(instant);
  if (!Number.isFinite(parsed.getTime())) return '';
  const parts = partsAt(parsed, resolveTransactionTimeZone(rawTimeZone));
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

export function currentDateTimeLocal(
  timeZone: string | null | undefined,
  nowMs = Date.now(),
): string {
  return formatDateTimeLocal(nowMs, timeZone);
}

export function maximumTransactionDateTimeLocal(
  timeZone: string | null | undefined,
  nowMs = Date.now(),
): string {
  return formatDateTimeLocal(nowMs + TRANSACTION_FUTURE_TOLERANCE_MS, timeZone);
}

export function validateTransactionDateTime(
  value: string,
  timeZone: string | null | undefined,
  nowMs = Date.now(),
): { ok: true; instant: Date } | { ok: false; message: string } {
  const instant = transactionDateTimeToInstant(value, timeZone);
  if (!instant) {
    return { ok: false, message: 'วัน เวลา หรือเขตเวลาของรายการไม่ถูกต้อง' };
  }
  if (instant.getTime() > nowMs + TRANSACTION_FUTURE_TOLERANCE_MS) {
    return { ok: false, message: 'วันและเวลารายการอยู่ในอนาคตเกิน 2 นาที' };
  }
  return { ok: true, instant };
}
