/**
 * Tools index + วางแผนหุ้นรายตัว (Stock Planner) — layout, entitlement, price
 * parity and the whole save → edit → delete round trip.
 *
 * Five things this run proves that a unit test cannot:
 *
 *  - a Basic reader is refused by the SERVER — the check reads the HTML the
 *    server actually sent to their session, not what the browser chose to
 *    render, so a client-only gate would fail here;
 *  - the read-only baseline the Planner shows is the SAME number the Stock
 *    Detail header shows for that symbol, compared live, in the same session.
 *    That is the one claim the whole tool rests on and the one no mock can make;
 *  - the figures on screen are the ones the pure module computes, end to end
 *    through the real search, the real price route and a real accepted price;
 *  - a saved plan survives a reload, an edit keeps its baseline, and a delete
 *    removes it — against the real database, as the reader's own session;
 *  - none of it overflows at 320px, in light or in dark.
 *
 * The overflow probe measures every element against the viewport rather than
 * trusting `document.scrollWidth`: the app shell clips with `overflow-x-hidden`,
 * so a row that runs off the screen is cut off rather than scrollable and the
 * document measurement stays clean.
 */
import { chromium } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { assertQaTarget, createQaAccounts, qaOwner } from './qa-accounts.mjs';

const BASE_URL = (process.env.QA_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const BROWSER = process.env.QA_BROWSER_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OUT_DIR = '.qa/artifacts/stock-planner-mobile';
const THEME_STORAGE_KEY = 'portkheaw-theme-preferences';
if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Missing Supabase QA environment');

/*
 * This script creates a real reader, so it may not run against production.
 * See `scripts/qa/qa-accounts.mjs` for why the guard and the teardown are one
 * module rather than a pattern nine scripts copy.
 */
assertQaTarget(SUPABASE_URL, 'qa:stock-planner-mobile');
const qaAccounts = createQaAccounts({ url: SUPABASE_URL, serviceKey: SERVICE_KEY, label: 'qa:stock-planner-mobile' });
mkdirSync(OUT_DIR, { recursive: true });

const VIEWPORTS = [
  { name: '430x932', width: 430, height: 932, mobile: true },
  { name: '390x844', width: 390, height: 844, mobile: true },
  { name: '320x720', width: 320, height: 720, mobile: true },
  { name: '1440x900', width: 1440, height: 900, mobile: false },
];

/*
  The plan is stated as multiples of whatever the canonical price is today, so
  the expected figures are exact without the run depending on AAPL's price:
  +10% up and −4% down is always 1 : 2.5.
*/
const TARGET_MULTIPLE = 1.1;
const INVALIDATION_MULTIPLE = 0.96;
const EXPECTED = { upside: '+10.0%', downside: '-4.0%', rewardRisk: '1 : 2.5' };

const report = {
  baseUrl: BASE_URL,
  startedAt: new Date().toISOString(),
  toolsIndex: [],
  serverGate: [],
  planner: [],
  priceParity: [],
  savedPlans: [],
  infoHint: [],
  themes: [],
  detailCta: [],
  consoleNoise: [],
  failures: [],
};

function check(condition, message, details = null) {
  if (!condition) report.failures.push({ message, details });
  return Boolean(condition);
}

/*
  The realtime market feed is a separate service (the Railway gateway) and is not
  running for a local QA server, so Stock Detail's socket is refused on every
  visit. It is recorded in the report but not counted as a failure: it is a
  property of the QA environment, not of the page under test, and counting it
  would leave this run permanently red for a reason nobody can fix here.
*/
const ENVIRONMENTAL_CONSOLE = /market-ws|ws:\/\/localhost:8081|ERR_CONNECTION_REFUSED/;
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

async function createQaUser(tier) {
  const email = `stock.planner.qa.${tier}.${Date.now()}@example.com`;
  const password = `Qa!${randomUUID()}Aa7`;
  const created = await supabase('/auth/v1/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: `Stock Planner QA ${tier}`, qa_owner: qaOwner('stock-planner-mobile-qa') } }),
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
      trial_started_at: null, trial_ends_at: null, trial_used_at: null,
      current_period_start: new Date(now - 60_000).toISOString(),
      current_period_end: new Date(now + 30 * 86_400_000).toISOString(),
      cancel_at_period_end: false,
    }),
  });
  return qaAccounts.register({ userId, email, password, tier });
}

