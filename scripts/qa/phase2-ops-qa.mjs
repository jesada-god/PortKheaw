/**
 * Phase 2 — reliability console, product analytics and progressive onboarding.
 *
 * Three claims that no unit test can make, each proved against a real session
 * and a real database:
 *
 *   - an operator reaches the reliability console and a paying reader does not,
 *     judged on the HTML the SERVER sent to their session rather than on what
 *     the browser chose to render;
 *   - the onboarding question is asked once, survives a reload as answered, and
 *     never comes back — on a second browser as well as the first, because the
 *     answer lives on the account;
 *   - the events that land in the funnel are the ones the product meant to
 *     record, exactly once each, carrying no symbol, name, value or mailbox.
 */
import { chromium } from 'playwright-core';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { assertQaTarget, createQaAccounts, qaOwner } from './qa-accounts.mjs';

const BASE_URL = (process.env.QA_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const BROWSER = process.env.QA_BROWSER_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OUT_DIR = '.qa/artifacts/phase2-ops';
const THEME_STORAGE_KEY = 'portkheaw-theme-preferences';
if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Missing Supabase QA environment');

/*
 * This script creates a real reader, so it may not run against production.
 * See `scripts/qa/qa-accounts.mjs` for why the guard and the teardown are one
 * module rather than a pattern nine scripts copy.
 */
assertQaTarget(SUPABASE_URL, 'qa:phase2-ops');
const qaAccounts = createQaAccounts({ url: SUPABASE_URL, serviceKey: SERVICE_KEY, label: 'qa:phase2-ops' });
mkdirSync(OUT_DIR, { recursive: true });

const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900, mobile: false },
  { name: '390x844', width: 390, height: 844, mobile: true },
];

const report = {
  baseUrl: BASE_URL,
  startedAt: new Date().toISOString(),
  adminAccess: [],
  reliability: [],
  onboarding: [],
  analytics: [],
  layout: [],
  failures: [],
};

function check(condition, message, details = null) {
  if (!condition) report.failures.push({ message, details });
  return Boolean(condition);
}

const ENVIRONMENTAL_CONSOLE = /market-ws|ws:\/\/localhost:8081|ERR_CONNECTION_REFUSED|Failed to load resource/;
const appErrors = (errors) => errors.filter((line) => !ENVIRONMENTAL_CONSOLE.test(line));

async function supabase(path, init = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`Supabase QA ${response.status} ${path}: ${text.slice(0, 300)}`);
  return body;
}

async function createQaUser({ tier, admin = false }) {
  const email = `phase2.ops.qa.${admin ? 'admin' : tier}.${Date.now()}@example.com`;
  const password = `Qa!${randomUUID()}Aa7`;
  const created = await supabase('/auth/v1/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: 'Phase2 Ops QA', qa_owner: qaOwner('phase2-ops-qa') } }),
  });
  const userId = created.id;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const rows = await supabase(`/rest/v1/user_subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=user_id`);
    if (Array.isArray(rows) && rows.length === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const now = Date.now();
  await supabase(`/rest/v1/user_subscriptions?user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      tier, status: tier === 'basic' ? 'basic' : 'active',
      billing_provider: 'stripe', billing_provider_mode: 'test',
      trial_started_at: null, trial_ends_at: null, trial_used_at: null,
      current_period_start: new Date(now - 60_000).toISOString(),
      current_period_end: new Date(now + 30 * 86_400_000).toISOString(),
      cancel_at_period_end: false,
    }),
  });
  if (admin) {
    await supabase('/rest/v1/user_roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ user_id: userId, role: 'admin' }),
    });
  }
  return qaAccounts.register({ userId, email, password, tier, admin });
}

async function signIn(page, user, next, attempt = 0) {
  await page.goto(`${BASE_URL}/auth/sign-in?next=${encodeURIComponent(next)}&qa=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.fill('input[name="email"]', user.email);
  await page.fill('input[name="password"]', user.password);
  try {
    await Promise.all([
      page.waitForURL((url) => !url.pathname.startsWith('/auth/sign-in'), { timeout: 45_000, waitUntil: 'commit' }),
      page.locator('form button[type="submit"]').click(),
    ]);
  } catch (error) {
    if (attempt >= 2) throw error;
    await page.waitForTimeout(3_000);
    return signIn(page, user, next, attempt + 1);
  }
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => undefined);
  return undefined;
}

