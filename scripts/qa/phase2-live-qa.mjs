/**
 * ONE FLAG AT A TIME, CHECKED AGAINST PRODUCTION, READ ONLY.
 *
 * ===========================================================================
 * WHAT THIS IS FOR
 * ===========================================================================
 * `docs/operations/phase2-flag-rollout.md` turns the four flags on in an order
 * chosen to keep attribution: free ones first, the one that buys provider quotes
 * alone, the one with a write path last. That order only pays for itself if
 * something looks at production between the steps, which is this.
 *
 * It takes ONE flag name and checks the claims that flag is responsible for.
 * Checking everything after every step would mean a red result that does not say
 * which switch caused it — the exact property the ordering exists to preserve.
 *
 * ===========================================================================
 * IT WRITES NOTHING, AND IT SWITCHES NOTHING
 * ===========================================================================
 * Every request is a GET: the Overview document, and — for `alerts` — two
 * counting reads against PostgREST. It cannot turn a flag on or off; the flags
 * live in Vercel's environment and this never touches it. Turning them on is a
 * person's job, on purpose.
 *
 * The one thing it needs a key for is the `alerts` check, which counts rows in
 * `overview_alert_hits`. It uses the ANON key and `Prefer: count=exact`, so it
 * reads a count through RLS and never a row: no reader's alert history is
 * fetched in order to check that the sweep ran.
 *
 * ===========================================================================
 * WHAT "PASS" MEANS FOR EACH FLAG
 * ===========================================================================
 * A flag is responsible for the markers it makes appear and for nothing else.
 * `PHASE2_ALERTS` is the exception in both directions: signed out it changes
 * NOTHING on the page — the alert count is per reader — so its page check is
 * that the Overview is unharmed, and its real evidence is a row appearing in
 * `overview_alert_hits` after a pg_cron tick.
 *
 *   node scripts/qa/phase2-live-qa.mjs --flag events
 *   node scripts/qa/phase2-live-qa.mjs --flag market-snapshot
 *   node scripts/qa/phase2-live-qa.mjs --flag what-changed
 *   node scripts/qa/phase2-live-qa.mjs --flag alerts --wait-for-tick
 *   node scripts/qa/phase2-live-qa.mjs --flag baseline    # FIRST, before any flag
 *
 * Or through npm:
 *
 *   npm run verify:phase2-live -- --flag events
 */

import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
}
const has = (name) => args.includes(`--${name}`);

const BASE = (arg('base', 'https://portkheaw.vercel.app')).replace(/\/$/, '');
const FLAG = arg('flag');
const SAMPLES = Number(arg('samples', '7'));
const OUT = resolve(arg('out', '.qa/artifacts/phase2-live'));
const WAIT_FOR_TICK = has('wait-for-tick');
const BROWSER = process.env.QA_BROWSER_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/**
 * THE 413 ms IN THE ROLLOUT DOC IS NOT A BASELINE FOR THIS SCRIPT.
 *
 * That number is the median server document time from
 * `overview-phase2-qa.mjs`, measured against `next start` on **localhost**. This
 * script measures **production over the internet**: DNS, TLS, a round trip to
 * `iad1`, and a lambda that may be cold. Production answers this machine in
 * roughly 2 s with every flag off — about 5x the local figure — and none of that
 * difference is anything a flag did.
 *
 * Comparing the two would fail every rollout step for a reason that has nothing
 * to do with the change being checked, which is worse than not checking at all.
 *
 * So the baseline is measured on the SAME CHANNEL: `--flag baseline` records
 * production's own median to {@link BASELINE_FILE} before any flag is on, and
 * every later run compares against that. With no recorded baseline the ratio is
 * reported and NOT gated, saying so — an unanchored number is information, not a
 * verdict.
 */
const BASELINE_FILE = resolve(OUT, 'baseline.json');
const BASELINE_OVERRIDE = arg('baseline-ms');
const MAX_RATIO = Number(arg('max-ratio', '2'));

function readBaseline() {
  if (BASELINE_OVERRIDE) {
    return { median: Number(BASELINE_OVERRIDE), source: '--baseline-ms' };
  }
  try {
    const saved = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
    if (Number.isFinite(saved.median)) {
      return { median: saved.median, source: `${BASELINE_FILE} (${saved.recordedAt})` };
    }
  } catch {
    /* No baseline recorded yet. Reported below rather than guessed at. */
  }
  return null;
}

