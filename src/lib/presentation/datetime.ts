export const THAI_LOCALE = 'th-TH';
export const BANGKOK_TIME_ZONE = 'Asia/Bangkok';

export function isDateOnlyValue(value: string | null | undefined): boolean {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

export function formatBangkokDateTime(
  value: string | Date | null | undefined,
  options: { withSeconds?: boolean } = {},
): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) return '—';
  return new Intl.DateTimeFormat(THAI_LOCALE, {
    dateStyle: 'medium',
    // `medium` carries seconds (HH:mm:ss) so a live intraday timestamp visibly
    // advances with each accepted tick; `short` (HH:mm) stays the default.
    timeStyle: options.withSeconds ? 'medium' : 'short',
    timeZone: BANGKOK_TIME_ZONE,
  }).format(date);
}

/**
 * The same Bangkok wall clock, but always with a Gregorian (CE) year.
 *
 * `th-TH` defaults to the Buddhist calendar, so a page that mixes this helper
 * with a raw ISO date shows 2569 beside 2026 and asks the reader to work out
 * that they are the same day. Surfaces that print machine timestamps next to
 * formatted ones use this so every year on the page is the same era.
 */
export function formatBangkokDateTimeCE(
  value: string | Date | null | undefined,
  options: { withSeconds?: boolean } = {},
): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) return '—';
  return new Intl.DateTimeFormat(`${THAI_LOCALE}-u-ca-gregory`, {
    dateStyle: 'medium',
    timeStyle: options.withSeconds ? 'medium' : 'short',
    timeZone: BANGKOK_TIME_ZONE,
  }).format(date);
}

export function formatThaiDateOnly(value: string | null | undefined): string {
  const datePart = value?.match(/^(\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.000)?Z)?$/)?.[1];
  if (!datePart) return '—';
  const date = new Date(`${datePart}T12:00:00.000Z`);
  if (Number.isNaN(date.valueOf())) return '—';
  return new Intl.DateTimeFormat(THAI_LOCALE, {
    dateStyle: 'medium',
    timeZone: BANGKOK_TIME_ZONE,
  }).format(date);
}

export function formatMarketDataAsOf(
  value: string | null | undefined,
  options: { dateOnly?: boolean; withSeconds?: boolean } = {},
): string {
  if (!value) return '—';
  if (options.dateOnly || isDateOnlyValue(value)) {
    const formatted = formatThaiDateOnly(value);
    return formatted === '—' ? formatted : `ข้อมูล ณ ${formatted}`;
  }
  return formatBangkokDateTime(value, { withSeconds: options.withSeconds });
}

export function isStaleAt(
  asOf: string | null,
  maxAgeSeconds: number | null,
  referenceTime: string,
): boolean {
  if (!asOf) return false;
  const asOfMs = Date.parse(asOf);
  const referenceMs = Date.parse(referenceTime);
  if (!Number.isFinite(asOfMs) || !Number.isFinite(referenceMs)) return false;
  return referenceMs - asOfMs > Math.max(300, maxAgeSeconds ?? 0) * 1_000;
}
