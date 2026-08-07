/**
 * Tools / Options Simulator — mobile overflow, sticky CTA, tier and Target Date QA.
 *
 * Four viewports, two tiers, one report. The overflow check does not trust
 * `document.scrollWidth` alone: the app shell clips with `overflow-x-hidden`, so
 * a row that runs off the screen is *cut off* rather than scrollable and the
 * document measurement stays clean. Every element is measured against the
 * viewport instead, which is what actually catches the bug.
 */
import { chromium } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE_URL = (process.env.QA_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const BROWSER = process.env.QA_BROWSER_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OUT_DIR = '.qa/artifacts/tools-simulator-mobile';
if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Missing Supabase QA environment');
mkdirSync(OUT_DIR, { recursive: true });

const VIEWPORTS = [
  { name: '430x932', width: 430, height: 932, mobile: true },
  { name: '390x844', width: 390, height: 844, mobile: true },
  { name: '320x720', width: 320, height: 720, mobile: true },
  { name: '1440x900', width: 1440, height: 900, mobile: false },
];

const EXPIRATION = '2026-08-21';
const VALUATION = '2026-08-04';
const TARGET_DATE_CASES = [
  { date: '2026-08-20', expect: 'accept' },
  { date: '2026-08-21', expect: 'accept' },
  { date: '2026-08-22', expect: 'reject' },
];

const report = {
  baseUrl: BASE_URL,
  startedAt: new Date().toISOString(),
  viewports: [],
  targetDateUi: [],
  targetDateApi: [],
  tierMatrix: [],
  savedSimulations: null,
  stickyCta: [],
  failures: [],
};

function check(condition, message, details = null) {
  if (!condition) report.failures.push({ message, details });
  return Boolean(condition);
}

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

async function createQaUser(tier) {
  const email = `tools.mobile.qa.${tier}.${Date.now()}@example.com`;
  const password = `Qa!${randomUUID()}Aa7`;
  const created = await supabase('/auth/v1/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: `Tools Mobile QA ${tier}`, qa_owner: 'tools-simulator-mobile-qa' } }),
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
      tier, status: 'active', trial_started_at: null, trial_ends_at: null, trial_used_at: null,
      current_period_start: new Date(now - 60_000).toISOString(),
      current_period_end: new Date(now + 30 * 86_400_000).toISOString(),
      cancel_at_period_end: false,
    }),
  });
  return { userId, email, password, tier };
}

/* Retried once: a cold first sign-in against a just-started server can outrun the wait. */
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