/**
 * What each flag is answerable for.
 *
 * `expect` are markers that MUST appear once the flag is on. `forbid` are
 * markers that must NOT — they belong to a different flag, and seeing one means
 * more than the intended switch moved.
 */
const FLAGS = {
  baseline: {
    env: '(none — every flag off)',
    expect: [],
    forbid: [
      ['market-today-strip', '[data-testid="market-today-strip"]'],
      ['market-today-status', '[data-testid="market-today-status"]'],
      ['overview-changes', '[data-testid="overview-changes"]'],
      ['overview-events', '[data-testid="overview-events"]'],
    ],
    note: 'Run this FIRST, before any flag is on. It records the production '
      + 'median as the baseline every later run is gated against, and confirms '
      + 'the starting point has none of the Phase 2 markers.',
  },
  events: {
    env: 'PHASE2_EVENTS',
    expect: [['overview-events', '[data-testid="overview-events"]']],
    forbid: [
      ['market-today-strip', '[data-testid="market-today-strip"]'],
      ['overview-changes', '[data-testid="overview-changes"]'],
    ],
    note: 'Costs nothing — the calendar is a static import. Signed out the list '
      + 'may be empty; the SECTION is what must appear.',
  },
  'what-changed': {
    env: 'PHASE2_WHAT_CHANGED',
    expect: [['overview-changes', '[data-testid="overview-changes"]']],
    forbid: [['market-today-strip', '[data-testid="market-today-strip"]']],
    note: 'Costs nothing — it renames items the detectors already produced. '
      + 'Needs WATCHLIST_V2 as well for the capped watchlist view.',
  },
  'market-snapshot': {
    env: 'PHASE2_MARKET_SNAPSHOT',
    expect: [
      ['market-today-strip', '[data-testid="market-today-strip"]'],
      ['market-today-status', '[data-testid="market-today-status"]'],
      ['market-today-reasons', '[data-testid="market-today-reasons"]'],
    ],
    forbid: [['overview-changes', '[data-testid="overview-changes"]']],
    note: 'The only flag that spends: six provider quotes behind a 60s shared '
      + 'cache. Watch the timing number here more than anywhere else.',
  },
  alerts: {
    env: 'PHASE2_ALERTS',
    /*
      Nothing to expect on the page, and that is the finding rather than a gap.
      The alert count is per reader and this runs signed out, so the correct
      page-level claim is that the Overview is unharmed. The evidence that the
      flag did something is `overview_alert_hits` growing after a cron tick.
    */
    expect: [],
    forbid: [],
    note: 'Signed out this flag changes nothing on the page. Its real evidence '
      + 'is the hit count after the next pg_cron tick — pass --wait-for-tick.',
    checkHits: true,
  },
};

if (!FLAG || !FLAGS[FLAG]) {
  console.error(
    `--flag is required, and must be one of: ${Object.keys(FLAGS).join(', ')}\n\n`
    + '  node scripts/qa/phase2-live-qa.mjs --flag events\n'
    + '  node scripts/qa/phase2-live-qa.mjs --flag alerts --wait-for-tick\n',
  );
  process.exit(2);
}

const SPEC = FLAGS[FLAG];
mkdirSync(OUT, { recursive: true });

const failures = [];
/** Checks that did not run, so a green verdict cannot imply they did. */
const unverified = [];
const report = { flag: FLAG, env: SPEC.env, base: BASE, generatedAt: new Date().toISOString() };

function check(claim, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${claim}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(`${claim}${detail ? ` — ${detail}` : ''}`);
}

/** Median, because one slow sample must not decide a rollout step. */
function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * How long the SERVER takes to produce the Overview document.
 *
 * The same measurement `overview-phase2-qa.mjs` gates on, so the 413 ms baseline
 * it produced is comparable. One warm-up first, and the first timed sample is
 * still discarded from the median by taking the middle value.
 */
