/**
 * Tools index + วางแผนหุ้นรายตัว (Stock Planner) — mobile layout, entitlement and
 * arithmetic QA.
 *
 * Three things this run proves that a unit test cannot:
 *
 *  - the asset-scope line and the plan badge share a card at 320px without
 *    either wrapping into the other or pushing the card off the viewport;
 *  - a Basic reader is refused by the SERVER — the check reads the HTML the
 *    server actually sent to their session, not what the browser chose to
 *    render, so a client-only gate would fail here;
 *  - the figures a Pro reader sees on screen are the ones the pure module
 *    computes, end to end through the real search and the real quote route.
 *
 * The overflow probe measures every element against the viewport rather than
 * trusting `document.scrollWidth`: the app shell clips with `overflow-x-hidden`,
 * so a row that runs off the screen is cut off rather than scrollable and the
 * document measurement stays clean.
 */
import { chromium } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE_URL = (process.env.QA_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const BROWSER = process.env.QA_BROWSER_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OUT_DIR = '.qa/artifacts/stock-planner-mobile';
if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Missing Supabase QA environment');
mkdirSync(OUT_DIR, { recursive: true });

const VIEWPORTS = [
  { name: '430x932', width: 430, height: 932, mobile: true },
  { name: '390x844', width: 390, height: 844, mobile: true },
  { name: '320x720', width: 320, height: 720, mobile: true },
  { name: '1440x900', width: 1440, height: 900, mobile: false },
];

/* The plan the run types in, and exactly what the pure module says about it. */
const PLAN = { entry: '100', stop: '95.8', target: '110.1', budget: '5000' };
const EXPECTED_SUMMARY = [
  'ถ้าราคาลงถึงจุดตัดขาดทุน คุณเสี่ยงประมาณ 4.2%',
  'ถ้าราคาขึ้นถึงเป้าหมาย ผลตอบแทนจากจุดเข้าอยู่ที่ประมาณ 10.1%',
  'แผนนี้ยอมเสี่ยง 1 ส่วน เพื่อหวังผลตอบแทนประมาณ 2.4 ส่วน',
];

const report = {
  baseUrl: BASE_URL,
  startedAt: new Date().toISOString(),
  toolsIndex: [],
  serverGate: [],
  planner: [],
  infoHint: [],
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
  const email = `stock.planner.qa.${tier}.${Date.now()}@example.com`;
  const password = `Qa!${randomUUID()}Aa7`;
  const created = await supabase('/auth/v1/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: `Stock Planner QA ${tier}`, qa_owner: 'stock-planner-mobile-qa' } }),
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
  return { userId, email, password, tier };
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
  /*
    The announcement is server-rendered and only stops being rendered once the
    acknowledgement lands, so a single close is not enough: it can reappear on
    the next navigation while that round trip is still in flight. Two
    consecutive clean checks is the signal that it is really gone.
  */
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
    // Decoration: the tools card's oversized corner blob is clipped by design.
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
      cardBox: box(card),
      // The badge sits above the title, so "collide" means their boxes overlap.
      badgeOverTitle: Boolean(titleBox && badgeBox) && badgeBox.bottom > titleBox.top && badgeBox.left < titleBox.right,
      height: card ? Math.round(card.getBoundingClientRect().height) : null,
    };
  });
})()`;

async function readPlanner(page) {
  return page.evaluate(`(() => {
    const text = (selector) => {
      const node = document.querySelector(selector);
      return node ? (node.textContent || '').replace(/\\s+/g, ' ').trim() : null;
    };
    const summary = [...document.querySelectorAll('[data-testid="stock-planner-summary"] li')]
      .map((node) => (node.textContent || '').replace(/\\s+/g, ' ').trim());
    const figures = [...document.querySelectorAll('[data-testid="stock-planner-result"] dt')]
      .map((dt) => ({ label: (dt.textContent || '').replace(/\\s+/g, ' ').trim(), value: (dt.nextElementSibling?.textContent || '').trim() }));
    const position = [...document.querySelectorAll('[data-testid="stock-planner-position"] dt')]
      .map((dt) => ({ label: (dt.textContent || '').trim(), value: (dt.nextElementSibling?.textContent || '').trim() }));
    return {
      asset: text('[data-testid="stock-planner-asset"]'),
      hasResult: Boolean(document.querySelector('[data-testid="stock-planner-result"]')),
      hasBar: Boolean(document.querySelector('[data-testid="stock-planner-bar"]')),
      disclaimer: text('[data-testid="stock-planner-disclaimer"]'),
      summary, figures, position,
    };
  })()`);
}

async function fillPlan(page) {
  await dismissOverlays(page);
  const search = page.locator('input[role="combobox"]');
  await search.waitFor({ timeout: 30_000 });
  await search.click();
  await search.pressSequentially('AAPL', { delay: 60 });
  const option = page.locator('[role="option"]').filter({ hasText: 'AAPL' }).first();
  await option.waitFor({ timeout: 30_000 });
  await option.click();
  await page.locator('[data-testid="stock-planner-asset"]').waitFor({ timeout: 30_000 });
  /*
    The quote is what makes the chosen stock a real one on screen, so the run
    waits for the price to land rather than screenshotting a skeleton and
    calling it a pass.
  */
  const priced = await page.locator('[data-testid="stock-planner-asset"]')
    .getByText(/\$\d/).first().waitFor({ timeout: 25_000 }).then(() => true).catch(() => false);
  // The quote prefills Entry; the plan overwrites it with a round number so the
  // expected sentences are exact rather than dependent on today's price.
  await page.locator('[data-testid="stock-planner-entry"]').fill(PLAN.entry);
  await page.locator('[data-testid="stock-planner-stop"]').fill(PLAN.stop);
  await page.locator('[data-testid="stock-planner-target"]').fill(PLAN.target);
  await page.locator('[data-testid="stock-planner-size"]').fill(PLAN.budget);
  await page.locator('[data-testid="stock-planner-result"]').waitFor({ timeout: 15_000 });
  return { priced };
}

/** A tapped ⓘ must open, be readable, and stay inside the viewport. */
async function probeInfoHint(page, term) {
  await page.locator(`[data-testid="info-hint-${term}"]`).click();
  const probe = await page.evaluate(`(() => {
    const panel = document.querySelector('[data-testid="info-sheet-${term}"]') || document.querySelector('[data-testid="info-popover-${term}"]');
    if (!panel) return { open: false };
    const rect = panel.getBoundingClientRect();
    return {
      open: true,
      kind: panel.getAttribute('data-testid'),
      left: Math.round(rect.left), right: Math.round(rect.right),
      top: Math.round(rect.top), bottom: Math.round(rect.bottom),
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: window.innerHeight,
      text: (panel.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
    };
  })()`);
  await page.keyboard.press('Escape').catch(() => undefined);
  return probe;
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
      const row = {
        tier,
        status: response.status(),
        lockedInHtml: html.includes('stock-planner-locked'),
        // The workspace's own furniture, present from its first render. None of
        // it may appear for Basic — not hidden, not blurred: absent from the
        // payload entirely.
        workspaceInHtml: html.includes('stock-planner-step-symbol') || html.includes('stock-planner-disclaimer'),
      };
      report.serverGate.push(row);
      if (tier === 'basic') {
        check(row.lockedInHtml, 'basic: the planner page did not send the locked notice', row);
        check(!row.workspaceInHtml, 'basic: the workspace reached an unentitled reader in the server HTML', row);
      } else {
        check(!row.lockedInHtml, 'pro: the planner page sent a locked notice to an entitled reader', row);
        check(row.workspaceInHtml, 'pro: the workspace did not reach an entitled reader', row);
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
      const quoteCalls = [];
      page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text().slice(0, 300)); });
      page.on('pageerror', (error) => errors.push(`pageerror: ${String(error).slice(0, 300)}`));
      page.on('response', (response) => {
        if (response.url().includes('/api/market/quote/')) quoteCalls.push(`${response.status()} ${response.url().replace(/^https?:\/\/[^/]+/, '')}`);
      });

      await signIn(page, users.pro, '/tools');
      await dismissOverlays(page);
      await page.goto(`${BASE_URL}/tools`, { waitUntil: 'networkidle', timeout: 60_000 });
      await dismissOverlays(page);
      const cards = await page.evaluate(CARD_PROBE);
      const toolsOverflow = await page.evaluate(OVERFLOW_PROBE);
      report.toolsIndex.push({ viewport: viewport.name, cards, overflow: toolsOverflow });
      check(cards.length === 3, `${viewport.name}: expected three tool cards`, cards.map((card) => card.id));
      for (const card of cards) {
        const expected = card.id === 'tool-card-stock-planner' ? 'สำหรับหุ้นรายตัว' : 'สำหรับสัญญาออปชัน';
        check(card.scope === expected, `${viewport.name} ${card.id}: scope line reads "${card.scope}"`, card);
        check(Boolean(card.badge), `${viewport.name} ${card.id}: no plan badge`, card);
        check(!card.badgeOverTitle, `${viewport.name} ${card.id}: badge overlaps the title`, card);
      }
      check(toolsOverflow.offenderCount === 0, `${viewport.name} /tools: ${toolsOverflow.offenderCount} element(s) run past the viewport`, toolsOverflow.offenders);
      await page.screenshot({ path: `${OUT_DIR}/${viewport.name}-tools.png`, fullPage: true }).catch(() => undefined);

      await page.goto(`${BASE_URL}/tools/stock-planner`, { waitUntil: 'networkidle', timeout: 60_000 });
      await dismissOverlays(page);
      const filled = await fillPlan(page);
      const planner = await readPlanner(page);
      const plannerOverflow = await page.evaluate(OVERFLOW_PROBE);
      report.planner.push({ viewport: viewport.name, ...filled, ...planner, quoteCalls: quoteCalls.slice(0, 40), overflow: plannerOverflow });
      check(filled.priced, `${viewport.name}: the chosen stock never showed its price`, quoteCalls);

      check(planner.summary.length === 3, `${viewport.name}: the plan summary is not three sentences`, planner.summary);
      for (const [index, sentence] of EXPECTED_SUMMARY.entries()) {
        check(planner.summary[index] === sentence, `${viewport.name}: summary line ${index + 1} reads "${planner.summary[index]}"`, planner.summary);
      }
      check(planner.figures.some((figure) => figure.value === '1 : 2.4'), `${viewport.name}: Risk/Reward is not 1 : 2.4`, planner.figures);
      check(planner.figures.some((figure) => figure.value === '-4.2%'), `${viewport.name}: risk is not -4.2%`, planner.figures);
      check(planner.figures.some((figure) => figure.value === '+10.1%'), `${viewport.name}: reward is not +10.1%`, planner.figures);
      check(planner.position.some((figure) => figure.value === '50 หุ้น'), `${viewport.name}: position is not 50 shares`, planner.position);
      check(planner.position.some((figure) => figure.value.includes('-$210.00')), `${viewport.name}: loss at stop is not -$210.00`, planner.position);
      check(planner.hasBar, `${viewport.name}: the Stop–Entry–Target bar is missing`);
      check(/ไม่ใช่คำแนะนำการลงทุน/.test(planner.disclaimer ?? ''), `${viewport.name}: the disclaimer is missing`, planner.disclaimer);
      check(plannerOverflow.offenderCount === 0, `${viewport.name} planner: ${plannerOverflow.offenderCount} element(s) run past the viewport`, plannerOverflow.offenders);

      for (const term of ['planEntry', 'planRiskReward']) {
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
      check(errors.length === 0, `${viewport.name}: ${errors.length} console error(s)`, errors);
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
    serverGate: report.serverGate,
    cards: report.toolsIndex.map((row) => ({ viewport: row.viewport, cards: row.cards.map((card) => `${card.title} · ${card.scope} · ${card.badge}`) })),
  }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

run().catch((error) => {
  console.error('QA run failed:', error);
  writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify({ ...report, fatal: String(error) }, null, 2));
  process.exitCode = 1;
});