/*
  Everything the viewport cuts off, named well enough to find in the source.

  Four things are deliberately not that, and each is reported rather than
  silently dropped so a real regression cannot hide behind an exclusion:

  - a 1px clipped box is the `sr-only` / collapsed-label idiom, not a cut-off;
  - a descendant of a real horizontal scroller (the tab strip is
    `overflow-x-auto`) is reachable by swiping, which is the opposite of cut off;
  - a `pointer-events-none` box with no text is decoration — the tools card's
    corner blob is drawn oversized on purpose and clipped by the card's rounded
    corner, which is the design rather than a layout failure;
  - the floating dock owns its own fixed-slot geometry and its own contract
    test, and is not part of this page.
*/
const OVERFLOW_PROBE = `(() => {
  const doc = document.documentElement;
  const viewport = doc.clientWidth;
  const offenders = [];
  const scrollers = [];

  const inScroller = (element) => {
    for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
      const overflowX = getComputedStyle(node).overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll') {
        if (!scrollers.includes(node)) scrollers.push(node);
        return true;
      }
    }
    return false;
  };

  const outOfScope = [];
  const decorations = [];

  for (const element of document.querySelectorAll('body *')) {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (rect.width <= 1 || rect.height <= 1) continue;
    if (inScroller(element)) continue;

    const spills = rect.right > viewport + 1 || rect.left < -1;
    const clipped = element.scrollWidth > element.clientWidth + 1
      && ['visible', 'clip', 'hidden'].includes(style.overflowX);
    if (!spills && !clipped) continue;

    const label = {
      tag: element.tagName.toLowerCase(),
      testId: element.getAttribute('data-testid'),
      className: (element.getAttribute('class') || '').slice(0, 120),
      text: (element.textContent || '').trim().slice(0, 60),
      reason: spills ? 'outside-viewport' : 'clipped-content',
    };
    if (element.closest('.dock')) { outOfScope.push(label); continue; }
    const decorative = style.pointerEvents === 'none' && !(element.textContent || '').trim();
    if (decorative && style.position === 'absolute') { decorations.push(label); continue; }
    // A box only counts as clipping content if something with text is cut off.
    if (clipped && !spills) {
      const clientRight = element.getBoundingClientRect().left + element.clientWidth;
      const cutsText = [...element.querySelectorAll('*')].some((child) => {
        if (!(child.textContent || '').trim()) return false;
        if (getComputedStyle(child).position === 'absolute') return false;
        return child.getBoundingClientRect().right > clientRight + 1;
      });
      if (!cutsText) { decorations.push({ ...label, reason: 'clipped-decoration-only' }); continue; }
    }

    {
      offenders.push({
        tag: element.tagName.toLowerCase(),
        testId: element.getAttribute('data-testid'),
        className: (element.getAttribute('class') || '').slice(0, 160),
        text: (element.textContent || '').trim().slice(0, 70),
        left: Math.round(rect.left), right: Math.round(rect.right),
        scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
        ...label,
      });
    }
  }

  return {
    viewport,
    documentScrollWidth: doc.scrollWidth,
    documentClientWidth: doc.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    // Named so an unexpected new scroller cannot hide an overflow bug silently.
    intentionalScrollers: scrollers.map((node) => (node.getAttribute('class') || '').slice(0, 80)),
    outOfScope, decorations,
    offenders: offenders.slice(0, 25),
    offenderCount: offenders.length,
  };
})()`;

/** The sticky bar must sit clear of the dock, the last card, and the page end. */
const STICKY_PROBE = `(() => {
  const cta = document.querySelector('[data-testid="mobile-calculate-action"]');
  const dock = document.querySelector('.dock');
  const main = document.querySelector('main main') || document.querySelector('main');
  const last = main ? main.lastElementChild : null;
  const rect = (node) => node ? (({top,bottom,left,right,height}) => ({top:Math.round(top),bottom:Math.round(bottom),left:Math.round(left),right:Math.round(right),height:Math.round(height)}))(node.getBoundingClientRect()) : null;
  const shown = (node) => Boolean(node) && getComputedStyle(node).display !== 'none';
  return {
    hasCta: shown(cta),
    cta: rect(cta),
    dock: rect(dock),
    lastCard: rect(last),
    lastCardText: last ? (last.textContent || '').trim().slice(0, 40) : null,
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
    scrollY: window.scrollY,
  };
})()`;

/** What sits under a given point — the real test of "is this covered". */
const coveredBy = (selector) => `(() => {
  const target = document.querySelector(${JSON.stringify(selector)});
  if (!target) return { found: false };
  target.scrollIntoView({ block: 'center' });
  const rect = target.getBoundingClientRect();
  const x = Math.round(rect.left + rect.width / 2);
  const y = Math.round(rect.top + rect.height / 2);
  const top = document.elementFromPoint(x, y);
  return {
    found: true,
    reachable: Boolean(top) && (target.contains(top) || top.contains(target)),
    topTag: top ? top.tagName.toLowerCase() : null,
    topTestId: top ? top.getAttribute('data-testid') : null,
  };
})()`;