async function timeDocument() {
  const url = `${BASE}/`;
  await fetch(url, { redirect: 'manual' }).catch(() => null);
  const durations = [];
  let status = null;
  let location = null;
  for (let index = 0; index < SAMPLES; index += 1) {
    const started = performance.now();
    const response = await fetch(url, { redirect: 'manual' });
    await response.arrayBuffer();
    durations.push(performance.now() - started);
    status = response.status;
    location = response.headers.get('location');
    if (status !== 200) break;
  }
  return {
    status,
    location,
    durations: durations.map((value) => Math.round(value)),
    median: status === 200 ? Math.round(median(durations)) : null,
  };
}

/**
 * Rows in `overview_alert_hits`, counted through RLS with the anon key.
 *
 * `Prefer: count=exact` with `Range: 0-0` returns the total in a header and at
 * most one row in the body, which is discarded. Signed out, RLS scopes the
 * SELECT to nothing, so this counts what an anonymous caller may see — which is
 * the honest limit and is stated in the result rather than worked around.
 */
async function countHits() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return { ok: false, reason: 'no NEXT_PUBLIC_SUPABASE_* in the environment' };

  const response = await fetch(`${url}/rest/v1/overview_alert_hits?select=id`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: 'count=exact',
      Range: '0-0',
    },
  });
  const range = response.headers.get('content-range');
  if (!response.ok && response.status !== 206) {
    return { ok: false, reason: `HTTP ${response.status}`, range };
  }
  const total = Number(String(range ?? '').split('/')[1]);
  return { ok: Number.isFinite(total), total, range };
}

/** The next quarter-hour boundary the pg_cron schedule fires on, plus a margin. */
function msUntilNextTick(margin = 75_000) {
  const now = new Date();
  const next = new Date(now);
  next.setUTCMinutes(Math.floor(now.getUTCMinutes() / 15) * 15 + 15, 0, 0);
  return (next.getTime() - now.getTime()) + margin;
}

