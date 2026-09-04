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
 * THE KEY NEVER REACHES THE OUTPUT
 * ===========================================================================
 * BLS ECHOES THE KEY BACK inside its own rejection message — "The
 * key:<32 hex> provided by the User is invalid" — so a probe that prints
 * `message` verbatim prints the secret into a terminal, a CI log and anything
 * scraping either. `redact` below removes it from every line before it is
 * shown. That is not hypothetical: it happened on the first run of this file.
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
if (!key && !anonymous) {
  console.error('BLS_API_KEY is not set. Add it to .env.local and rerun.');
  process.exit(2);
}

/**
 * Anything that looks like the key, gone — the configured one by value, and
 * any other 32-hex run by shape, so a message quoting a DIFFERENT key is not
 * printed either.
 */
function redact(text: string): string {
  const withoutOurs = key ? text.split(key).join('<redacted>') : text;
  return withoutOurs.replace(/\b[0-9a-f]{32}\b/gi, '<redacted>');
}

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
for (const line of payload.message ?? []) console.log(`  message: ${redact(line)}`);

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
