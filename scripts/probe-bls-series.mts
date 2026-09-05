/**
 * DOES THE KEY WORK, AND IS EACH SERIES ID THE THING WE THINK IT IS.
 *
 * ===========================================================================
 * WHY THIS IS A PROBE AND NOT A TEST
 * ===========================================================================
 * A series id is a claim about the outside world — that `CES0000000001` is
 * total nonfarm employment and not, say, total PRIVATE nonfarm employment,
 * which differs by roughly 23 million people and looks exactly as plausible in
 * a JSON file. Nothing offline can check that. The v2 API answers it directly:
 * `catalog: true` returns the agency's own `series_title`, and this prints it
 * so a person can read it rather than a machine asserting a string somebody
 * typed twice.
 *
 * v1 could not do this. It ignores `catalog` and returns data with no
 * description at all, which is why the ids in this feature had never been
 * confirmed against anything but memory.
 *
 * ===========================================================================
 * ONE REQUEST, AND ONLY ONE
 * ===========================================================================
 * The free v2 tier allows 500 queries a day and 50 series per query. Every
 * series this feature could want fits in a single call, so this makes exactly
 * one and prints everything it got back. Running it repeatedly to check one id
 * at a time would be spending fifty times what the answer costs.
 *
 * Both the seasonally adjusted and the not-seasonally-adjusted variant of each
 * kind are requested together, because the choice between them is a decision
 * this feature has to make once and defend — see `bls-series.ts`.
 *
 * ===========================================================================
 * THE KEY NEVER REACHES THE OUTPUT, BY ANY PATH
 * ===========================================================================
 * BLS ECHOES THE KEY BACK inside its own rejection message — "The
 * key:<32 hex> provided by the User is invalid" — so a probe that prints
 * `message` verbatim prints the secret into a terminal, a CI log and anything
 * scraping either. That is not hypothetical: it happened on the first run of
 * this file.
 *
 * Redacting at each `console.log` was the first fix and it was not enough,
 * because it only covers the lines somebody REMEMBERED to wrap. The request
 * body carries the key, so a thrown fetch error, an unhandled rejection, a
 * stack trace quoting the payload, or a `console.log` added later by somebody
 * who has not read this header would all print it again.
 *
 * So the redaction is installed at the EXITS instead: `console.log`,
 * `console.error`, `console.warn` and the two process-level handlers are all
 * wrapped before the key is read. Nothing this script can print escapes it,
 * including output written by code that knows nothing about the key.
 *
 * `--anonymous` makes the same request with no key at all. v2 answers
 * unregistered callers with a smaller allowance and no catalog, which is
 * exactly what separates "the key is bad" from "the series id is bad" — the
 * one question a rejected key otherwise leaves unanswerable.
 *
 * Run: npm run probe:bls-series
 *      npm run probe:bls-series -- --anonymous
 */

const API = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';

/** Every candidate, in both adjustments, with what we BELIEVE each one is. */
const CANDIDATES: ReadonlyArray<{
  seriesId: string;
  kind: string;
  adjustment: 'SA' | 'NSA';
  believedToBe: string;
}> = [
  { seriesId: 'CUSR0000SA0', kind: 'CPI', adjustment: 'SA', believedToBe: 'CPI-U, all items, US city average' },
  { seriesId: 'CUUR0000SA0', kind: 'CPI', adjustment: 'NSA', believedToBe: 'CPI-U, all items, US city average' },
  { seriesId: 'WPSFD4', kind: 'PPI', adjustment: 'SA', believedToBe: 'PPI final demand' },
  { seriesId: 'WPUFD4', kind: 'PPI', adjustment: 'NSA', believedToBe: 'PPI final demand' },
  { seriesId: 'CES0000000001', kind: 'NFP', adjustment: 'SA', believedToBe: 'Total nonfarm employment, thousands' },
  { seriesId: 'CEU0000000001', kind: 'NFP', adjustment: 'NSA', believedToBe: 'Total nonfarm employment, thousands' },
];

const anonymous = process.argv.includes('--anonymous');
const key = process.env.BLS_API_KEY;

/**
 * Anything that looks like the key, gone — the configured one by value, and
 * any other 32-hex run by shape, so a message quoting a DIFFERENT key is not
 * printed either.
 */
