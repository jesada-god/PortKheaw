/**
 * The operator overview, after the readability pass — one QA run.
 *
 * The change was to what an operator *reads*, so the things worth proving are
 * the ones a unit test cannot see: that exactly one card on the page carries the
 * accent surface, that the four bands are visibly separated at a handset width,
 * and — the risk of any "show less" edit — that no figure was deleted on the way
 * to a shorter page. Every number that used to have a card still has to be
 * reachable, which is checked by opening each band's disclosure and reading it.
 *
 * Point it at an origin that serves the commit under test:
 *
 *   QA_BASE_URL=http://127.0.0.1:3210 npm run qa:admin-overview
 *
 * Not at production. `admin-console-challenge` is published on the project —
 * every `/admin` request is answered with a Vercel challenge, and an automated
 * browser cannot solve one: the console never renders and the run would report
 * nothing about the page. That rule is the point of the rule, so the way to
 * exercise the console is `npm run build && npm run start` on the same commit
 * and this run against that. What production itself proves after a deploy is
 * `/api/version` matching HEAD and `/admin` still answering a challenge rather
 * than a page.
 *
 * `QA_HEADED=1` launches a visible Chrome, for a desktop session where somebody
 * wants to watch it.
 */
import { chromium } from 'playwright-core';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { assertQaTarget, createQaAccounts } from './qa-accounts.mjs';