async function dismissOverlays(page) {
  let clean = 0;
  for (let attempt = 0; attempt < 12 && clean < 2; attempt += 1) {
    if (await page.locator('[data-testid="modal-backdrop"]').count() === 0) {
      clean += 1;
      await page.waitForTimeout(300);
      continue;
    }
    clean = 0;
    await page.locator('[aria-label="ปิดหน้าต่าง"]').first().click({ timeout: 5_000 }).catch(() => undefined);
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.waitForTimeout(500);
  }
}

const OVERFLOW_PROBE = `(() => {
  const doc = document.documentElement;
  const viewport = doc.clientWidth;
  const offenders = [];
  const inScroller = (element) => {
    for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
      const overflowX = getComputedStyle(node).overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll') return true;
    }
    return false;
  };
  for (const element of document.querySelectorAll('body *')) {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) continue;
    if (inScroller(element)) continue;
    const spills = rect.right > viewport + 1 || rect.left < -1;
    const clipped = element.scrollWidth > element.clientWidth + 1
      && ['visible', 'clip', 'hidden'].includes(style.overflowX);
    if (!spills && !clipped) continue;
    if (element.closest('.dock')) continue;
    if (style.pointerEvents === 'none' && !(element.textContent || '').trim() && style.position === 'absolute') continue;
    if (clipped && !spills) {
      const clientRight = rect.left + element.clientWidth;
      const cutsText = [...element.querySelectorAll('*')].some((child) => {
        if (!(child.textContent || '').trim()) return false;
        if (getComputedStyle(child).position === 'absolute') return false;
        if (inScroller(child)) return false;
        if (['auto', 'scroll'].includes(getComputedStyle(child).overflowX)) return false;
        return child.getBoundingClientRect().right > clientRight + 1;
      });
      if (!cutsText) continue;
    }
    offenders.push({
      tag: element.tagName.toLowerCase(),
      testId: element.getAttribute('data-testid'),
      className: (element.getAttribute('class') || '').slice(0, 140),
      right: Math.round(rect.right),
      viewport,
    });
    if (offenders.length >= 6) break;
  }
  return offenders;
})()`;

/** Every funnel row this account produced, newest first. */
async function funnelRows(userId) {
  return supabase(`/rest/v1/beta_funnel_events?user_id=eq.${encodeURIComponent(userId)}&select=event_key,feature_key,plan_key,payment_rail,local_date,dedupe_key&order=id.asc`);
}

async function onboardingRow(userId) {
  const rows = await supabase(`/rest/v1/user_settings?user_id=eq.${encodeURIComponent(userId)}&select=onboarding_path,onboarding_chosen_at,onboarding_dismissed_at,onboarding_hint_done_at`);
  return rows?.[0] ?? null;
}

/* ------------------------------------------------------- the second factor */

/**
 * A TOTP code, computed the way an authenticator app would.
 *
 * The operator console requires a second factor, so a QA run that skips it
 * proves nothing about the console — it only proves the assurance gate works,
 * which is a different test. Implemented here rather than pulled in as a
 * dependency: RFC 6238 is HMAC-SHA1 over a counter, and this is the whole of it.
 */
