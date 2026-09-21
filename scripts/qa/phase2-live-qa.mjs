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
 * Every request is a GET of the Overview document. It cannot turn a flag on or
 * off; the flags live in Vercel's environment and this never touches it.
 * Turning them on is a person's job, on purpose.
 *
 * ===========================================================================
 * WHAT "PASS" MEANS FOR EACH FLAG
 * ===========================================================================
 * A flag is responsible for the markers it makes appear and for nothing else.
 * `PHASE2_ALERTS` is the exception: signed out it changes NOTHING on the page —
 * the alert count badge is per reader and behind RLS — so its page check is only
 * that the Overview is unharmed, and the run reports it as NOT VERIFIED rather
 * than borrowing a green from checks that would pass either way. Verifying the
 * badge itself needs a signed-in account that owns an alert.
 *
 *   node scripts/qa/phase2-live-qa.mjs --flag events
 *   node scripts/qa/phase2-live-qa.mjs --flag market-snapshot
 *   node scripts/qa/phase2-live-qa.mjs --flag what-changed
 *   node scripts/qa/phase2-live-qa.mjs --flag alerts
 *   node scripts/qa/phase2-live-qa.mjs --flag baseline    # FIRST, before any flag
 *
 * Or through npm:
 *
 *   npm run verify:phase2-live -- --flag events
 */

import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PHASE2_FLAGS } from '../../src/config/phase2-flag-manifest.mjs';

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
 * What each flag is answerable for, DERIVED from the manifest.
 *
 * The table used to live here. That is how the `PHASE2_EVENTS` prerequisite came
 * to be missing from this file while being missing from the doc as well — two
 * copies, both wrong, neither able to notice. `src/config/phase2-flag-manifest.mjs`
 * is the only copy now, and `phase2-flag-manifest.test.ts` fails if this file
 * stops importing it.
 *
 * `forbid` is still assembled here, because it is a property of the RUN rather
 * than of a flag: it is every other flag's markers, so a step that moved more
 * than one switch is caught.
 */
const marker = (name) => [name, `[data-testid="${name}"]`];
const allMarkers = PHASE2_FLAGS.flatMap((entry) => entry.markers);

const FLAGS = {
  baseline: {
    env: '(none — every flag off)',
    requires: [],
    requiresAuth: false,
    expect: [],
    forbid: allMarkers.map(marker),
    note: 'Run this FIRST, before any flag is on. It records the production '
      + 'median as the baseline every later run is gated against, and confirms '
      + 'the starting point has none of the Phase 2 markers.',
  },
  ...Object.fromEntries(PHASE2_FLAGS.map((entry) => [entry.flag, {
    env: entry.env,
    requires: entry.requires,
    requiresAuth: entry.requiresAuth,
    unreachable: entry.unreachable,
    /*
      An UNREACHABLE flag expects nothing and forbids everything, its own marker
      included. Its section key is in no order array, so the page cannot emit it
      whatever is switched on — and a run that expected the marker anyway would
      fail every time and teach the operator to ignore a red.
    */
    expect: entry.unreachable ? [] : entry.markers.map(marker),
    /*
      Every marker that is not this flag's. Seeing one means a switch this step
      did not intend to move has moved. For an unreachable flag that is ALL of
      them: its own marker appearing would mean the section came back.
    */
    forbid: (entry.unreachable
      ? allMarkers
      : allMarkers.filter((name) => !entry.markers.includes(name))).map(marker),
    note: entry.note,
    checkHits: entry.env === 'PHASE2_ALERTS',
  }])),
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

/**
 * Why a marker might be missing for a reason that is not a bug.
 *
 * Read from the manifest, so this can never be the thing that is out of date —
 * which is what the missing `OVERVIEW_V2` prerequisite was.
 */
function diagnosis() {
  const reasons = [];
  if (SPEC.unreachable) {
    reasons.push(`${SPEC.env} cannot draw anything at all — ${SPEC.unreachable}`);
  }
  if (SPEC.requires.length > 0) {
    reasons.push(
      `${SPEC.env} is unreachable unless ${SPEC.requires.join(' and ')} is also true `
      + `(its section is absent from the V1 order array — see section-order.ts)`,
    );
  }
  if (SPEC.requiresAuth) {
    reasons.push(
      `${SPEC.env} draws nothing for a signed-out reader, and this check is signed out`,
    );
  }
  return reasons.length === 0 ? '' : `\n       ${reasons.join('\n       ')}`;
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

async function main() {
  const baseline = readBaseline();
  console.log(`Flag     : ${FLAG}  (${SPEC.env})`);
  if (SPEC.requires.length > 0) {
    console.log(`Requires : ${SPEC.requires.join(', ')}  <- must ALSO be true, or nothing renders`);
  }
  if (SPEC.requiresAuth) {
    console.log('Signed in: REQUIRED to see this flag — the check below runs signed out');
  }
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
    /*
      A SIGNED-OUT RUN CANNOT JUDGE AN AUTH-GATED FLAG, SO IT DOES NOT TRY.

      `overview-changes` is absent both when PHASE2_WHAT_CHANGED is off and when
      the reader has no session — this browser has none. Reporting FAIL would be
      asserting something this run has no evidence for, so it is reported as not
      verified and handed to a person to look at signed in.
    */
    if (SPEC.requiresAuth && SPEC.expect.length > 0) {
      for (const [name] of SPEC.expect) {
        console.log(`  --   ${name} not checked — needs a signed-in reader`);
      }
      unverified.push(
        `${SPEC.env} was not verified: its markers only render for a signed-in `
        + 'reader and this check is signed out. Confirm it by eye while logged in.',
      );
    }
    for (const [name, selector] of (SPEC.requiresAuth ? [] : SPEC.expect)) {
      const count = await page.locator(selector).count();
      /*
        A MISSING MARKER IS A SYMPTOM, AND THE OLD VERSION REPORTED ONLY THAT.

        "overview-events found 0" was true and useless: the flag was set, the
        deploy was live, the selector was right, and the section was unreachable
        because `'events'` is not in `OVERVIEW_ORDER_V1`. The reader was left to
        find that themselves.

        So a failure now says what else has to be true. The prerequisites come
        from the manifest, which is checked against the real order arrays by
        `phase2-flag-manifest.test.ts`.
      */
      check(`${name} is present`, count > 0, count > 0 ? '' : `found 0${diagnosis()}`);
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
    /*
      THERE IS NO LONGER A TABLE TO COUNT.

      This used to count rows in `overview_alert_hits` after a pg_cron tick,
      because `PHASE2_ALERTS` gated a second alert sweep that wrote them.
      `202609200001` merged that system into `price_alerts`, and what the flag
      gates now is ONE RENDER: the count badge on a watchlist row.

      Alert delivery is no longer flag-dependent at all — the sweep fires every
      fifteen minutes with the flag off, as it always has, and its evidence is a
      `notifications` row for the reader who owns the alert. That is per reader
      and behind RLS, so an anonymous script cannot see it and must not pretend
      to: this now says what it did not check instead of counting a table that
      would answer PGRST205.
    */
    console.log('\nalert count badge');
    console.log('  the flag gates a per-reader badge; signed out it changes nothing.');
    unverified.push(
      'PHASE2_ALERTS was not verified: the badge is per reader and behind RLS, '
      + 'so it needs a signed-in check with an account that owns an alert. '
      + 'Alert DELIVERY is not gated by this flag and is verified by the '
      + 'notifications row the sweep writes.',
    );
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