/*
  This run deliberately provokes 4xx responses — the Pro Monte Carlo refusal and
  the 22 Aug rejection — and Chrome logs every one of those as a console error.
  Counting them would make a correct gate look like a defect, so the harness
  raises a flag while it is causing them and only the app's own errors are
  asserted on.
*/
function collectConsole(page, sink) {
  const state = { expectingHttpFailure: false, httpFailures: [] };
  /*
    The simulator guards destructive steps with `confirm()` — discarding an
    unsaved draft, opening a saved simulation over one. Playwright dismisses
    dialogs by default, which makes those steps silently no-op and reads as a
    product bug; the harness answers yes, which is what the tester would.
  */
  page.on('dialog', (dialog) => { void dialog.accept(); });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text().slice(0, 300);
    if (state.expectingHttpFailure && /Failed to load resource/.test(text)) return;
    sink.push(text);
  });
  page.on('pageerror', (error) => sink.push(`pageerror @ ${page.url()}: ${String(error).slice(0, 300)}`));
  // Name the request behind every "Failed to load resource" so a 4xx is diagnosable.
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const line = `http ${response.status()} ${response.url().replace(/^https?:\/\/[^/]+/, '')}`;
    state.httpFailures.push(line);
    if (!state.expectingHttpFailure) sink.push(line);
  });
  return state;
}

async function scrollThroughPage(page) {
  await page.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.8);
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise((resolve) => setTimeout(resolve, 120));
  });
}

async function setupContract(page) {
  // Symbol
  const search = page.locator('[data-validation-path="symbol"]');
  await search.waitFor({ timeout: 30_000 });
  await page.waitForTimeout(900);
  await search.pressSequentially('AAPL', { delay: 40 });
  const option = page.locator('button').filter({ has: page.locator('strong', { hasText: 'AAPL' }) }).first();
  await option.waitFor({ timeout: 30_000 });
  await option.click();
  const spot = page.locator('[data-validation-path="underlyingPrice"]');
  await spot.fill('100');
  await spot.press('Tab');

  await page.getByRole('button', { name: 'ข้อมูลสัญญา', exact: true }).click();
  await page.locator('[data-testid="option-legs-form"]').waitFor({ timeout: 30_000 });

  const valuation = page.locator('input[aria-label="วันที่ใช้คำนวณ (Valuation Date)"]');
  await valuation.fill(VALUATION);
  await valuation.press('Tab');

  for (const [selector, value] of [
    ['[data-validation-path="legs.0.quantity"]', '1'],
    ['[data-validation-path="legs.0.strike"]', '100'],
  ]) {
    const field = page.locator(selector);
    await field.fill(value);
    await field.press('Tab');
  }
  const expiration = page.locator('[data-validation-path="legs.0.expiration"]');
  await expiration.fill(EXPIRATION);
  await expiration.press('Tab');

  const premium = page.locator('[data-validation-path="legs.0.entryPremium"]');
  await premium.focus();
  await premium.press('Control+A');
  await premium.press('Backspace');
  await premium.pressSequentially('500', { delay: 30 });
  await premium.press('Tab');

  for (const [selector, value] of [
    ['[data-validation-path="legs.0.impliedVolatility"]', '25'],
    ['[data-validation-path="legs.0.multiplier"]', '100'],
  ]) {
    const field = page.locator(selector);
    await field.fill(value);
    await field.press('Tab');
  }
}

/*
  Save a simulation whose Target Date is past its expiration, then open it.

  The save schema does not cap the Target Date at expiration — a workspace can
  legitimately be stored mid-edit — but the calculation schema now does. So this
  is the exact "saved state that exceeds expiration" case: it must open clamped
  back inside the window rather than dead-ending, and it must never be sent to
  the calculation API as-is.
*/
async function seedStrandedSimulation(page, name) {
  return page.evaluate(async ({ name, expiration, valuation }) => {
    const workspace = {
      name, description: '', symbol: 'AAPL', companyName: 'Apple Inc', exchange: 'NASDAQ', currency: 'USD',
      simulationType: 'what-if', strategyType: 'Long Call', underlyingPrice: 100, stockQuantity: 0, cashPosition: 0,
      entryDate: valuation, valuationDate: valuation,
      legs: [{ id: 'leg-1', kind: 'call', side: 'buy', quantity: 1, strike: 100, expiration,
        entryPremium: 5, impliedVolatility: 0.25, multiplier: 100, fees: 0, style: 'european' }],
      // Deliberately five weeks past the contract's expiration.
      scenarios: [{ id: 'base', name: 'Base', targetPrice: 110, valuationDate: '2026-09-30', volatilityShift: 0, rate: 0, dividendYield: 0 }],
      monteCarlo: { paths: 1000, seed: 42, horizonDays: 30, steps: 30, drift: 0, volatility: 0.25, rate: 0, dividendYield: 0 },
      dataSource: null, dataTimestamp: null, dataStatus: 'manual', resultSnapshot: null,
      methodologyVersion: 'options-simulator-v1',
    };
    const response = await fetch('/api/option-simulations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(workspace),
    });
    const payload = await response.json().catch(() => null);
    return { status: response.status, id: payload?.data?.id ?? null, storedTargetDate: payload?.data?.scenarios?.[0]?.valuationDate ?? null };
  }, { name, expiration: EXPIRATION, valuation: VALUATION });
}