function base32Decode(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = secret.replace(/=+$/, '').toUpperCase().replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const character of cleaned) {
    const index = alphabet.indexOf(character);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function totp(secret, atMs = Date.now()) {
  const counter = Math.floor(atMs / 1000 / 30);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

/**
 * Enrols the operator's first factor through the product's own screen, exactly
 * as a new administrator would: begin enrolment, read the secret the page shows
 * for manual transcription, and present the code it implies.
 */
async function enrolSecondFactor(page) {
  await page.goto(`${BASE_URL}/admin/security`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await dismissOverlays(page);
  await page.getByRole('button', { name: 'เริ่มตั้งค่า' }).click({ timeout: 30_000 });
  const secret = (await page.locator('code').first().textContent({ timeout: 30_000 }) ?? '').trim();
  if (!secret) throw new Error('The enrolment screen showed no transcribable secret');
  /*
   * A code is valid for a 30-second step, and one computed in the last moments
   * of a step can expire in flight. Waiting for the next boundary when the
   * current step is nearly over removes that flake without weakening anything.
   */
  const msIntoStep = Date.now() % 30_000;
  if (msIntoStep > 24_000) await page.waitForTimeout(30_000 - msIntoStep + 500);
  await page.locator('input[aria-label="รหัสยืนยัน 6 หลัก"]').fill(totp(secret));
  await page.getByRole('button', { name: 'ยืนยันและเปิดใช้งาน' }).click();
  await page.waitForTimeout(4_000);
  return secret;
}

/* ------------------------------------------------------------------ admin */

async function adminAccessChecks(browser, admin, reader) {
  for (const user of [admin, reader]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    try {
      await signIn(page, user, '/');
      await dismissOverlays(page);
      /*
       * The console requires a second factor of an operator, so one is enrolled
       * through the product's own screen before the console is asked for. A
       * non-operator is deliberately NOT taken through this: they must be
       * refused for who they are, not for what they have not set up.
       */
      if (user.admin) {
        const secret = await enrolSecondFactor(page);
        report.adminAccess.push({ step: 'second-factor-enrolled', enrolled: Boolean(secret) });
        check(Boolean(secret), 'the operator could not enrol a second factor');
      }
      const response = await page.goto(`${BASE_URL}/admin/reliability`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      await page.waitForTimeout(1_500);
      const status = response?.status() ?? 0;
      const html = await page.content();
      const rows = await page.locator('[data-testid^="reliability-row-"]').count();
      const record = { tier: user.tier, admin: user.admin, status, rows, url: page.url() };
      report.adminAccess.push(record);

      if (user.admin) {
        check(rows >= 5, 'an operator did not receive the reliability rows', record);
        check(status === 200, 'the reliability console did not answer 200 for an operator', record);
        const levels = await page.locator('[data-testid^="reliability-row-"]').evaluateAll((nodes) =>
          nodes.map((node) => ({ id: node.getAttribute('data-testid'), level: node.getAttribute('data-level') })));
        report.reliability.push({ levels, overall: await page.locator('[data-testid="reliability-overall"]').getAttribute('data-level') });
        /*
         * The whole point of the console is that it can hold no secret. Asserted
         * against the served HTML, not the rendered text, so a value hidden in
         * an attribute or a payload would still be caught.
         */
        const leaks = ['SUPABASE_SERVICE_ROLE', 'sk_live', 'sk_test', 'whsec_', 'POLYGON_API_KEY', 'apikey=', 'eyJhbGciOiJIUzI1NiIs']
          .filter((needle) => html.includes(needle));
        check(leaks.length === 0, 'the reliability console exposed something secret', leaks);
        check(appErrors(errors).length === 0, 'console errors on the reliability page', appErrors(errors));

        for (const viewport of VIEWPORTS) {
          for (const appearance of ['dark', 'light']) {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            await page.evaluate(([key, value]) => {
              window.localStorage.setItem(key, JSON.stringify({ state: { appearance: value }, version: 0 }));
            }, [THEME_STORAGE_KEY, appearance]);
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(800);
            const overflow = await page.evaluate(OVERFLOW_PROBE);
            report.layout.push({ surface: 'admin-reliability', viewport: viewport.name, appearance, overflow });
            check(overflow.length === 0, `overflow on the reliability console at ${viewport.name} (${appearance})`, overflow);
            await page.screenshot({ path: `${OUT_DIR}/reliability-${viewport.name}-${appearance}.png` });
          }
        }
      } else {
        /*
         * A non-operator must get NO console markup — not markup that is thrown
         * away after the fact. The guard runs inside the page, so the served
         * HTML carries the not-found screen and none of the report.
         */
        check(rows === 0, 'a non-operator received reliability rows', record);
        check(!html.includes('reliability-overall'), 'a non-operator received the console markup', record);
        check(!html.includes('ความพร้อมของระบบ'), 'a non-operator was told the console exists', record);
      }
    } finally {
      await context.close();
    }
  }
}

/* ------------------------------------------------------------ onboarding */

async function onboardingChecks(browser, user) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await signIn(page, user, '/');
    await dismissOverlays(page);

    // 1. First login asks, once.
    await page.locator('[data-testid="onboarding-question"]').waitFor({ timeout: 30_000 });
    const overflow = await page.evaluate(OVERFLOW_PROBE);
    check(overflow.length === 0, 'overflow on the onboarding question at 390x844', overflow);
    await page.screenshot({ path: `${OUT_DIR}/onboarding-question-390x844.png` });
    report.onboarding.push({ step: 'asked-on-first-login', present: true });

    // 2. Choosing sends the reader into an existing flow and persists the answer.
    await page.locator('[data-testid="onboarding-choice-portfolio"]').click();
    await page.waitForURL((url) => url.pathname === '/portfolio', { timeout: 30_000 }).catch(() => undefined);
    const landedOnPortfolio = page.url().includes('/portfolio');
    check(landedOnPortfolio, 'choosing a path did not open the flow it names', page.url());
    await page.waitForTimeout(1_500);
    const afterChoice = await onboardingRow(user.userId);
    report.onboarding.push({ step: 'chosen', stored: afterChoice, landedOnPortfolio });
    check(afterChoice?.onboarding_path === 'portfolio', 'the chosen path was not stored on the account', afterChoice);

    // 3. Reload: the question is gone and the one hint has taken its place.
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await dismissOverlays(page);
    await page.waitForTimeout(1_500);
    const questionAfterReload = await page.locator('[data-testid="onboarding-question"]').count();
    const hint = await page.locator('[data-testid="onboarding-hint"]').count();
    report.onboarding.push({ step: 'after-reload', question: questionAfterReload, hint });
    check(questionAfterReload === 0, 'the onboarding question came back after a reload');
    check(hint === 1, 'the contextual hint did not follow the chosen path', { hint });

    // 4. Dismissing the hint finishes onboarding permanently.
    await page.locator('[data-testid="onboarding-hint-dismiss"]').click();
    await page.waitForTimeout(2_000);
    const afterDismiss = await onboardingRow(user.userId);
    check(Boolean(afterDismiss?.onboarding_hint_done_at), 'dismissing the hint did not persist', afterDismiss);
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await dismissOverlays(page);
    await page.waitForTimeout(1_500);
    const anythingLeft = await page.locator('[data-testid="onboarding-question"], [data-testid="onboarding-hint"]').count();
    report.onboarding.push({ step: 'after-dismiss', stored: afterDismiss, remaining: anythingLeft });
    check(anythingLeft === 0, 'onboarding reappeared after being finished');
  } finally {
    await context.close();
  }

  /*
   * A second browser, with none of the first one's storage. The answer lives on
   * the account, so a reader who onboarded on their phone is not asked again on
   * their laptop — which a localStorage flag could never deliver.
   */
  const fresh = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const freshPage = await fresh.newPage();
  try {
    await signIn(freshPage, user, '/');
    await dismissOverlays(freshPage);
    await freshPage.waitForTimeout(1_500);
    const shown = await freshPage.locator('[data-testid="onboarding-question"], [data-testid="onboarding-hint"]').count();
    report.onboarding.push({ step: 'second-browser', remaining: shown });
    check(shown === 0, 'a second browser asked an already-onboarded reader again');
  } finally {
    await fresh.close();
  }
}

/* -------------------------------------------------------------- analytics */

async function analyticsChecks(browser, user) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await signIn(page, user, '/');
    await dismissOverlays(page);
    // Each surface visited TWICE, because the claim under test is "once".
    for (const round of [1, 2]) {
      for (const path of ['/portfolio', '/watchlist', '/stock/AAPL', '/tools/what-if']) {
        await page.goto(`${BASE_URL}${path}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
        await dismissOverlays(page);
        await page.waitForTimeout(round === 1 ? 1_200 : 600);
      }
    }
    await page.waitForTimeout(2_000);

    const rows = await funnelRows(user.userId);
    const counts = rows.reduce((tally, row) => {
      const key = `${row.event_key}:${row.feature_key ?? ''}`;
      tally[key] = (tally[key] ?? 0) + 1;
      return tally;
    }, {});
    report.analytics.push({ rows, counts });

    for (const [key, count] of Object.entries(counts)) {
      check(count === 1, `event ${key} landed ${count} times instead of once`, counts);
    }
    for (const expected of ['feature_used:portfolio', 'feature_used:watchlist', 'stock_detail_viewed:', 'tool_opened:what-if']) {
      check(counts[expected] === 1, `expected event ${expected} was not recorded exactly once`, counts);
    }

    /*
     * What must never be in the table. The symbol is the important one: the
     * product deliberately records that Stock Detail was read, never which
     * stock — and this is the assertion that keeps it that way.
     *
     * The ACCOUNT id is a different matter and is deliberately not banned. It is
     * the funnel's one identifier: a column on the row, and a component of the
     * dedupe key so that one reader's event can never collide with another's.
     * It is cleared when the account is deleted. What is asserted instead is
     * that it stays in those two places and never leaks into a payload field.
     */
    const serialized = JSON.stringify(rows);
    for (const banned of ['AAPL', user.email, '@example.com']) {
      check(!serialized.includes(banned), `a funnel row carried something it must not: ${banned}`, serialized.slice(0, 400));
    }
    const payloadLeak = rows.filter((row) =>
      [row.feature_key, row.plan_key, row.payment_rail].some((field) => field?.includes(user.userId)));
    check(payloadLeak.length === 0, 'the account id leaked into a funnel payload field', payloadLeak);
    const freeText = rows.filter((row) => row.feature_key && !/^[a-z0-9._:-]+$/i.test(row.feature_key));
    check(freeText.length === 0, 'a funnel row carried free text in its feature key', freeText);
  } finally {
    await context.close();
  }
}

async function run() {
  const [admin, reader, onboardingUser, analyticsUser] = await Promise.all([
    createQaUser({ tier: 'elite', admin: true }),
    createQaUser({ tier: 'elite' }),
    createQaUser({ tier: 'pro' }),
    createQaUser({ tier: 'pro' }),
  ]);
  report.accounts = [admin, reader, onboardingUser, analyticsUser]
    .map((user) => ({ userId: user.userId, tier: user.tier, admin: Boolean(user.admin) }));

  const browser = await chromium.launch({ executablePath: BROWSER, headless: true });
  try {
    await adminAccessChecks(browser, admin, reader);
    await onboardingChecks(browser, onboardingUser);
    await analyticsChecks(browser, analyticsUser);
  } finally {
    await browser.close();
    /*
      Nothing here removed a reader before, and this script makes several. The
      registry knows every one because `createQaUser` registers them, not the
      call sites — which is the difference between sweeping the accounts and
      sweeping the ones somebody remembered.
    */
    report.teardown = await qaAccounts.teardown();
    if (report.teardown.remaining?.length || report.teardown.failed?.length) {
      report.failures.push(`teardown left ${report.teardown.remaining.length} account(s) behind`);
    }
    report.finishedAt = new Date().toISOString();
    writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      failures: report.failures,
      adminAccess: report.adminAccess,
      reliability: report.reliability,
      onboarding: report.onboarding,
      analyticsCounts: report.analytics[0]?.counts ?? null,
    }, null, 2));
  }
  if (report.failures.length > 0) process.exitCode = 1;
}

await run();