const BASE_URL = (process.env.QA_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const BROWSER = process.env.QA_BROWSER_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OUT_DIR = '.qa/artifacts/admin-overview';
const THEME_STORAGE_KEY = 'portkheaw-theme-preferences';
if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Missing Supabase QA environment');

/*
 * This script creates a real reader, so it may not run against production.
 * See `scripts/qa/qa-accounts.mjs` for why the guard and the teardown are one
 * module rather than a pattern nine scripts copy.
 */
assertQaTarget(SUPABASE_URL, 'qa:admin-overview');
const qaAccounts = createQaAccounts({ url: SUPABASE_URL, serviceKey: SERVICE_KEY, label: 'qa:admin-overview' });
mkdirSync(OUT_DIR, { recursive: true });

const VIEWPORTS = [
  { name: 'desktop-1440x900', width: 1440, height: 900, mobile: false },
  { name: 'mobile-390x844', width: 390, height: 844, mobile: true },
];

/** The four bands, in the order the page must present them. */
const GROUPS = ['ตอนนี้', 'ช่วงที่ผ่านมา (7 วันล่าสุด)', 'รายได้', 'ระบบ'];

/**
 * Every figure the old six-card revenue band and three-card movement band
 * carried. Nothing here may disappear, whether it stayed a card or moved into a
 * disclosure.
 */
const FIGURES_THAT_MUST_SURVIVE = [
  'ผู้ใช้งานทั้งหมด', 'กำลังทดลองใช้', 'Basic', 'Pro', 'Elite',
  'สมาชิกใหม่ 7 วัน', 'สมาชิกใหม่วันนี้', 'สมาชิกใหม่ 30 วัน',
  'เริ่ม Trial 7 วัน', 'เปลี่ยนเป็นแพ็กเกจเสียเงิน 7 วัน',
  'รายได้', 'รายได้ช่วงที่เลือก', 'คืนเงินช่วงที่เลือก', 'ค้างชำระ (Past due)',
  'PromptPay รอชำระ',
  'Webhook ที่ยังลองใหม่อยู่', 'Webhook ล้มเหลวถาวร', 'รายการที่ยังไม่กระทบยอด', 'ระดับวิกฤต',
];

const ENVIRONMENTAL_CONSOLE = /market-ws|ws:\/\/|ERR_CONNECTION_REFUSED|Failed to load resource|favicon/;

const report = { baseUrl: BASE_URL, startedAt: new Date().toISOString(), checks: [], failures: [] };

function check(condition, message, details = null) {
  report.checks.push({ message, ok: Boolean(condition), details });
  if (!condition) report.failures.push({ message, details });
  return Boolean(condition);
}

/* --------------------------------------------------------------- fixtures */

async function supabase(path, init = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase QA ${response.status} ${path}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function createOperator() {
  const email = `admin.overview.qa.${Date.now()}@example.com`;
  const password = `Qa!${randomUUID()}Aa7`;
  const created = await supabase('/auth/v1/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email, password, email_confirm: true,
      user_metadata: { full_name: 'Admin Overview QA', qa_owner: 'admin-overview-qa' },
    }),
  });
  const userId = created.id;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const rows = await supabase(`/rest/v1/user_subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=user_id`);
    if (Array.isArray(rows) && rows.length === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  /*
   * A settled paid subscription, so nothing about *billing* stands between the
   * operator and the console. The overview is an operator surface, not a plan
   * feature; a QA account still sitting on the free tier would be answering a
   * question this run is not asking.
   */
  const now = Date.now();
  await supabase(`/rest/v1/user_subscriptions?user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      tier: 'elite', status: 'active',
      billing_provider: 'stripe', billing_provider_mode: 'test',
      trial_started_at: null, trial_ends_at: null, trial_used_at: null,
      current_period_start: new Date(now - 60_000).toISOString(),
      current_period_end: new Date(now + 30 * 86_400_000).toISOString(),
      cancel_at_period_end: false,
    }),
  });
  await supabase('/rest/v1/user_roles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ user_id: userId, role: 'admin' }),
  });
  return qaAccounts.register({ userId, email, password });
}

/* ------------------------------------------------------- the second factor */

/** RFC 6238, the whole of it — the console refuses an operator without one. */
function base32Decode(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const character of secret.replace(/=+$/, '').toUpperCase().replace(/\s+/g, '')) {
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

async function signIn(page, user, next, attempt = 0) {
  await page.goto(`${BASE_URL}/auth/sign-in?next=${encodeURIComponent(next)}&qa=${Date.now()}`, {
    waitUntil: 'domcontentloaded', timeout: 60_000,
  });
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

async function enrolSecondFactor(page) {
  await page.goto(`${BASE_URL}/admin/security`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await dismissOverlays(page);
  try {
    await page.getByRole('button', { name: 'เริ่มตั้งค่า' }).click({ timeout: 45_000 });
  } catch (error) {
    // Whatever stood in the way is worth seeing, not guessing at.
    await page.screenshot({ path: `${OUT_DIR}/enrolment-blocked.png`, fullPage: true });
    console.error(`enrolment blocked at ${page.url()}`);
    throw error;
  }
  const secret = (await page.locator('code').first().textContent({ timeout: 30_000 }) ?? '').trim();
  if (!secret) throw new Error('The enrolment screen showed no transcribable secret');
  const msIntoStep = Date.now() % 30_000;
  if (msIntoStep > 24_000) await page.waitForTimeout(30_000 - msIntoStep + 500);
  await page.locator('input[aria-label="รหัสยืนยัน 6 หลัก"]').fill(totp(secret));
  await page.getByRole('button', { name: 'ยืนยันและเปิดใช้งาน' }).click();
  await page.waitForTimeout(4_000);
  return secret;
}

/* ------------------------------------------------------------------ probes */

const OVERFLOW_PROBE = `(() => {
  const viewport = document.documentElement.clientWidth;
  const offenders = [];
  const inScroller = (element) => {
    for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
      const overflowX = getComputedStyle(node).overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll') return true;
    }
    return false;
  };
  for (const element of document.querySelectorAll('main *')) {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) continue;
    if (inScroller(element)) continue;
    if (rect.right <= viewport + 1 && rect.left >= -1) continue;
    offenders.push({
      tag: element.tagName.toLowerCase(),
      className: (element.getAttribute('class') || '').slice(0, 140),
      right: Math.round(rect.right),
      viewport,
    });
    if (offenders.length >= 6) break;
  }
  return offenders;
})()`;

/**
 * A band, located by its own heading rather than by a hook added for the test.
 *
 * The `>` matters: every band is nested inside the "ภาพรวม" section, so a
 * descendant match resolves to that wrapper and reports the whole page's cards
 * as one band's.
 */
const band = (page, title) => page.locator(`section:has(> h3:text-is(${JSON.stringify(title)}))`);

async function auditOverview(page, viewport, appearance) {
  const at = (message) => `[${viewport.name}/${appearance}] ${message}`;

  // 1 — the four bands, in order, each a real heading under the section's h2.
  const headings = await page.locator('main h3').allTextContents();
  check(
    GROUPS.every((title, index) => headings[index]?.trim() === title),
    at('the four bands appear in order'),
    { headings },
  );

  // 2 — exactly one accent card on the whole page, and it is the total.
  const accentCards = page.locator('main [class*="accent-soft"]').filter({ hasNot: page.locator('svg') });
  const accentTexts = await accentCards.allTextContents();
  const heroCards = accentTexts.filter((text) => /ผู้ใช้งานทั้งหมด|รายได้|สมาชิกใหม่/.test(text));
  check(heroCards.length === 1, at('exactly one figure carries the accent surface'), { accentTexts });
  check(
    heroCards[0]?.includes('ผู้ใช้งานทั้งหมด'),
    at('the accent belongs to ผู้ใช้งานทั้งหมด'),
    { hero: heroCards[0] },
  );

  // 3 — the long "ตอนนี้" paragraph is now one line, with the rest behind help.
  const now = band(page, 'ตอนนี้');
  const nowText = (await now.textContent()) ?? '';
  check(
    nowText.includes('สถานะปัจจุบัน ไม่เปลี่ยนตามช่วงเวลาที่เลือก'),
    at('ตอนนี้ carries the short note'),
  );
  check(
    !nowText.includes('ไม่ถูกนับซ้ำใน Elite') || await now.locator('details').count() === 1,
    at('the trial/Elite explanation sits inside a disclosure'),
  );

  // 4 — the seven-day card says what it counts and nothing else.
  const newMembers = page.locator('main div', { hasText: /^สมาชิกใหม่ 7 วัน/ }).last();
  const newMembersText = (await newMembers.textContent()) ?? '';
  check(
    newMembersText.includes('บัญชีที่สมัครใน 7 วันที่ผ่านมา'),
    at('สมาชิกใหม่ 7 วัน states what it counts'),
    { newMembersText },
  );
  check(
    !/วันนี้:|30 วัน:/.test(newMembersText),
    at('the today/30-day line is off the สมาชิกใหม่ card'),
    { newMembersText },
  );

  // 5 — one revenue card, not six.
  const revenue = band(page, 'รายได้');
  const revenueCards = await revenue.locator('div[class*="rounded-2xl"][class*="border"]').count();
  check(revenueCards === 1, at('the revenue band shows one card'), { revenueCards });
  check(
    ((await revenue.locator('summary').textContent()) ?? '').includes('ช่วงที่เลือก · คืนเงิน · ค้างชำระ · PromptPay'),
    at('the revenue detail is summarised on one line'),
  );

  // 6 — every disclosure is reachable, and its summary is a real tap target.
  const summaries = page.locator('main details > summary');
  const summaryCount = await summaries.count();
  check(summaryCount >= 3, at('each band that hid detail offers a way to open it'), { summaryCount });
  for (let index = 0; index < summaryCount; index += 1) {
    const box = await summaries.nth(index).boundingBox();
    check(
      box !== null && box.height >= 44,
      at(`disclosure ${index + 1} has a ≥44px tap target`),
      box,
    );
  }

  // 7 — nothing was deleted. Open everything and read the page.
  await page.locator('main details').evaluateAll((nodes) => nodes.forEach((node) => { node.open = true; }));
  await page.waitForTimeout(200);
  // `.first()`: the console layout wraps the page's own `<main>` in one of its
  // own, which is a landmark question for another change, not this one.
  const openText = (await page.locator('main').first().textContent()) ?? '';
  const missing = FIGURES_THAT_MUST_SURVIVE.filter((label) => !openText.includes(label));
  check(missing.length === 0, at('every figure that had a card is still on the page'), { missing });
  await page.locator('main details').evaluateAll((nodes) => nodes.forEach((node) => { node.open = false; }));

  // 8 — the page fits its viewport in both themes.
  const overflow = await page.evaluate(OVERFLOW_PROBE);
  check(overflow.length === 0, at('no horizontal overflow'), overflow);

  await page.screenshot({ path: `${OUT_DIR}/${viewport.name}-${appearance}.png`, fullPage: true });
}

async function run() {
  const operator = await createOperator();
  report.account = { userId: operator.userId };
  const browser = await chromium.launch({
    executablePath: BROWSER,
    headless: process.env.QA_HEADED !== '1',
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !ENVIRONMENTAL_CONSOLE.test(message.text())) {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  try {
    await signIn(page, operator, '/');
    await dismissOverlays(page);
    await enrolSecondFactor(page);

    for (const viewport of VIEWPORTS) {
      for (const appearance of ['dark', 'light']) {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(`${BASE_URL}/admin`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
        await page.evaluate(([key, value]) => {
          window.localStorage.setItem(key, JSON.stringify({ state: { appearance: value }, version: 0 }));
        }, [THEME_STORAGE_KEY, appearance]);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_200);
        await dismissOverlays(page);
        check(
          await page.locator('main h3:text-is("ตอนนี้")').count() === 1,
          `[${viewport.name}/${appearance}] the operator reached the overview`,
        );
        await auditOverview(page, viewport, appearance);
      }
    }
    check(consoleErrors.length === 0, 'no console errors on the overview', consoleErrors);
  } finally {
    await context.close();
    await browser.close();
    /*
      This script created a reader and never removed it, which is why six of its
      accounts were sitting in production. Teardown is in the `finally` so a red
      check cleans up too, and anything it cannot remove becomes a failure of
      the run rather than a line in a log nobody reads.
    */
    report.teardown = await qaAccounts.teardown();
    if (report.teardown.remaining?.length || report.teardown.failed?.length) {
      report.failures.push({ message: `teardown left ${report.teardown.remaining.length} account(s) behind`, details: report.teardown });
    }
    report.finishedAt = new Date().toISOString();
    writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(report, null, 2));
    for (const entry of report.checks) console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.message}`);
    console.log(`\n${report.checks.length - report.failures.length}/${report.checks.length} checks passed`);
    if (report.failures.length) console.error(JSON.stringify(report.failures, null, 2));
  }
  if (report.failures.length > 0) process.exitCode = 1;
}

await run();
