/**
 * The dashboard's vocabulary and its date arithmetic.
 *
 * Pure, so the one thing most likely to be quietly wrong on an operations
 * screen — a window that means a different day than the operator thinks — is
 * testable without a database.
 *
 * Every window here is a **Bangkok** calendar window. The server runs in UTC and
 * the ledger stores instants; "today" on this dashboard has to mean the day the
 * person reading it is having, or a revenue figure read at 09:00 Bangkok would
 * still be showing yesterday.
 */

export const dashboardRanges = ['today', '7d', '30d', 'month', 'custom'] as const;
export type DashboardRange = typeof dashboardRanges[number];

export const DASHBOARD_RANGE_LABEL: Readonly<Record<DashboardRange, string>> = {
  today: 'วันนี้',
  '7d': '7 วันล่าสุด',
  '30d': '30 วันล่าสุด',
  month: 'เดือนนี้',
  custom: 'กำหนดเอง',
};

export function normalizeDashboardRange(value: unknown): DashboardRange {
  return dashboardRanges.includes(value as DashboardRange) ? value as DashboardRange : '30d';
}

/** `YYYY-MM-DD` in Bangkok, for any instant. */
export function bangkokDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Calendar arithmetic on a `YYYY-MM-DD` string, with no timezone in sight. */
export function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

export function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function isCalendarDate(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export interface DashboardPeriod {
  range: DashboardRange;
  from: string;
  to: string;
}

/**
 * The window the dashboard asks the database for.
 *
 * A custom range with a missing or malformed bound falls back to the 30-day
 * window rather than erroring: a bad query string is a slip, and an operations
 * page that refuses to render is worse than one showing a sensible default.
 */
export function resolveDashboardPeriod(input: {
  range: unknown;
  from?: unknown;
  to?: unknown;
  now: Date;
}): DashboardPeriod {
  const today = bangkokDate(input.now);
  const range = normalizeDashboardRange(input.range);

  if (range === 'custom') {
    if (isCalendarDate(input.from) && isCalendarDate(input.to)) {
      return input.from <= input.to
        ? { range, from: input.from, to: input.to }
        : { range, from: input.to, to: input.from };
    }
    return { range: '30d', from: shiftDate(today, -29), to: today };
  }

  switch (range) {
    case 'today': return { range, from: today, to: today };
    case '7d': return { range, from: shiftDate(today, -6), to: today };
    case 'month': return { range, from: startOfMonth(today), to: today };
    case '30d':
    default: return { range: '30d', from: shiftDate(today, -29), to: today };
  }
}

/**
 * Baht from a currency's minor unit.
 *
 * Money is held as an integer of the minor unit everywhere in this product, and
 * it stays an integer through this function — no float ever touches a figure an
 * operator reconciles against a bank statement.
 */
export function formatMinorAsBaht(amountMinor: number | null | undefined, currency = 'thb'): string {
  if (amountMinor === null || amountMinor === undefined || !Number.isFinite(amountMinor)) return '—';
  const zeroDecimal = new Set(['jpy', 'krw', 'vnd', 'clp']);
  const whole = zeroDecimal.has(currency.toLowerCase())
    ? Math.round(amountMinor)
    : Math.round(amountMinor / 100);
  const sign = whole < 0 ? '-' : '';
  return `${sign}${Math.abs(whole).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Math.trunc(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export const activityKinds = ['all', 'payment', 'cancellation', 'refund', 'dispute'] as const;
export type ActivityKind = typeof activityKinds[number];

export function normalizeActivityKind(value: unknown): ActivityKind {
  return activityKinds.includes(value as ActivityKind) ? value as ActivityKind : 'all';
}

export const ACTIVITY_KIND_LABEL: Readonly<Record<ActivityKind, string>> = {
  all: 'ทั้งหมด',
  payment: 'การชำระเงิน',
  cancellation: 'การยกเลิก',
  refund: 'การคืนเงิน',
  dispute: 'การโต้แย้ง',
};

/** Page size and offset, clamped so a hand-edited query string cannot ask for everything. */
export function resolvePagination(input: { page?: unknown; pageSize?: number }): {
  page: number; pageSize: number; offset: number;
} {
  const pageSize = Math.min(Math.max(input.pageSize ?? 20, 1), 100);
  const parsed = Number(input.page);
  const page = Number.isFinite(parsed) && parsed >= 1 ? Math.min(Math.trunc(parsed), 1_000) : 1;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function totalPages(totalCount: number, pageSize: number): number {
  return Math.max(1, Math.ceil(totalCount / Math.max(1, pageSize)));
}