/* Retried: a cold first sign-in against a just-started server can outrun the wait. */
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
  A fresh QA account meets the "มีอะไรใหม่" release announcement on its first
  authenticated page view. It is a real product surface and not this run's
  subject, so it is dismissed the way a reader would rather than measured — left
  open, its backdrop swallows every click that follows.
*/
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

/** Everything the viewport cuts off, named well enough to find in the source. */
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
        return child.getBoundingClientRect().right > clientRight + 1;
      });
      if (!cutsText) continue;
    }
    offenders.push({
      tag: element.tagName.toLowerCase(),
      testId: element.getAttribute('data-testid'),
      className: (element.getAttribute('class') || '').slice(0, 140),
      text: (element.textContent || '').trim().slice(0, 70),
      left: Math.round(rect.left), right: Math.round(rect.right),
      reason: spills ? 'outside-viewport' : 'clipped-content',
    });
  }
  return { viewport, documentScrollWidth: doc.scrollWidth, offenders: offenders.slice(0, 20), offenderCount: offenders.length };
})()`;

/** Each tool card's title, scope line and badge, plus whether they collide. */
const CARD_PROBE = `(() => {
  const cards = [...document.querySelectorAll('[data-testid^="tool-card-"]')];
  return cards.map((card) => {
    const scope = card.querySelector('[data-testid^="tool-scope-"]');
    const title = card.querySelector('h3');
    const badge = [...card.querySelectorAll('span')].find((node) => /^(basic|pro|elite)$/i.test((node.textContent || '').trim()));
    const box = (node) => node ? (({top,bottom,left,right}) => ({top:Math.round(top),bottom:Math.round(bottom),left:Math.round(left),right:Math.round(right)}))(node.getBoundingClientRect()) : null;
    const titleBox = box(title);
    const badgeBox = box(badge);
    return {
      id: card.getAttribute('data-testid'),
      requiredTier: card.getAttribute('data-required-tier'),
      locked: card.getAttribute('data-locked'),
      title: (title?.textContent || '').trim(),
      scope: (scope?.textContent || '').trim(),
      badge: (badge?.textContent || '').trim(),
      category: (card.querySelector('span.tracking-widest')?.textContent || '').trim(),
      badgeOverTitle: Boolean(titleBox && badgeBox) && badgeBox.bottom > titleBox.top && badgeBox.left < titleBox.right,
    };
  });
})()`;

const numeric = (value) => Number(String(value ?? '').replace(/[^0-9.]/g, ''));

async function readPlanner(page) {
  return page.evaluate(`(() => {
    const text = (selector) => {
      const node = document.querySelector(selector);
      return node ? (node.textContent || '').replace(/\\s+/g, ' ').trim() : null;
    };
    const scenarios = ['invalidation', 'flat', 'target'].map((kind) => text('[data-testid="stock-planner-scenario-' + kind + '"]'));
    return {
      asset: text('[data-testid="stock-planner-asset"]'),
      baseline: document.querySelector('[data-testid="stock-planner-baseline"]')?.value ?? null,
      baselineReadOnly: document.querySelector('[data-testid="stock-planner-baseline"]')?.readOnly ?? null,
      hasResult: Boolean(document.querySelector('[data-testid="stock-planner-result"]')),
      upside: text('[data-testid="stock-planner-upside"]'),
      downside: text('[data-testid="stock-planner-downside"]'),
      rewardRisk: text('[data-testid="stock-planner-reward-risk"]'),
      notProbability: text('[data-testid="stock-planner-not-probability"]'),
      scenarios,
      detailsOpen: Boolean(document.querySelector('[data-testid="stock-planner-details"]')),
      disclaimer: text('[data-testid="stock-planner-disclaimer"]'),
      bodyText: (document.body.textContent || '').replace(/\\s+/g, ' '),
    };
  })()`);
}

/** Choose AAPL, wait for the canonical baseline, and state a plan against it. */
async function fillPlan(page) {
  await dismissOverlays(page);
  const search = page.locator('input[role="combobox"]');
  await search.waitFor({ timeout: 30_000 });
  await search.click();
  await search.pressSequentially('AAPL', { delay: 60 });
  const option = page.locator('[role="option"]').filter({ hasText: 'AAPL' }).first();
  await option.waitFor({ timeout: 30_000 });
  await option.click();

  const baselineField = page.locator('[data-testid="stock-planner-baseline"]');
  await baselineField.waitFor({ timeout: 40_000 });
  const baselineText = await baselineField.inputValue();
  const baseline = numeric(baselineText);
  if (!Number.isFinite(baseline) || baseline <= 0) return { priced: false, baseline: null };

  await page.locator('[data-testid="stock-planner-target"]').fill((baseline * TARGET_MULTIPLE).toFixed(4));
  await page.locator('[data-testid="stock-planner-invalidation"]').fill((baseline * INVALIDATION_MULTIPLE).toFixed(4));
  await page.locator('[data-testid="stock-planner-analyze"]').click();
  await page.locator('[data-testid="stock-planner-result"]').waitFor({ timeout: 20_000 });
  return { priced: true, baseline };
}

/** A tapped ⓘ must open, be readable, and stay inside the viewport. */
async function probeInfoHint(page, term) {
  const trigger = page.locator(`[data-testid="info-hint-${term}"]`).first();
  if (await trigger.count() === 0) return { open: false, missing: true };
  await trigger.click();
  const probe = await page.evaluate(`(() => {
    const panel = document.querySelector('[data-testid="info-sheet-${term}"]') || document.querySelector('[data-testid="info-popover-${term}"]');
    if (!panel) return { open: false };
    const rect = panel.getBoundingClientRect();
    return {
      open: true,
      kind: panel.getAttribute('data-testid'),
      left: Math.round(rect.left), right: Math.round(rect.right),
      viewportWidth: document.documentElement.clientWidth,
      text: (panel.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
    };
  })()`);
  await page.keyboard.press('Escape').catch(() => undefined);
  return probe;
}

/**
 * Poll the database until `predicate` holds, or give up.
 *
 * Fixed sleeps were what made the first production smoke run report a delete
 * that had in fact succeeded: locally the round trip finished inside the sleep,
 * on a cold serverless function it did not. Waiting for the condition removes
 * the guess in both directions.
 */
async function untilPlans(userId, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let rows = [];
  while (Date.now() < deadline) {
    rows = await supabase(`/rest/v1/stock_plans?user_id=eq.${userId}&select=id,baseline_price,target_price,archived_at`);
    if (predicate(rows)) return rows;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return rows;
}

async function setAppearance(page, appearance) {
  await page.evaluate(([key, value]) => {
    window.localStorage.setItem(key, JSON.stringify({ theme: 'portkheaw', appearance: value }));
  }, [THEME_STORAGE_KEY, appearance]);
  await page.reload({ waitUntil: 'networkidle', timeout: 60_000 });
  await dismissOverlays(page);
}

async function run() {
  const users = { basic: await createQaUser('basic'), pro: await createQaUser('pro') };
  const browser = await chromium.launch({ executablePath: BROWSER, headless: true });

  try {
    /* 1. The server gate, read from the HTML the server sent each tier. */
    for (const tier of ['basic', 'pro']) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const page = await context.newPage();
      await signIn(page, users[tier], '/tools');
      await dismissOverlays(page);
      const response = await page.request.get(`${BASE_URL}/tools/stock-planner`);
      const html = await response.text();
      /*
        The write routes must refuse a Basic session too, not just the page.
        The POST is fired ONLY for Basic: against a Pro session it would succeed,
        which is correct behaviour and would leave a real plan behind for the
        save/edit/delete stage below to trip over.
      */
      const listed = await page.request.get(`${BASE_URL}/api/stock-plans`);
      const created = tier === 'basic'
        ? await page.request.post(`${BASE_URL}/api/stock-plans`, {
          data: { symbol: 'AAPL', baselinePrice: 100, targetPrice: 120, invalidationPrice: 90, horizonDate: '2027-12-31' },
        })
        : null;
      const priced = await page.request.get(`${BASE_URL}/api/tools/planner-price/AAPL`);
      const row = {
        tier,
        status: response.status(),
        lockedInHtml: html.includes('stock-planner-locked'),
        // The workspace's own furniture, present from its first render. None of
        // it may appear for Basic — not hidden, not blurred: absent entirely.
        workspaceInHtml: html.includes('stock-planner-plan') || html.includes('stock-planner-disclaimer'),
        listStatus: listed.status(),
        createStatus: created ? created.status() : null,
        priceStatus: priced.status(),
      };
      report.serverGate.push(row);
      if (tier === 'basic') {
        check(row.lockedInHtml, 'basic: the planner page did not send the locked notice', row);
        check(!row.workspaceInHtml, 'basic: the workspace reached an unentitled reader in the server HTML', row);
        check(row.listStatus >= 400, 'basic: GET /api/stock-plans was not refused', row);
        check(row.createStatus >= 400, 'basic: POST /api/stock-plans was not refused', row);
        check(row.priceStatus >= 400, 'basic: the planner price route was not refused', row);
      } else {
        check(!row.lockedInHtml, 'pro: the planner page sent a locked notice to an entitled reader', row);
        check(row.workspaceInHtml, 'pro: the workspace did not reach an entitled reader', row);
        check(row.listStatus === 200, 'pro: GET /api/stock-plans was refused', row);
      }
      await context.close();
    }

    /* 2. Layout and behaviour, per viewport, as the Pro reader. */
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: viewport.mobile, hasTouch: viewport.mobile, deviceScaleFactor: viewport.mobile ? 2 : 1,
      });
      const page = await context.newPage();
      const errors = [];
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text().slice(0, 300)); });
      page.on('pageerror', (error) => errors.push(`pageerror: ${String(error).slice(0, 300)}`));

      await signIn(page, users.pro, '/tools');
      await dismissOverlays(page);
      await page.goto(`${BASE_URL}/tools`, { waitUntil: 'networkidle', timeout: 60_000 });
      await dismissOverlays(page);
      const cards = await page.evaluate(CARD_PROBE);
      const toolsOverflow = await page.evaluate(OVERFLOW_PROBE);
      report.toolsIndex.push({ viewport: viewport.name, cards, overflow: toolsOverflow });
      check(cards.length === 3, `${viewport.name}: expected three tool cards`, cards.map((card) => card.id));
      for (const card of cards) {
        const planner = card.id === 'tool-card-stock-planner';
        check(card.scope === (planner ? 'สำหรับหุ้นและ ETF รายตัว' : 'สำหรับสัญญาออปชัน'),
          `${viewport.name} ${card.id}: scope line reads "${card.scope}"`, card);
        check(card.category === (planner ? 'วิเคราะห์หุ้น' : 'วิเคราะห์ Options'),
          `${viewport.name} ${card.id}: category reads "${card.category}"`, card);
        check(Boolean(card.badge), `${viewport.name} ${card.id}: no plan badge`, card);
        check(!card.badgeOverTitle, `${viewport.name} ${card.id}: badge overlaps the title`, card);
      }
      /* The options tools keep the tiers they already had. */
      const byId = Object.fromEntries(cards.map((card) => [card.id, card]));
      check(byId['tool-card-what-if']?.requiredTier === 'pro', `${viewport.name}: What-If is no longer Pro`, byId['tool-card-what-if']);
      check(byId['tool-card-monte-carlo']?.requiredTier === 'elite', `${viewport.name}: Monte Carlo is no longer Elite`, byId['tool-card-monte-carlo']);
      check(byId['tool-card-stock-planner']?.requiredTier === 'pro', `${viewport.name}: Stock Planner is not Pro`, byId['tool-card-stock-planner']);
      check(toolsOverflow.offenderCount === 0, `${viewport.name} /tools: ${toolsOverflow.offenderCount} element(s) run past the viewport`, toolsOverflow.offenders);
      await page.screenshot({ path: `${OUT_DIR}/${viewport.name}-tools.png`, fullPage: true }).catch(() => undefined);

      /* 3. The planner itself. */
      await page.goto(`${BASE_URL}/tools/stock-planner`, { waitUntil: 'networkidle', timeout: 60_000 });
      await dismissOverlays(page);
      const filled = await fillPlan(page);
      check(filled.priced, `${viewport.name}: the planner never showed a canonical baseline`);
      if (filled.priced) {
        await page.locator('[data-testid="stock-planner-details-toggle"]').click();
        await page.locator('[data-testid="stock-planner-details"]').waitFor({ timeout: 15_000 }).catch(() => undefined);
        const planner = await readPlanner(page);
        const plannerOverflow = await page.evaluate(OVERFLOW_PROBE);
        report.planner.push({ viewport: viewport.name, ...filled, ...planner, bodyText: undefined, overflow: plannerOverflow });

        check(planner.baselineReadOnly === true, `${viewport.name}: the baseline is editable`, planner);
        check(planner.upside === EXPECTED.upside, `${viewport.name}: upside reads "${planner.upside}"`, planner);
        check(planner.downside === EXPECTED.downside, `${viewport.name}: downside reads "${planner.downside}"`, planner);
        check(planner.rewardRisk === EXPECTED.rewardRisk, `${viewport.name}: Risk : Reward reads "${planner.rewardRisk}"`, planner);
        check(/ไม่ใช่ความน่าจะเป็น/.test(planner.notProbability ?? ''),
          `${viewport.name}: the "not a probability" notice is missing`, planner.notProbability);
        check(planner.scenarios.every(Boolean) && planner.scenarios.length === 3,
          `${viewport.name}: the three scenarios are not all present`, planner.scenarios);
        check(planner.detailsOpen, `${viewport.name}: ดูรายละเอียด did not open`);
        check(/ไม่ใช่คำแนะนำการลงทุน/.test(planner.disclaimer ?? ''), `${viewport.name}: the disclaimer is missing`, planner.disclaimer);
        check(!/(ควรซื้อ|ซื้อเลย|ควรขาย|ขายเลย|แนะนำให้ซื้อ|แนะนำให้ขาย)/.test(planner.bodyText ?? ''),
          `${viewport.name}: the page printed a directive`);
        check(plannerOverflow.offenderCount === 0,
          `${viewport.name} planner: ${plannerOverflow.offenderCount} element(s) run past the viewport`, plannerOverflow.offenders);

        for (const term of ['planCurrentPrice', 'planTarget', 'planInvalidation', 'planUpside', 'planDownside', 'planRiskReward']) {
          const hint = await probeInfoHint(page, term);
          report.infoHint.push({ viewport: viewport.name, term, ...hint });
          check(hint.open, `${viewport.name} ${term}: the info panel did not open on tap`, hint);
          if (hint.open) {
            check(hint.left >= -1 && hint.right <= hint.viewportWidth + 1,
              `${viewport.name} ${term}: the info panel runs past the viewport`, hint);
            check(hint.text.length > 20, `${viewport.name} ${term}: the info panel is empty`, hint);
          }
        }
        await page.screenshot({ path: `${OUT_DIR}/${viewport.name}-stock-planner.png`, fullPage: true }).catch(() => undefined);
      }

      const viewportErrors = appErrors(errors);
      report.consoleNoise.push({ viewport: viewport.name, environmental: errors.length - viewportErrors.length });
      check(viewportErrors.length === 0, `${viewport.name}: ${viewportErrors.length} console error(s)`, viewportErrors);
      await context.close();
    }

    /* 4. Price parity, the save round trip, the CTA and both appearances. */
    const context = await browser.newContext({ viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const page = await context.newPage();
    const errors = [];
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text().slice(0, 300)); });
    page.on('pageerror', (error) => errors.push(`pageerror: ${String(error).slice(0, 300)}`));
    await signIn(page, users.pro, '/tools');
    await dismissOverlays(page);

    for (const symbol of ['AAPL', 'SPY']) {
      /*
        The parity claim, made in one session against both surfaces: the number
        the Stock Detail header renders, and the number the Planner puts in its
        read-only box. They come from the same loader and the same canonical
        resolver, and this is where that stops being an assertion about the code.
      */
      await page.goto(`${BASE_URL}/stock/${symbol}`, { waitUntil: 'networkidle', timeout: 90_000 });
      await dismissOverlays(page);
      await page.locator('[data-testid="stock-last-price"]').waitFor({ timeout: 60_000 }).catch(() => undefined);
      const detailPrice = numeric(await page.locator('[data-testid="stock-last-price"]').first().textContent().catch(() => ''));

      /*
        The CTA closes the Financials tab rather than floating above the tab bar,
        so reaching it is part of what this checks: it must NOT be on the page
        before Financials is opened, and it must be there afterwards.
      */
      const ctaBeforeTab = await page.locator('[data-testid="stock-detail-plan-cta"]').count();
      check(ctaBeforeTab === 0, `${symbol}: the CTA is on the page before Financials is opened`);
      await page.getByRole('button', { name: 'Financials', exact: true }).click({ timeout: 30_000 }).catch(() => undefined);
      await page.locator('[data-testid="stock-detail-plan-section"]').waitFor({ timeout: 30_000 }).catch(() => undefined);

      const ctaCount = await page.locator('[data-testid="stock-detail-plan-cta"]').count();
      report.detailCta.push({ symbol, present: ctaCount > 0, inFinancials: true });
      check(ctaCount > 0, `${symbol}: the "วางแผนหุ้นนี้" CTA is missing from the Financials tab`);
      if (ctaCount > 0) {
        await page.locator('[data-testid="stock-detail-plan-cta"]').click();
        await page.waitForURL(/\/tools\/stock-planner/, { timeout: 30_000 }).catch(() => undefined);
      } else {
        await page.goto(`${BASE_URL}/tools/stock-planner?symbol=${symbol}`, { waitUntil: 'networkidle', timeout: 60_000 });
      }
      await dismissOverlays(page);
      const baselineField = page.locator('[data-testid="stock-planner-baseline"]');
      await baselineField.waitFor({ timeout: 40_000 }).catch(() => undefined);
      const plannerBaseline = numeric(await baselineField.inputValue().catch(() => ''));

      const row = { symbol, detailPrice, plannerBaseline, url: page.url() };
      report.priceParity.push(row);
      check(page.url().includes(`symbol=${symbol}`), `${symbol}: the CTA did not carry the symbol to the planner`, row);
      check(Number.isFinite(detailPrice) && detailPrice > 0, `${symbol}: Stock Detail showed no price`, row);
      check(Number.isFinite(plannerBaseline) && plannerBaseline > 0, `${symbol}: the planner showed no baseline`, row);
      if (detailPrice > 0 && plannerBaseline > 0) {
        // Same resolver, same session: they must agree to the displayed cent.
        check(Math.abs(detailPrice - plannerBaseline) <= 0.011,
          `${symbol}: planner baseline ${plannerBaseline} does not match Stock Detail ${detailPrice}`, row);
      }
    }

    /* 5. save → reload → edit → delete, against the real database. */
    await page.goto(`${BASE_URL}/tools/stock-planner`, { waitUntil: 'networkidle', timeout: 60_000 });
    const saveFlow = await fillPlan(page);
    if (saveFlow.priced) {
      await page.locator('[data-testid="stock-planner-save"]').click();
      await page.locator('[data-testid="saved-plan-AAPL"]').waitFor({ timeout: 30_000 });

      await page.reload({ waitUntil: 'networkidle', timeout: 60_000 });
      await dismissOverlays(page);
      const survived = await page.locator('[data-testid="saved-plan-AAPL"]').waitFor({ timeout: 30_000 })
        .then(() => true).catch(() => false);
      check(survived, 'the saved plan did not survive a reload');

      const rows = await supabase(`/rest/v1/stock_plans?user_id=eq.${users.pro.userId}&select=id,baseline_price,target_price,archived_at`);
      const beforeBaseline = rows[0]?.baseline_price;
      check(rows.length === 1, 'the database does not hold exactly one plan', rows);

      /* Edit: the target moves, the baseline must not. */
      await page.locator('[data-testid="saved-plan-edit-AAPL"]').click();
      const editedBaseline = numeric(await page.locator('[data-testid="stock-planner-baseline"]').inputValue());
      await page.locator('[data-testid="stock-planner-target"]').fill((editedBaseline * 1.25).toFixed(4));
      await page.locator('[data-testid="stock-planner-analyze"]').click();
      await page.locator('[data-testid="stock-planner-save"]').click();
      const afterRows = await untilPlans(
        users.pro.userId,
        (plans) => Number(plans[0]?.target_price) !== Number(rows[0]?.target_price),
      );
      const after = { beforeBaseline, afterBaseline: afterRows[0]?.baseline_price, afterTarget: afterRows[0]?.target_price };
      report.savedPlans.push({ stage: 'edit', ...after });
      check(Number(after.afterBaseline) === Number(beforeBaseline), 'the baseline moved on edit', after);
      check(Number(after.afterTarget) !== Number(rows[0]?.target_price), 'the edit did not change the target', after);

      /* Delete: archived, and gone from the reader's list. */
      await page.locator('[data-testid="saved-plan-delete-AAPL"]').click();
      await page.locator('[data-testid="saved-plan-confirm-delete-AAPL"]').click();
      const deletedRows = await untilPlans(
        users.pro.userId,
        (plans) => plans.every((plan) => plan.archived_at !== null),
      );
      const gone = await page.locator('[data-testid="saved-plan-AAPL"]')
        .waitFor({ state: 'detached', timeout: 20_000 }).then(() => true).catch(() => false);
      report.savedPlans.push({ stage: 'delete', rows: deletedRows, goneFromList: gone });
      check(gone, 'the deleted plan is still listed');
      check(deletedRows.every((plan) => plan.archived_at !== null), 'a deleted plan was not archived', deletedRows);
    }

    /* 6. Light and dark, on the planner. */
    for (const appearance of ['light', 'dark']) {
      await page.goto(`${BASE_URL}/tools/stock-planner?symbol=AAPL`, { waitUntil: 'networkidle', timeout: 60_000 });
      await setAppearance(page, appearance);
      await page.locator('[data-testid="stock-planner-baseline"]').waitFor({ timeout: 40_000 }).catch(() => undefined);
      const themeProbe = await page.evaluate(`(() => {
        const root = document.documentElement;
        const body = getComputedStyle(document.body);
        return { appearance: root.dataset.appearance, background: body.backgroundColor, color: body.color };
      })()`);
      const overflow = await page.evaluate(OVERFLOW_PROBE);
      report.themes.push({ appearance, ...themeProbe, offenderCount: overflow.offenderCount, offenders: overflow.offenders });
      check(themeProbe.appearance === appearance, `${appearance}: the appearance did not apply`, themeProbe);
      check(overflow.offenderCount === 0, `${appearance}: ${overflow.offenderCount} element(s) run past the viewport`, overflow.offenders);
      await page.screenshot({ path: `${OUT_DIR}/planner-${appearance}.png`, fullPage: true }).catch(() => undefined);
    }

    const flowErrors = appErrors(errors);
    report.consoleNoise.push({ viewport: 'flow', environmental: errors.length - flowErrors.length });
    check(flowErrors.length === 0, `flow: ${flowErrors.length} console error(s)`, flowErrors);
    await context.close();

    /*
      7. Where the CTA lives, on the page it lives on.

      The claim is placement, so it is measured rather than asserted: the plan
      section must be BELOW the Financials content it closes, must not exist at
      all until Financials is opened, and must not push anything past the
      viewport edge in either appearance at either required width.
    */
    for (const viewport of [
      { name: '1440x900', width: 1440, height: 900, mobile: false },
      { name: '390x844', width: 390, height: 844, mobile: true },
    ]) {
      for (const appearance of ['light', 'dark']) {
        const detailContext = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          isMobile: viewport.mobile, hasTouch: viewport.mobile, deviceScaleFactor: viewport.mobile ? 2 : 1,
        });
        const detailPage = await detailContext.newPage();
        const detailErrors = [];
        detailPage.on('console', (message) => { if (message.type() === 'error') detailErrors.push(message.text().slice(0, 300)); });
        detailPage.on('pageerror', (error) => detailErrors.push(`pageerror: ${String(error).slice(0, 300)}`));

        await signIn(detailPage, users.pro, '/stock/AAPL');
        await setAppearance(detailPage, appearance);
        await detailPage.locator('[data-testid="stock-last-price"]').waitFor({ timeout: 60_000 }).catch(() => undefined);

        const beforeTab = await detailPage.locator('[data-testid="stock-detail-plan-section"]').count();
        await detailPage.getByRole('button', { name: 'Financials', exact: true }).click({ timeout: 30_000 }).catch(() => undefined);
        await detailPage.locator('[data-testid="stock-detail-plan-section"]').waitFor({ timeout: 30_000 }).catch(() => undefined);

        // Geometry, not markup: the section's top edge must sit below the bottom
        // of the last piece of Financials content.
        const geometry = await detailPage.evaluate(`(() => {
          const section = document.querySelector('[data-testid="stock-detail-plan-section"]');
          if (!section) return null;
          const box = section.getBoundingClientRect();
          const siblings = Array.from(section.parentElement.children).filter((node) => node !== section);
          const contentBottom = Math.max(...siblings.map((node) => node.getBoundingClientRect().bottom));
          return {
            top: box.top + window.scrollY,
            right: box.right,
            contentBottom: contentBottom + window.scrollY,
            siblingCount: siblings.length,
          };
        })()`);
        const overflow = await detailPage.evaluate(OVERFLOW_PROBE);
        const appearanceProbe = await detailPage.evaluate('document.documentElement.dataset.appearance');
        const detailAppErrors = appErrors(detailErrors);

        const row = {
          viewport: viewport.name, appearance, appliedAppearance: appearanceProbe,
          presentBeforeFinancials: beforeTab > 0, geometry,
          offenders: overflow.offenderCount, consoleErrors: detailAppErrors.length,
        };
        report.detailCta.push(row);
        check(appearanceProbe === appearance, `stock detail ${viewport.name}/${appearance}: the appearance did not apply`, row);
        check(beforeTab === 0, `stock detail ${viewport.name}/${appearance}: the CTA is on the page before Financials is opened`, row);
        check(geometry !== null, `stock detail ${viewport.name}/${appearance}: the plan section is missing from Financials`, row);
        if (geometry) {
          check(geometry.siblingCount >= 2, `stock detail ${viewport.name}/${appearance}: Financials content is missing above the CTA`, row);
          check(geometry.top >= geometry.contentBottom - 1, `stock detail ${viewport.name}/${appearance}: the CTA is not below the Financials content`, row);
          check(geometry.right <= viewport.width + 1, `stock detail ${viewport.name}/${appearance}: the CTA runs past the viewport`, row);
        }
        check(overflow.offenderCount === 0, `stock detail ${viewport.name}/${appearance}: ${overflow.offenderCount} element(s) run past the viewport`, overflow.offenders);
        check(detailAppErrors.length === 0, `stock detail ${viewport.name}/${appearance}: ${detailAppErrors.length} console error(s)`, detailAppErrors);
        await detailPage.screenshot({ path: `${OUT_DIR}/stock-detail-financials-${viewport.name}-${appearance}.png`, fullPage: true }).catch(() => undefined);
        await detailContext.close();
      }
    }
  } finally {
    await browser.close();
    /*
      This used to be a bare admin delete per user with `.catch(() => undefined)`
      on the end, which is how two of these accounts ended up in production: the
      delete came back 500 with a 23503 from `portfolio_transactions`, and the
      catch threw the evidence away. The shared teardown removes the owned rows
      in dependency order first, and then CHECKS — nothing is swallowed.
    */
    report.teardown = await qaAccounts.teardown();
    if (report.teardown.remaining?.length || report.teardown.failed?.length) {
      report.failures.push(`teardown left ${report.teardown.remaining.length} account(s) behind`);
    }
  }

  report.finishedAt = new Date().toISOString();
  report.passed = report.failures.length === 0;
  writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    passed: report.passed,
    failureCount: report.failures.length,
    failures: report.failures.slice(0, 30),
    serverGate: report.serverGate,
    priceParity: report.priceParity,
    savedPlans: report.savedPlans,
    detailCta: report.detailCta,
    themes: report.themes.map((row) => ({ appearance: row.appearance, background: row.background, offenders: row.offenderCount })),
  }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

run().catch((error) => {
  console.error('QA run failed:', error);
  writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify({ ...report, fatal: String(error) }, null, 2));
  process.exitCode = 1;
});