function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    const withoutOurs = key ? value.split(key).join('<redacted>') : value;
    return withoutOurs.replace(/\b[0-9a-f]{32}\b/gi, '<redacted>');
  }
  if (value instanceof Error) {
    /*
      A rebuilt Error rather than a mutated one: `message` and `stack` are the
      two places a fetch failure quotes the request, and both are read-only on
      some runtimes.
    */
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

/*
 * INSTALLED BEFORE ANYTHING ELSE RUNS. Every console exit and both process-level
 * handlers go through `redact`, so output from code that has never heard of the
 * key — a thrown fetch error, a stack trace, a line added here next year — is
 * covered without anybody having to remember.
 */
for (const channel of ['log', 'error', 'warn'] as const) {
  const original = console[channel].bind(console);
  console[channel] = (...parts: unknown[]) => original(...parts.map(redact));
}
process.on('uncaughtException', (error) => {
  console.error('uncaught:', redact(error));
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandled rejection:', redact(reason));
  process.exit(1);
});

if (!key && !anonymous) {
  console.error('BLS_API_KEY is not set. Add it to .env.local and rerun.');
  process.exit(2);
}

/*
  Wrapped so a transport failure — DNS, TLS, a proxy rewriting the body — is
  reported through the redacting console rather than as an unhandled rejection
  that some runtimes print before the handler above can run.
*/
const response = await fetch(API, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    seriesid: CANDIDATES.map((entry) => entry.seriesId),
    startyear: String(new Date().getUTCFullYear() - 1),
    endyear: String(new Date().getUTCFullYear()),
    catalog: true,
    ...(anonymous ? {} : { registrationkey: key }),
  }),
});

if (!response.ok) {
  console.error(`HTTP ${response.status} ${response.statusText}`);
  process.exit(1);
}

const payload = await response.json() as {
  status: string;
  message?: string[];
  Results?: {
    series?: Array<{
      seriesID: string;
      catalog?: Record<string, string>;
      data?: Array<{ year: string; period: string; periodName: string; value: string; footnotes?: Array<{ code?: string; text?: string }> }>;
    }>;
  };
};

console.log(`mode: ${anonymous ? 'anonymous (no key)' : 'registered key'}`);
console.log(`status: ${payload.status}`);
for (const line of payload.message ?? []) console.log(`  message: ${line}`);

if (payload.status !== 'REQUEST_SUCCEEDED') {
  console.error('\nThe key or the request was rejected. Nothing below is trustworthy.');
  process.exit(1);
}

const series = payload.Results?.series ?? [];
console.log(`\nseries returned: ${series.length} of ${CANDIDATES.length}\n`);

for (const candidate of CANDIDATES) {
  const found = series.find((entry) => entry.seriesID === candidate.seriesId);
  console.log(`${candidate.seriesId}  [${candidate.kind} ${candidate.adjustment}]`);
  console.log(`  believed to be : ${candidate.believedToBe}`);
  if (!found) {
    console.log('  BLS says       : (series not returned)');
    console.log('');
    continue;
  }
  const catalog = found.catalog;
  if (!catalog) {
    /*
      The catalog is not guaranteed even on v2 — some series carry no
      descriptive record. Reported rather than papered over: an unconfirmed id
      is a different state from a confirmed one and the decision about what to
      do with it belongs to a person.
    */
    console.log('  BLS says       : (no catalog record returned for this series)');
  } else {
    console.log(`  BLS says       : ${catalog.series_title ?? '(no series_title)'}`);
    for (const field of ['survey_name', 'seasonality', 'measure_data_type', 'area', 'item'] as const) {
      if (catalog[field]) console.log(`  ${field.padEnd(15)}: ${catalog[field]}`);
    }
  }
  const latest = (found.data ?? [])[0];
  if (latest) {
    const notes = (latest.footnotes ?? []).map((note) => note.text).filter(Boolean);
    console.log(`  latest         : ${latest.year} ${latest.periodName} (${latest.period}) = ${latest.value}`
      + `${notes.length ? `  [${notes.join('; ')}]` : ''}`);
  }
  console.log('');
}