async function probeSavedSimulations(page) {
  const name = `QA stranded ${Date.now()}`;
  const seeded = await seedStrandedSimulation(page, name);

  await page.goto(`${BASE_URL}/tools/what-if`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1_500);

  const card = page.locator('article').filter({ hasText: name }).first();
  await card.waitFor({ timeout: 30_000 });

  // The search row is the one that used to run off a 320px screen.
  const searchRow = await page.evaluate(() => {
    const input = [...document.querySelectorAll('input')].find((node) => node.placeholder === 'ค้นหาชื่อ หุ้น หรือกลยุทธ์');
    if (!input) return { found: false };
    const rect = input.getBoundingClientRect();
    const row = input.parentElement.getBoundingClientRect();
    return { found: true, inputRight: Math.round(rect.right), rowRight: Math.round(row.right), viewport: document.documentElement.clientWidth };
  });

  await card.getByRole('button', { name: 'เปิด', exact: true }).click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'What-If', exact: true }).click();
  await page.waitForTimeout(400);

  const date = page.locator('[data-validation-path="scenarios.0.valuationDate"]');
  await date.waitFor({ timeout: 30_000 });
  const openedTargetDate = await date.inputValue();
  const blockingError = await page.locator('[data-testid="validation-warning"]').count();

  return { name, seeded, searchRow, openedTargetDate, blockingError };
}

async function probeTargetDate(page, tabName) {
  await page.getByRole('button', { name: tabName, exact: true }).click();
  const date = page.locator('[data-validation-path="scenarios.0.valuationDate"]');
  await date.waitFor({ timeout: 30_000 });

  const attributes = await date.evaluate((node) => ({
    type: node.type,
    min: node.min,
    max: node.max,
    // The browser's own calendar day, to check the minimum is never in the past.
    browserToday: (() => {
      const now = new Date();
      return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
    })(),
    hasNativePicker: typeof node.showPicker === 'function',
    // The field must live inside the card, not escape it.
    insideCard: Boolean(node.closest('section')),
    withinCard: (() => {
      const card = node.closest('section');
      if (!card) return false;
      const cardRect = card.getBoundingClientRect();
      const rect = node.getBoundingClientRect();
      return rect.left >= cardRect.left - 1 && rect.right <= cardRect.right + 1;
    })(),
  }));

  const results = [];
  // Seed a known-good value so a rejection has something to fall back to.
  await date.fill('2026-08-13');
  await date.press('Tab');
  for (const testCase of TARGET_DATE_CASES) {
    const before = await date.inputValue();
    await date.fill(testCase.date);
    await date.press('Tab');
    await page.waitForTimeout(120);
    const after = await date.inputValue();
    const alertText = await page.locator('[data-testid="what-if-controls"] p[role="alert"], [data-testid="monte-carlo-controls"] p[role="alert"]').allTextContents();
    const accepted = after === testCase.date;
    results.push({
      tab: tabName, date: testCase.date, expect: testCase.expect,
      before, after, accepted,
      alerts: alertText,
      pass: testCase.expect === 'accept' ? accepted : !accepted && after === before,
    });
    if (!accepted) {
      // Restore the good value for the next case.
      await date.fill('2026-08-13');
      await date.press('Tab');
    }
  }
  return { attributes, results };
}

