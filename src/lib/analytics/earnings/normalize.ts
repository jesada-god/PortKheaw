import type { EarningsCandidate, EarningsTimeOfDay } from './types';

/**
 * Pure parsing/selection for the earnings calendar. Kept free of `fetch` so the
 * exact provider payloads that production consumes can be asserted in tests.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function timeOfDay(value: unknown): EarningsTimeOfDay {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'pre-market' || raw === 'bmo' || raw === 'before market open') return 'pre-market';
  if (raw === 'post-market' || raw === 'amc' || raw === 'after market close') return 'post-market';
  return 'unknown';
}

function optionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Split one CSV line, honouring double-quoted fields. Alpha Vantage returns the
 * earnings calendar as CSV and company names legitimately contain commas.
 */
export function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { current += '"'; index += 1; continue; }
      quoted = !quoted;
      continue;
    }
    if (character === ',' && !quoted) { fields.push(current); current = ''; continue; }
    current += character;
  }
  fields.push(current);
  return fields.map((field) => field.trim());
}

/**
 * Detect Alpha Vantage's service notice when it is disguised as CSV.
 *
 * On a quota or plan fault the CSV endpoint keeps the real header row and then
 * renders its JSON note ONE CHARACTER PER FIELD, truncated to the header width
 * — a live quota response is literally `symbol,name,...\r\nI,n,f,o,r,m,a`.
 * Without this check that row parses as a symbol-less earnings row and the
 * failure would be mislabelled "no scheduled report".
 */
export function alphaVantageNotice(body: string): string | null {
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines.slice(1)) {
    const fields = splitCsvLine(line);
    if (fields.length > 1 && fields.every((field) => field.length <= 1)) return fields.join('');
  }
  return null;
}

/**
 * Parse the Alpha Vantage `EARNINGS_CALENDAR` CSV. A non-CSV body (Alpha
 * Vantage answers rate limits and premium refusals with a JSON note) yields an
 * empty list so the caller can fall through to the secondary provider.
 */
export function parseAlphaVantageEarningsCsv(body: string, symbol: string): EarningsCandidate[] {
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const header = splitCsvLine(lines[0]).map((field) => field.toLowerCase());
  const symbolIndex = header.indexOf('symbol');
  const dateIndex = header.indexOf('reportdate');
  if (symbolIndex < 0 || dateIndex < 0) return [];
  const estimateIndex = header.indexOf('estimate');
  const timeIndex = header.indexOf('timeoftheday');
  const wanted = symbol.trim().toUpperCase();

  return lines.slice(1).flatMap((line): EarningsCandidate[] => {
    const fields = splitCsvLine(line);
    const rowSymbol = (fields[symbolIndex] ?? '').toUpperCase();
    const reportDate = fields[dateIndex] ?? '';
    if (rowSymbol !== wanted || !ISO_DATE.test(reportDate)) return [];
    return [{
      symbol: rowSymbol,
      reportDate,
      timeOfDay: timeIndex >= 0 ? timeOfDay(fields[timeIndex]) : 'unknown',
      epsEstimate: estimateIndex >= 0 ? optionalNumber(fields[estimateIndex]) : null,
    }];
  });
}

/**
 * Parse Financial Modeling Prep's `earnings` rows. FMP returns the full history
 * plus scheduled future periods for the requested symbol; only shape and symbol
 * are validated here, and "which row is next" stays with {@link nextEarnings}.
 */
export function parseFinancialModelingPrepEarnings(payload: unknown, symbol: string): EarningsCandidate[] {
  if (!Array.isArray(payload)) return [];
  const wanted = symbol.trim().toUpperCase();
  return payload.flatMap((row): EarningsCandidate[] => {
    if (!row || typeof row !== 'object') return [];
    const record = row as Record<string, unknown>;
    const rowSymbol = typeof record.symbol === 'string' ? record.symbol.toUpperCase() : '';
    const reportDate = typeof record.date === 'string' ? record.date.slice(0, 10) : '';
    if (rowSymbol !== wanted || !ISO_DATE.test(reportDate)) return [];
    return [{
      symbol: rowSymbol,
      reportDate,
      timeOfDay: 'unknown',
      epsEstimate: optionalNumber(record.epsEstimated),
    }];
  });
}

/** Whole calendar days between two `YYYY-MM-DD` dates; null when either is malformed. */
export function calendarDaysUntil(fromDate: string, toDate: string): number | null {
  if (!ISO_DATE.test(fromDate) || !ISO_DATE.test(toDate)) return null;
  const from = Date.parse(`${fromDate}T00:00:00.000Z`);
  const to = Date.parse(`${toDate}T00:00:00.000Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

/**
 * The next scheduled report on or after `today`, in exchange-local dates. Rows
 * in the past are historical results, not event risk, and are discarded.
 */
export function nextEarnings(
  candidates: readonly EarningsCandidate[],
  today: string,
): (EarningsCandidate & { daysToEarnings: number }) | null {
  const upcoming = candidates
    .flatMap((candidate) => {
      const daysToEarnings = calendarDaysUntil(today, candidate.reportDate);
      return daysToEarnings === null || daysToEarnings < 0 ? [] : [{ ...candidate, daysToEarnings }];
    })
    .sort((left, right) => left.daysToEarnings - right.daysToEarnings
      || left.reportDate.localeCompare(right.reportDate));
  return upcoming[0] ?? null;
}
