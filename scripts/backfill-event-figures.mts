import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BLS_SERIES, CATALOG_VERIFIED } from '@/src/lib/market-events/bls-series';
import { thaiShortMonthLabel } from '@/src/lib/market-events/time';
import type { MarketEvent, MarketEventKind } from '@/src/lib/market-events/types';

/**
 * WRITES THE PUBLISHED FIGURES INTO `src/data/market-event-figures.json`.
 *
 * ===========================================================================
 * WHY A SCRIPT AND NOT A FETCH AT RENDER
 * ===========================================================================
 * A published statistic for a past month does not change between renders. When
 * it does change it is because BLS revised it, and a revision is exactly the
 * kind of thing that should arrive as a reviewable diff on a committed file
 * rather than as a number that silently moved under a reader. The same argument
 * `backfill-event-reactions.ts` makes, for the same reason.
 *
 * ===========================================================================
 * ONE QUERY
 * ===========================================================================
 * Three series, one call. The tier allows 50 series per query, so asking for
 * them separately would spend three times what the answer costs. The year range
 * is derived from the calendar rather than typed, so it stays right when the
 * calendar moves.
 *
 * ===========================================================================
 * ANONYMOUS, AND THAT IS A RECORDED LIMITATION
 * ===========================================================================
 * v2 answers unregistered callers with values and footnotes but no catalog, so
 * the series ids behind these numbers were never confirmed against BLS's own
 * titles. `access` and `catalogVerified` go into `_provenance` saying exactly
 * that, and `bls-series.test.ts` stays red until somebody settles it.
 *
 * The key is read if present and used if it works; the run does not depend on
 * it. Nothing about the key is ever printed — BLS echoes it back inside its own
 * rejection message, so every console exit is wrapped before it is read.
 *
 * ===========================================================================
 * THE JOIN IS `referencePeriod`, NOT THE RELEASE DATE
 * ===========================================================================
 * A release on 11 September publishes AUGUST's number. Deriving that from the
 * release date would be a rule with exceptions — the calendar already carries
 * `referencePeriod` on every row, written when the row was transcribed from the
 * agency's schedule, and that is the authority. `at` is never read here and
 * never touched.
 *
 * A release whose reference month BLS has not published yet gets no row at all,
 * which is most of them: the calendar runs to December and the data stops at
 * the last published month. That is the correct answer and the panel renders
 * nothing for it.
 *
 * Run: npm run backfill:event-figures
 */

const API = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
const OUT = path.resolve('src/data/market-event-figures.json');

const key = process.env.BLS_API_KEY;

/** Every console exit, wrapped before the key is used. See the header. */
function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    const withoutOurs = key ? value.split(key).join('<redacted>') : value;
    return withoutOurs.replace(/\b[0-9a-f]{32}\b/gi, '<redacted>');
  }
  if (value instanceof Error) {
    const copy = new Error(redact(value.message) as string);
    copy.stack = typeof value.stack === 'string' ? redact(value.stack) as string : undefined;
    return copy;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
  }
  return value;
}
for (const channel of ['log', 'error', 'warn'] as const) {
  const original = console[channel].bind(console);
  console[channel] = (...parts: unknown[]) => original(...parts.map(redact));
}
process.on('uncaughtException', (error) => { console.error('uncaught:', redact(error)); process.exit(1); });
process.on('unhandledRejection', (reason) => { console.error('unhandled:', redact(reason)); process.exit(1); });

const calendar = JSON.parse(readFileSync(path.resolve('src/data/market-events.json'), 'utf8')) as {
  events: MarketEvent[];
};

/** Only the kinds BLS publishes. The other four have no series — by design. */
const events = calendar.events.filter((event) => event.kind in BLS_SERIES);
if (events.length === 0) {
  console.error('no BLS-backed events in the calendar; nothing to do');
  process.exit(1);
}

/**
 * "August 2026" → { year: 2026, month: 8 }.
 *
 * The calendar writes reference periods in English month names. A period this
 * cannot read is REPORTED and skipped rather than guessed at — a wrong month is
 * a wrong number under a real date.
 */
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];
function parseReferencePeriod(raw: string): { year: number; month: number } | null {
  const match = /^([A-Za-z]+)\s+(\d{4})$/.exec(raw.trim());
  if (!match) return null;
  const month = MONTHS.indexOf(match[1].toLowerCase()) + 1;
  if (month === 0) return null;
  return { year: Number(match[2]), month };
}

const wanted = events.map((event) => ({ event, period: parseReferencePeriod(event.referencePeriod) }));
const unreadable = wanted.filter((entry) => !entry.period);
for (const entry of unreadable) {
  console.warn(`skipping ${entry.event.id}: cannot read referencePeriod ${JSON.stringify(entry.event.referencePeriod)}`);
}

const years = wanted.flatMap((entry) => (entry.period ? [entry.period.year] : []));
/* One year earlier, because every row also wants the month before its own. */
const startYear = Math.min(...years) - 1;
const endYear = Math.max(...years);

const kinds = [...new Set(events.map((event) => event.kind))] as MarketEventKind[];
const seriesForKind = new Map(kinds.map((kind) => [kind, BLS_SERIES[kind]!]));

console.log(`asking BLS for ${seriesForKind.size} series, ${startYear}-${endYear}, in one query`);