async function main() {
  const baseline = readBaseline();
  console.log(`Flag     : ${FLAG}  (${SPEC.env})`);
  console.log(`Target   : ${BASE}`);
  console.log(baseline
    ? `Baseline : ${baseline.median} ms, gate ${MAX_RATIO}x — from ${baseline.source}`
    : 'Baseline : none recorded — run --flag baseline first; timing is reported, not gated');
  console.log(`\n${SPEC.note}\n`);

  /* ------------------------------------------------------------ timing */
  console.log('timing');
  const timing = await timeDocument();
  report.timing = timing;
  check(
    'the Overview answers 200',
    timing.status === 200,
    timing.status === 200 ? '' : `HTTP ${timing.status}${timing.location ? ` -> ${timing.location}` : ''}`,
  );
  if (timing.status !== 200) {
    /*
      A 307 here is the maintenance gate, and every check below would be
      measuring the notice rather than the product. Stop rather than report
      four confident falsehoods about a page nobody was served.
    */
    return finish();
  }
  if (FLAG === 'baseline') {
    /*
      Recording, not gating. This run IS the reference every later one compares
      against, so there is nothing yet to compare it to.
    */
    const recorded = { median: timing.median, recordedAt: new Date().toISOString(), base: BASE };
    writeFileSync(BASELINE_FILE, `${JSON.stringify(recorded, null, 2)}\n`, 'utf8');
    console.log(`  ok   recorded ${timing.median} ms as the production baseline`);
    console.log(`       samples ${timing.durations.join(', ')}`);
    console.log(`       -> ${BASELINE_FILE}`);
    report.recordedBaseline = recorded;
  } else if (baseline) {
    const ratio = Number((timing.median / baseline.median).toFixed(2));
    report.timing.ratio = ratio;
    report.timing.baselineMs = baseline.median;
    check(
      `median ${timing.median} ms is within ${MAX_RATIO}x of the ${baseline.median} ms baseline`,
      ratio <= MAX_RATIO,
      `${ratio}x · samples ${timing.durations.join(', ')}`,
    );
  } else {
    /*
      No anchor, so no verdict. Printing a ratio against the doc's 413 ms would
      be comparing a round trip to Virginia against a loopback socket, and it
      would fail every step for a reason no flag caused.
    */
    console.log(`  --   median ${timing.median} ms · samples ${timing.durations.join(', ')}`);
    console.log('       not gated: no baseline recorded. Run --flag baseline first.');
  }

  /* ------------------------------------------------- markers + overflow */
  const browser = await chromium.launch({ executablePath: BROWSER, headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${String(error)}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });

    const response = await page.goto(`${BASE}/`, {
      waitUntil: 'networkidle', timeout: 120_000,
    });
    report.status = response?.status() ?? null;

    console.log('\nmarkers');
    for (const [name, selector] of SPEC.expect) {
      const count = await page.locator(selector).count();
      check(`${name} is present`, count > 0, `found ${count}`);
    }
    for (const [name, selector] of SPEC.forbid) {
      const count = await page.locator(selector).count();
      check(`${name} is absent (belongs to another flag)`, count === 0, `found ${count}`);
    }
    if (SPEC.expect.length === 0 && SPEC.forbid.length === 0) {
      const news = await page.locator('[data-testid="overview-news"]').count();
      const watchlist = await page.locator('[data-testid="overview-watchlist"]').count();
      check('the Overview still renders its existing sections', news > 0 && watchlist > 0,
        `news ${news}, watchlist ${watchlist}`);
    }

    console.log('\nlayout at 375px');
    const overflow = await page.evaluate(() => ({
      documentScrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      offenders: [...document.querySelectorAll('main *')]
        .filter((node) => node.getBoundingClientRect().right > window.innerWidth + 1)
        .filter((node) => !node.closest('.data-strip-scroll, .bleed-mobile, [class*="overflow-x-auto"]'))
        .slice(0, 8)
        .map((node) => `${node.tagName}.${String(node.className).slice(0, 70)}`),
    }));
    report.overflow = overflow;
    check(
      'the page does not scroll sideways',
      overflow.offenders.length === 0,
      overflow.offenders.join(' | '),
    );

    console.log('\nconsole');
    report.errors = errors;
    check('no page or console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

    await page.screenshot({ path: `${OUT}/${FLAG}-full-375.png`, fullPage: true });
    console.log(`  captured ${OUT}/${FLAG}-full-375.png`);
    await context.close();
  } finally {
    await browser.close();
  }

  /* ------------------------------------------------------- alerts only */
  if (SPEC.checkHits) {
    console.log('\noverview_alert_hits');
    const before = await countHits();
    report.hitsBefore = before;
    if (!before.ok) {
      check('the hit count could be read', false, before.reason);
    } else {
      console.log(`  before: ${before.total} row(s) visible to anon`);
      if (!WAIT_FOR_TICK) {
        console.log('  --wait-for-tick not given; not waiting for the sweep.');
        console.log('  Re-run with --wait-for-tick after the flag is on to see a tick land.');
        /*
          The page checks above pass whether this flag is on or off — signed out
          it changes nothing visible — so without the tick this run has not
          actually verified PHASE2_ALERTS at all. Say so, rather than let a green
          verdict imply otherwise.
        */
        unverified.push(
          'PHASE2_ALERTS was not verified: the page looks identical either way, '
          + 'and the sweep evidence needs --wait-for-tick',
        );
      } else {
        const waitMs = msUntilNextTick();
        console.log(`  waiting ${Math.round(waitMs / 1000)}s for the next quarter-hour tick...`);
        await new Promise((done) => { setTimeout(done, waitMs); });
        const after = await countHits();
        report.hitsAfter = after;
        console.log(`  after:  ${after.total} row(s) visible to anon`);
        check(
          'the sweep wrote at least one hit',
          after.ok && after.total > before.total,
          `${before.total} -> ${after.total}. `
          + 'Zero is also what a tick with no MATCHING rule looks like — check '
          + 'alert_evaluation_runs for the window before calling this a failure.',
        );
      }
    }
  }

  return finish();
}

function finish() {
  report.failures = failures;
  report.unverified = unverified;
  writeFileSync(`${OUT}/${FLAG}-report.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nreport: ${OUT}/${FLAG}-report.json`);
  if (unverified.length > 0) {
    console.log(`\nNOT VERIFIED:\n  ${unverified.join('\n  ')}`);
  }
  if (failures.length === 0) {
    /*
      "Nothing failed" and "the flag was checked" are different claims, and only
      one of them is safe to read as a green light. A run that could not gather
      its evidence says so instead of borrowing the word PASS unqualified.
    */
    console.log(unverified.length === 0
      ? `\nPASS — ${FLAG} looks right in production.`
      : '\nPASS as far as it went — nothing failed, but see NOT VERIFIED above.');
    process.exit(0);
  }
  console.error(`\nFAILED (${failures.length}):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}

await main();