async function probeApiBoundary(page) {
  return page.evaluate(async ({ expiration, valuation, cases }) => {
    const out = [];
    for (const targetDate of cases) {
      const input = {
        symbol: 'AAPL', spot: 100, valuationDate: valuation, stockQuantity: 0, cashPosition: 0,
        legs: [{ id: 'leg-1', kind: 'call', side: 'buy', quantity: 1, strike: 100, expiration,
          entryPremium: 5, impliedVolatility: 0.25, multiplier: 100, fees: 0, style: 'european' }],
        scenario: { targetPrice: 110, targetDate, volatilityShift: 0, rate: 0, dividendYield: 0 },
      };
      const response = await fetch('/api/option-simulations/compute/what-if', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }),
      });
      const payload = await response.json().catch(() => null);
      out.push({ targetDate, status: response.status, issues: payload?.error?.issues ?? null, code: payload?.error?.code ?? null });
    }
    return out;
  }, { expiration: EXPIRATION, valuation: VALUATION, cases: TARGET_DATE_CASES.map((c) => c.date) });
}

async function probeMonteCarloApi(page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/option-simulations/compute/monte-carlo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: {} }),
    });
    return { status: response.status };
  });
}

async function run() {
  const browser = await chromium.launch({ executablePath: BROWSER, headless: true });
  const users = { pro: await createQaUser('pro'), elite: await createQaUser('elite') };

  try {
    // ---- Tier matrix -------------------------------------------------------
    for (const tier of ['pro', 'elite']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      const consoleState = collectConsole(page, errors);
      await signIn(page, users[tier], '/tools');
      await page.goto(`${BASE_URL}/tools`, { waitUntil: 'domcontentloaded' });
      await page.locator('[data-testid="tool-card-monte-carlo"]').waitFor({ timeout: 30_000 });

      const cards = await page.evaluate(() => ['what-if', 'monte-carlo'].map((id) => {
        const node = document.querySelector(`[data-testid="tool-card-${id}"]`);
        return node ? {
          id,
          requiredTier: node.getAttribute('data-required-tier'),
          locked: node.getAttribute('data-locked'),
          text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
        } : { id, missing: true };
      }));

      await page.goto(`${BASE_URL}/tools/monte-carlo`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Monte Carlo', exact: true }).click();
      await page.locator('[data-testid="monte-carlo-controls"]').waitFor({ timeout: 30_000 });
      const workspaceGate = await page.evaluate(() => {
        const desktop = document.querySelector('[data-testid="desktop-simulation-action"] button');
        const notice = document.querySelector('[data-testid="locked-simulator.monte_carlo"]');
        return {
          calculateLocked: desktop ? desktop.getAttribute('data-locked') : null,
          calculateRequiredTier: desktop ? desktop.getAttribute('data-required-tier') : null,
          lockedNoticePresent: Boolean(notice),
          lockedNoticeTier: notice ? notice.getAttribute('data-required-tier') : null,
        };
      });
      consoleState.expectingHttpFailure = true;
      const serverGate = await probeMonteCarloApi(page);
      consoleState.expectingHttpFailure = false;

      report.tierMatrix.push({ tier, cards, workspaceGate, serverGate, consoleErrors: errors });

      const whatIfCard = cards.find((card) => card.id === 'what-if');
      const monteCard = cards.find((card) => card.id === 'monte-carlo');
      check(whatIfCard?.requiredTier === 'pro', `${tier}: What-If card must be badged Pro`, whatIfCard);
      check(monteCard?.requiredTier === 'elite', `${tier}: Monte Carlo card must be badged Elite`, monteCard);
      if (tier === 'pro') {
        check(monteCard?.locked === 'true', 'pro: Monte Carlo card must be locked', monteCard);
        check(whatIfCard?.locked === 'false', 'pro: What-If card must be unlocked', whatIfCard);
        check(workspaceGate.calculateLocked === 'true', 'pro: Monte Carlo run button must be locked', workspaceGate);
        check(workspaceGate.calculateRequiredTier === 'elite', 'pro: run button must ask for Elite', workspaceGate);
        check(serverGate.status === 403, 'pro: Monte Carlo API must refuse (403)', serverGate);
      } else {
        check(monteCard?.locked === 'false', 'elite: Monte Carlo card must be unlocked', monteCard);
        check(workspaceGate.calculateLocked === null, 'elite: Monte Carlo run button must not be locked', workspaceGate);
        check(serverGate.status !== 403, 'elite: Monte Carlo API must not refuse on entitlement', serverGate);
      }
      check(errors.length === 0, `${tier}: console errors on the tier pass`, errors);
      await context.close();
    }

    // ---- Viewport sweep + Target Date, as Elite ----------------------------
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: viewport.mobile ? 3 : 1,
        isMobile: viewport.mobile,
        hasTouch: viewport.mobile,
      });
      const page = await context.newPage();
      const errors = [];
      const consoleState = collectConsole(page, errors);
      await signIn(page, users.elite, '/tools');

      const perViewport = { viewport: viewport.name, pages: [], consoleErrors: errors };

      for (const route of ['/tools', '/tools/what-if', '/tools/monte-carlo']) {
        await page.goto(`${BASE_URL}${route}`, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1_200);
        await scrollThroughPage(page);
        const overflow = await page.evaluate(OVERFLOW_PROBE);
        perViewport.pages.push({ route, phase: 'initial', overflow });
        check(overflow.offenderCount === 0, `${viewport.name} ${route}: ${overflow.offenderCount} element(s) outside the viewport`, overflow.offenders);
        check(overflow.documentScrollWidth === overflow.documentClientWidth,
          `${viewport.name} ${route}: document scrollWidth !== clientWidth`, overflow);
      }

      // Fill a real contract on the What-If route, then re-measure with content.
      await page.goto(`${BASE_URL}/tools/what-if`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1_200);
      await setupContract(page);

      for (const tab of ['What-If', 'Monte Carlo', 'Payoff', 'Greeks']) {
        await page.getByRole('button', { name: tab, exact: true }).click();
        await page.waitForTimeout(400);
        await scrollThroughPage(page);
        const overflow = await page.evaluate(OVERFLOW_PROBE);
        const sticky = await page.evaluate(STICKY_PROBE);
        perViewport.pages.push({ route: `/tools/what-if#${tab}`, phase: 'filled', overflow, sticky });
        check(overflow.offenderCount === 0, `${viewport.name} what-if/${tab}: ${overflow.offenderCount} element(s) outside the viewport`, overflow.offenders);

        if (viewport.mobile && (tab === 'What-If' || tab === 'Monte Carlo')) {
          check(sticky.hasCta, `${viewport.name} ${tab}: sticky CTA missing`);
          if (sticky.cta && sticky.dock) {
            check(sticky.cta.bottom <= sticky.dock.top + 1,
              `${viewport.name} ${tab}: sticky CTA overlaps the dock`, sticky);
          }
          if (sticky.cta && sticky.lastCard) {
            check(sticky.lastCard.bottom <= sticky.cta.top + 1,
              `${viewport.name} ${tab}: sticky CTA covers the last content card`, sticky);
          }
          // No dead space: the page must not end far above the sticky bar.
          const trailing = sticky.lastCard ? sticky.cta.top - sticky.lastCard.bottom : null;
          perViewport.pages[perViewport.pages.length - 1].trailingGap = trailing;
          check(trailing === null || trailing < 140,
            `${viewport.name} ${tab}: ${trailing}px of dead space above the sticky CTA`, sticky);

          const saveReachable = await page.evaluate(coveredBy('[data-testid="save-simulation-actions"]'));
          perViewport.pages[perViewport.pages.length - 1].saveReachable = saveReachable;
          check(!saveReachable.found || saveReachable.reachable,
            `${viewport.name} ${tab}: the save section is covered`, saveReachable);
        }
        if (!viewport.mobile) {
          check(!sticky.hasCta, `${viewport.name} ${tab}: sticky mobile CTA must not render on desktop`, sticky);
        }
      }

      // Target Date boundary, both modes, on this viewport.
      for (const tab of ['What-If', 'Monte Carlo']) {
        const probe = await probeTargetDate(page, tab);
        report.targetDateUi.push({ viewport: viewport.name, ...probe });
        check(probe.attributes.type === 'date', `${viewport.name} ${tab}: field is not input[type=date]`, probe.attributes);
        check(probe.attributes.max === EXPIRATION, `${viewport.name} ${tab}: max must be ${EXPIRATION}`, probe.attributes);
        /*
          The valuation date here is deliberately in the past, so the minimum is
          the reader's own today rather than valuation+1 — no past day is ever
          offered, and it is still read from the local calendar, not UTC.
        */
        const expectedMinimum = probe.attributes.browserToday > '2026-08-05' ? probe.attributes.browserToday : '2026-08-05';
        check(probe.attributes.min === expectedMinimum,
          `${viewport.name} ${tab}: min must be ${expectedMinimum}`, probe.attributes);
        check(probe.attributes.hasNativePicker, `${viewport.name} ${tab}: no native calendar picker`, probe.attributes);
        check(probe.attributes.withinCard, `${viewport.name} ${tab}: date field escapes its card`, probe.attributes);
        for (const result of probe.results) {
          check(result.pass, `${viewport.name} ${tab}: ${result.date} expected ${result.expect}`, result);
        }
      }

      if (viewport.name === '320x720') {
        const savedProbe = await probeSavedSimulations(page);
        report.savedSimulations = savedProbe;
        check(savedProbe.seeded.status === 201, 'saved: could not seed a stranded simulation', savedProbe.seeded);
        check(savedProbe.seeded.storedTargetDate === '2026-09-30', 'saved: seed did not store the stranded date', savedProbe.seeded);
        check(savedProbe.openedTargetDate === EXPIRATION,
          `saved: a Target Date past expiration must open clamped to ${EXPIRATION}`, savedProbe);
        check(savedProbe.blockingError === 0, 'saved: opening a clamped simulation must not dead-end on a validation error', savedProbe);
        check(!savedProbe.searchRow.found || savedProbe.searchRow.inputRight <= savedProbe.searchRow.viewport + 1,
          'saved: the search row runs past the viewport', savedProbe.searchRow);
      }

      if (viewport.name === '390x844') {
        consoleState.expectingHttpFailure = true;
        report.targetDateApi = await probeApiBoundary(page);
        consoleState.expectingHttpFailure = false;
        for (const row of report.targetDateApi) {
          const expected = row.targetDate === '2026-08-22' ? 400 : 200;
          check(row.status === expected, `API ${row.targetDate}: expected ${expected}, got ${row.status}`, row);
        }
      }

      await page.screenshot({ path: `${OUT_DIR}/${viewport.name}-what-if.png`, fullPage: true }).catch(() => undefined);
      check(errors.length === 0, `${viewport.name}: ${errors.length} console error(s)`, errors);
      perViewport.httpFailures = consoleState.httpFailures;
      report.viewports.push(perViewport);
      await context.close();
    }
  } finally {
    await browser.close();
    for (const user of Object.values(users)) {
      await supabase(`/auth/v1/admin/users/${user.userId}`, { method: 'DELETE' }).catch(() => undefined);
    }
  }

  report.finishedAt = new Date().toISOString();
  report.passed = report.failures.length === 0;
  writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    passed: report.passed,
    failureCount: report.failures.length,
    failures: report.failures.slice(0, 30),
    targetDateApi: report.targetDateApi,
    tierMatrix: report.tierMatrix.map((row) => ({
      tier: row.tier,
      cards: row.cards,
      workspaceGate: row.workspaceGate,
      serverGate: row.serverGate,
    })),
  }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

run().catch((error) => {
  console.error('QA run failed:', error);
  writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify({ ...report, fatal: String(error) }, null, 2));
  process.exitCode = 1;
});