const response = await fetch(API, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    seriesid: [...seriesForKind.values()].map((binding) => binding.seriesId),
    startyear: String(startYear),
    endyear: String(endYear),
    catalog: true,
    ...(key ? { registrationkey: key } : {}),
  }),
});

type Observation = {
  year: string;
  period: string;
  periodName: string;
  value: string;
  footnotes?: Array<{ code?: string; text?: string }>;
};
const payload = await response.json() as {
  status: string;
  message?: string[];
  Results?: { series?: Array<{ seriesID: string; catalog?: Record<string, string>; data?: Observation[] }> };
};

for (const line of payload.message ?? []) console.log(`  ${line}`);

/*
 * A REGISTERED RUN THAT FAILS FALLS BACK TO ANONYMOUS RATHER THAN TO NOTHING,
 * and says so. What must never happen is a file written as though it were
 * catalog-verified when the request that produced it was not.
 */
let access: 'registered' | 'anonymous' = key ? 'registered' : 'anonymous';
let results = payload;
if (payload.status !== 'REQUEST_SUCCEEDED') {
  if (!key) {
    console.error(`BLS refused the anonymous request: ${payload.status}`);
    process.exit(1);
  }
  console.warn(`the key was refused (${payload.status}); retrying without it`);
  const retry = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      seriesid: [...seriesForKind.values()].map((binding) => binding.seriesId),
      startyear: String(startYear),
      endyear: String(endYear),
    }),
  });
  results = await retry.json();
  for (const line of results.message ?? []) console.log(`  ${line}`);
  if (results.status !== 'REQUEST_SUCCEEDED') {
    console.error(`BLS refused the anonymous request too: ${results.status}`);
    process.exit(1);
  }
  access = 'anonymous';
}

const catalogSeen = (results.Results?.series ?? []).some((entry) => Boolean(entry.catalog));
console.log(`access: ${access} · catalog returned: ${catalogSeen}`);

/** seriesId → (year-month → observation). */
const bySeries = new Map<string, Map<string, Observation>>();
for (const entry of results.Results?.series ?? []) {
  const months = new Map<string, Observation>();
  for (const point of entry.data ?? []) {
    /* Monthly periods only. M13 is BLS's annual average, not a month. */
    if (!/^M(0[1-9]|1[0-2])$/.test(point.period)) continue;
    months.set(`${point.year}-${point.period.slice(1)}`, point);
  }
  bySeries.set(entry.seriesID, months);
}

const toObservation = (point: Observation) => {
  const monthKey = `${point.year}-${point.period.slice(1)}`;
  return {
    year: Number(point.year),
    period: point.period,
    periodLabel: `${point.periodName} ${point.year}`,
    periodLabelTh: thaiShortMonthLabel(monthKey),
    value: Number(point.value),
    footnotes: (point.footnotes ?? [])
      .map((note) => (note.text ?? '').trim())
      .filter((text) => text.length > 0),
  };
};

const figures = [];
const missing: string[] = [];
for (const { event, period } of wanted) {
  if (!period) continue;
  const binding = seriesForKind.get(event.kind)!;
  const months = bySeries.get(binding.seriesId);
  const monthKey = `${period.year}-${String(period.month).padStart(2, '0')}`;
  const latest = months?.get(monthKey);
  if (!latest) {
    missing.push(`${event.id} (${event.referencePeriod})`);
    continue;
  }
  const previousMonth = new Date(Date.UTC(period.year, period.month - 2, 1));
  const previousKey = previousMonth.toISOString().slice(0, 7);
  const previous = months?.get(previousKey);

  figures.push({
    eventId: event.id,
    kind: event.kind,
    seriesId: binding.seriesId,
    adjustment: binding.adjustment,
    unit: binding.unit,
    latest: toObservation(latest),
    previous: previous ? toObservation(previous) : null,
  });
}

figures.sort((left, right) => (left.eventId < right.eventId ? -1 : 1));

const file = {
  schemaVersion: 1,
  _provenance: {
    source: 'BLS',
    api: API,
    access,
    /*
      Only ever true when BLS actually returned a catalog AND the table has been
      checked against it by a person. The probe prints the titles; this cannot
      tell whether anybody read them, so it defers to the constant.
    */
    catalogVerified: catalogSeen && CATALOG_VERIFIED,
    fetchedAt: new Date().toISOString(),
    series: [...seriesForKind.entries()].map(([kind, binding]) => ({
      kind,
      seriesId: binding.seriesId,
      adjustment: binding.adjustment,
    })),
  },
  figures,
};

writeFileSync(OUT, `${JSON.stringify(file, null, 2)}\n`, 'utf8');

console.log(`\nwrote ${figures.length} figure(s) to ${OUT}`);
for (const row of figures) {
  const note = row.latest.footnotes.length ? ` [${row.latest.footnotes.join('; ')}]` : '';
  console.log(`  ${row.eventId.padEnd(20)} ${row.latest.periodLabel.padEnd(16)}`
    + ` ${row.latest.value}${row.previous ? ` (prev ${row.previous.value})` : ''}${note}`);
}
if (missing.length > 0) {
  console.log(`\nnot published yet, so no row — this is expected for future releases:`);
  for (const line of missing) console.log(`  ${line}`);
}
if (!file._provenance.catalogVerified) {
  console.log('\ncatalogVerified: false — the series ids behind these numbers are'
    + ' still unconfirmed. See bls-series.test.ts.');
}
