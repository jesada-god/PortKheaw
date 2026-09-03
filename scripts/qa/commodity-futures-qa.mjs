/**
 * Commodity futures — proof for the three contracts, on the surfaces they touch.
 *
 * What no unit test can answer: whether ทองคำ, เงิน and น้ำมัน WTI actually
 * quote in a real browser, whether their marks paint rather than falling back to
 * a monogram of an exchange code, whether anything on a 320px handset runs off
 * the side of its card, and whether the equity-only furniture — the options
 * chain, the analyst consensus, the valuation statistics — is genuinely absent
 * from the DOM rather than merely scrolled out of frame.
 *
 * Two accounts, because the Financials tab has two correct outcomes: an
 * entitled reader must see the technical signal computed from the contract's own
 * candles, and an unentitled one must see the same paywall every other locked
 * surface shows. Both are checked; neither is assumed.
 *
 * `/stock/AAPL` is visited in the same run as the regression control. Everything
 * withheld from a contract has to still be there for an equity, and a run that
 * only looked at commodities could not tell "correctly hidden" from "broken".
 *
 * Authentication and cleanup are the mechanism `ui-redesign-authenticated-qa.mjs`
 * already uses: throwaway users through the admin API, a real sign-in through
 * the product's own form, and both accounts deleted at the end.
 */
import { chromium } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { assertQaTarget, createQaAccounts, qaOwner } from './qa-accounts.mjs';

const BASE_URL = (process.env.QA_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const BROWSER = process.env.QA_BROWSER_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OUT_DIR = '.qa/artifacts/commodity-futures';
const THEME_STORAGE_KEY = 'portkheaw-theme-preferences';

if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Missing Supabase QA environment (.env.local)');

/*
 * This script creates a real reader, so it may not run against production.
 * See `scripts/qa/qa-accounts.mjs` for why the guard and the teardown are one
 * module rather than a pattern nine scripts copy.
 */
assertQaTarget(SUPABASE_URL, 'qa:commodity-futures');
const qaAccounts = createQaAccounts({ url: SUPABASE_URL, serviceKey: SERVICE_KEY, label: 'qa:commodity-futures' });
mkdirSync(OUT_DIR, { recursive: true });

const CONTRACTS = [
  { symbol: 'GC-F', name: 'ทองคำ' },
  { symbol: 'SI-F', name: 'เงิน' },
  { symbol: 'CL-F', name: 'น้ำมัน WTI' },
];

const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900, mobile: false },
  { name: '390x844', width: 390, height: 844, mobile: true },
  { name: '320x720', width: 320, height: 720, mobile: true },
];

/**
 * Wording that describes a LISTED COMPANY. None of it may appear on a page about
 * a futures contract, in any tab, at any width. Matched against the rendered
 * text of the tab panel rather than against component names, so a panel that
 * comes back under a different import is still caught.
 */
const EQUITY_ONLY_TEXT = [
  'มูลค่าตลาด',        // market capitalisation
  'กลุ่มธุรกิจ',        // sector
  'อุตสาหกรรม',        // industry
  'จำนวนพนักงาน',      // employees
  'Analyst',
  'ราคาเป้าหมาย',      // target price
  'P/E',
  'EPS',
  'Revenue',
  'รายได้',
];

/** The options furniture, by the test ids and labels it actually renders under. */
const OPTIONS_SELECTORS = [
  '[data-testid="toggle-options"]',
  '[data-testid="options-levels"]',
  '[data-testid="options-locked"]',
  '[data-testid="options-expand-toggle"]',
  '[aria-label="ข้อมูลออปชัน"]',
  '[aria-label="Options Signal Engine"]',
];

const report = {
  baseUrl: BASE_URL,
  startedAt: new Date().toISOString(),
  checks: [],
  failures: [],
  overflow: [],
  consoleErrors: [],
  notes: [],
};

/** A recorded observation. `ok:false` is what fails the run. */
function check(id, ok, detail) {
  report.checks.push({ id, ok, detail });
  if (!ok) report.failures.push({ id, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}${detail ? ` — ${detail}` : ''}`);
}

/*
 * The realtime market feed is a separate service and is not running for a local
 * QA server, so the socket is refused on every stock page. Recorded, never
 * counted: a property of this environment, not of the pages under test.
 */
const ENVIRONMENTAL_CONSOLE = /market-ws|ws:\/\/localhost|ws:\/\/127\.0\.0\.1|ERR_CONNECTION_REFUSED|Failed to load resource|favicon|manifest/;

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
  const email = `commodity.qa.${tier}.${Date.now()}@example.com`;
  const password = `Qa!${randomUUID()}Aa7`;
  const created = await supabase('/auth/v1/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email, password, email_confirm: true,
      user_metadata: { full_name: 'Commodity QA', qa_owner: qaOwner('commodity-futures-qa') },
    }),
  });
  const userId = created.id;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const rows = await supabase(`/rest/v1/user_subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=user_id`);
    if (Array.isArray(rows) && rows.length === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const now = Date.now();
  await supabase(`/rest/v1/user_subscriptions?user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      tier, status: 'active',
      // The database honours a paid tier only with a trusted billing mode.
      ...(tier === 'basic' ? {} : { billing_provider: 'stripe', billing_provider_mode: 'test' }),
      trial_started_at: null, trial_ends_at: null, trial_used_at: null,
      current_period_start: new Date(now - 60_000).toISOString(),
      current_period_end: new Date(now + 30 * 86_400_000).toISOString(),
      cancel_at_period_end: false,
    }),
  });
  return qaAccounts.register({ userId, email, password, tier });
}

async function cleanup(userId) {
  await supabase(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE' })
    .catch((cause) => console.warn(`cleanup ${userId}: ${cause.message}`));
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

const SVG_INTERNALS = "['g','line','rect','path','circle','ellipse','polyline','polygon','text','tspan','use','defs','clipPath','linearGradient','stop']";

/**
 * Every element whose box leaves the viewport, excluding what is deliberately
 * scrollable. Measured per element rather than from `document.scrollWidth`,
 * because the shell sets `overflow-x: hidden` on the body — a row that runs off
 * the screen there is CLIPPED rather than scrollable, and the document-level
 * measurement stays clean while the reader loses the end of the row.
 */
const OVERFLOW_PROBE = `(() => {
  const viewport = document.documentElement.clientWidth;
  const svgInternals = new Set(${SVG_INTERNALS}.map((t) => t.toLowerCase()));
  const scrollers = new Set();
  for (const node of document.querySelectorAll('*')) {
    const overflowX = getComputedStyle(node).overflowX;
    if (overflowX === 'auto' || overflowX === 'scroll') scrollers.add(node);
  }
  const inScroller = (node) => {
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      if (scrollers.has(parent)) return true;
    }
    return false;
  };
  /*
   * Whether an ancestor already cuts this box off inside the screen.
   *
   * Two things in this app legitimately hand out boxes wider than the viewport
   * and are invisible for it: the \`sr-only\` mirror of the chart's canvas
   * labels (a 1px clipped container whose children keep their natural width),
   * and the decorative radial glow a card deliberately hangs past its own
   * corner. Neither is something the reader can lose the end of, because an
   * ancestor with \`overflow: hidden\` — itself entirely on screen — is painting
   * only the part inside its own box. Overflow is about what the READER loses,
   * so a clipped box is not one.
   */
  const clippedInside = (node) => {
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.overflowX !== 'hidden' && style.overflowX !== 'clip') continue;
      const box = parent.getBoundingClientRect();
      if (box.right <= viewport + 1 && box.left >= -1) return true;
    }
    return false;
  };
  const offenders = [];
  for (const node of document.querySelectorAll('body *')) {
    if (svgInternals.has(node.tagName.toLowerCase())) continue;
    if (inScroller(node)) continue;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    if (style.position === 'fixed') continue;
    if (node.closest('.dock')) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 1 && rect.height <= 1) continue;
    if (rect.right <= viewport + 1 && rect.left >= -1) continue;
    if (clippedInside(node)) continue;
    offenders.push({
      tag: node.tagName.toLowerCase(),
      testid: node.getAttribute('data-testid') || '',
      cls: (node.getAttribute('class') || '').slice(0, 130),
      left: Math.round(rect.left), right: Math.round(rect.right), viewport,
    });
  }
  return offenders.slice(0, 10);
})()`;

/**
 * Whether any text inside a market card is cut off by its own box.
 *
 * The horizontal rail on a handset is a legitimate scroller, so the viewport
 * probe above skips everything inside it — which is exactly where the commodity
 * cards live. This measures each card's descendants against THE CARD instead:
 * text wider than the box it sits in is text the reader cannot finish, whether
 * or not the page as a whole scrolls.
 */
const CARD_CLIPPING_PROBE = `(() => {
  const cards = [...document.querySelectorAll('[data-testid="market-card"]')];
  const clipped = [];
  for (const card of cards) {
    const box = card.getBoundingClientRect();
    const symbol = card.getAttribute('data-symbol') || '';
    for (const node of card.querySelectorAll('*')) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 1) continue;
      // 1px of slack for sub-pixel rounding.
      if (rect.right <= box.right + 1 && rect.left >= box.left - 1) continue;
      clipped.push({
        symbol,
        tag: node.tagName.toLowerCase(),
        text: (node.textContent || '').trim().slice(0, 40),
        overflowRight: Math.round(rect.right - box.right),
        overflowLeft: Math.round(box.left - rect.left),
      });
    }
  }
  return { cardCount: cards.length, clipped: clipped.slice(0, 10) };
})()`;

/**
 * Everything the reader can read on this page, as text.
 *
 * Deliberately NOT `page.locator('main')`: Stock Detail renders a `<main>`
 * inside the shell's `<main>`, so that locator is a strict-mode violation, it
 * throws, and a `.catch(() => '')` around it turns every "this word must not
 * appear" assertion into a comparison against the empty string — which passes
 * for any word at all. The equity control caught exactly that, which is what the
 * control is for. `.first()` is the shell's main and contains both.
 */
async function pageText(page) {
  return page.locator('main').first().innerText().catch(() => '');
}

async function openTab(page, name) {
  await page.getByRole('button', { name, exact: true }).first().click({ timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(2_500);
}

/**
 * The names on the tab rail, in order.
 *
 * Matched by exact button text rather than by `role="tab"`: the strip is
 * deliberately plain `<button>`s (see `Tabs.tsx` — it declines a role it cannot
 * back with a real tabpanel and roving focus), so a role selector finds nothing
 * and every assertion built on it passes vacuously.
 */
async function tabNames(page) {
  return page.evaluate(() => {
    const names = ['Overview', 'Chart', 'Financials', 'News', 'Analysis'];
    return [...document.querySelectorAll('button')]
      .map((node) => (node.textContent || '').trim())
      .filter((text) => names.includes(text));
  });
}

async function auditContract(page, contract, viewport, tier) {
  const tag = `${contract.symbol}@${viewport.name}/${tier}`;
  await page.goto(`${BASE_URL}/stock/${encodeURIComponent(contract.symbol)}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('[data-testid="stock-last-price"]', { timeout: 45_000 }).catch(() => undefined);
  await dismissOverlays(page);
  await page.waitForTimeout(1_500);

  // ── The page is about the right thing, and it has a real price ────────────
  const heading = await page.locator('h1').first().textContent().catch(() => '');
  check(`${tag}: page is the contract`, (heading || '').includes(contract.symbol), `h1=${heading}`);
  const priceText = await page.locator('[data-testid="stock-last-price"]').first().textContent().catch(() => '');
  const hasRealPrice = /\d/.test(priceText || '');
  check(`${tag}: quotes a real price`, hasRealPrice, `price=${(priceText || '').trim().slice(0, 40)}`);

  // ── The tab rail ──────────────────────────────────────────────────────────
  const tabs = await tabNames(page);
  check(`${tag}: keeps Financials for the signal`, tabs.includes('Financials'), `tabs=${tabs.join(',')}`);
  check(`${tag}: has no Analysis tab`, !tabs.includes('Analysis'), `tabs=${tabs.join(',')}`);

  // ── Overview: no company furniture ────────────────────────────────────────
  const overviewText = await pageText(page);
  const overviewLeaks = EQUITY_ONLY_TEXT.filter((term) => overviewText.includes(term));
  check(`${tag}: Overview shows no equity fundamentals`, overviewLeaks.length === 0, overviewLeaks.join(', '));

  const overviewOverflow = await page.evaluate(OVERFLOW_PROBE);
  if (overviewOverflow.length) report.overflow.push({ where: `${tag}/overview`, offenders: overviewOverflow });
  check(`${tag}: Overview fits the viewport`, overviewOverflow.length === 0, `${overviewOverflow.length} offenders`);
  await page.screenshot({ path: `${OUT_DIR}/${contract.symbol}-overview-${viewport.name}-${tier}.png`, fullPage: true });

  // ── Chart: no options anywhere ────────────────────────────────────────────
  await openTab(page, 'Chart');
  await page.waitForTimeout(3_000);
  for (const selector of OPTIONS_SELECTORS) {
    const count = await page.locator(selector).count();
    check(`${tag}: Chart has no ${selector}`, count === 0, `count=${count}`);
  }
  const chartText = await pageText(page);
  check(`${tag}: Chart mentions no IV / options chain`, !/Implied Vol|IV\b|Options Chain/i.test(chartText), '');
  const chartOverflow = await page.evaluate(OVERFLOW_PROBE);
  if (chartOverflow.length) report.overflow.push({ where: `${tag}/chart`, offenders: chartOverflow });
  check(`${tag}: Chart fits the viewport`, chartOverflow.length === 0, `${chartOverflow.length} offenders`);
  await page.screenshot({ path: `${OUT_DIR}/${contract.symbol}-chart-${viewport.name}-${tier}.png`, fullPage: true });

  // ── Financials: the signal, and nothing an issuer would have ─────────────
  await openTab(page, 'Financials');
  const financialsText = await pageText(page);
  const financialsLeaks = EQUITY_ONLY_TEXT.filter((term) => financialsText.includes(term));
  check(`${tag}: Financials shows no equity fundamentals`, financialsLeaks.length === 0, financialsLeaks.join(', '));
  // The same two panels the equity control asserts are PRESENT, asserted absent
  // here by the identity the control uses — so the pair cannot both be true of a
  // page that simply failed to render.
  const strayAnalyst = await page.locator('[aria-label="Target Price"]').count();
  check(`${tag}: Financials has no analyst panel`, strayAnalyst === 0, `sections=${strayAnalyst}`);
  const strayKeyStats = await page.locator('[aria-label="Key Statistics"], [data-testid="key-statistics"]').count();
  check(`${tag}: Financials has no key statistics`, strayKeyStats === 0, `sections=${strayKeyStats}`);
  const signalPresent = await page.locator('[aria-label="Technical Outlook"]').count();
  check(`${tag}: Financials carries the technical signal`, signalPresent > 0, `sections=${signalPresent}`);
  const locked = await page.locator('[data-testid="technical-outlook-locked"]').count();
  /*
   * A contract's signal is sold on the Pro step, so Pro and Elite both see the
   * result itself and only Basic sees the padlock. The padlock is checked for
   * the plan it NAMES as well as for its presence: a gate that opens at Pro
   * while its own copy asks for Elite would send a paying reader to a plan that
   * would not have helped them.
   */
  if (tier === 'basic') {
    check(`${tag}: Basic sees the paywall`, locked > 0, `locked=${locked}`);
    const notice = page.locator('[data-testid="locked-technical.outlook.commodity"]').first();
    const noticeCount = await notice.count();
    check(`${tag}: the paywall is the commodity gate, not the equity one`, noticeCount > 0, `count=${noticeCount}`);
    if (noticeCount > 0) {
      const requiredTier = await notice.getAttribute('data-required-tier');
      const noticeText = ((await notice.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      check(`${tag}: the paywall asks for Pro`, requiredTier === 'pro', `data-required-tier=${requiredTier}`);
      check(`${tag}: the paywall says Pro in words`, noticeText.includes('Pro') && !noticeText.includes('Elite'), noticeText);
    }
  } else {
    check(`${tag}: ${tier} sees the signal itself`, locked === 0, `locked=${locked}`);
    // The engine really ran for this reader: the server returns null for an
    // unentitled tier, and a null result renders "ยังโหลดข้อมูล…ไม่สำเร็จ"
    // rather than a state. A rendered state is proof the gate opened.
    const state = await page.locator('[aria-label="Technical Outlook"]').first().getAttribute('data-state');
    check(`${tag}: ${tier} gets a computed signal state`, Boolean(state), `data-state=${state}`);
  }
  const financialsOverflow = await page.evaluate(OVERFLOW_PROBE);
  if (financialsOverflow.length) report.overflow.push({ where: `${tag}/financials`, offenders: financialsOverflow });
  check(`${tag}: Financials fits the viewport`, financialsOverflow.length === 0, `${financialsOverflow.length} offenders`);
  await page.screenshot({ path: `${OUT_DIR}/${contract.symbol}-financials-${viewport.name}-${tier}.png`, fullPage: true });

  // ── News: whatever is real, and no crash ─────────────────────────────────
  await openTab(page, 'News');
  const newsArticles = await page.locator('[data-testid="news-article"], article').count();
  report.notes.push({ where: `${tag}/news`, articles: newsArticles });
  const newsOverflow = await page.evaluate(OVERFLOW_PROBE);
  if (newsOverflow.length) report.overflow.push({ where: `${tag}/news`, offenders: newsOverflow });
  check(`${tag}: News fits the viewport`, newsOverflow.length === 0, `${newsOverflow.length} offenders`);
}

/** The control: everything withheld above must still be present for an equity. */
async function auditEquityControl(page, viewport, tier) {
  const tag = `AAPL@${viewport.name}/${tier}`;
  await page.goto(`${BASE_URL}/stock/AAPL`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('[data-testid="stock-last-price"]', { timeout: 45_000 }).catch(() => undefined);
  await dismissOverlays(page);
  const tabs = await tabNames(page);
  check(`${tag}: equity keeps its Analysis tab`, tabs.includes('Analysis'), `tabs=${tabs.join(',')}`);
  check(`${tag}: equity keeps its Financials tab`, tabs.includes('Financials'), `tabs=${tabs.join(',')}`);

  await openTab(page, 'Chart');
  await page.waitForTimeout(3_000);
  const toggle = await page.locator('[data-testid="toggle-options"]').count();
  check(`${tag}: equity keeps the chart Options toggle`, toggle > 0, `count=${toggle}`);

  await openTab(page, 'Financials');
  /*
   * The analyst panel by its own identity, not by its words.
   *
   * `AnalystTargetSection` carries no entitlement gate — it is the same section
   * on every plan — but its TEXT depends on whether the provider answered for
   * this symbol just then: a resolved target reads "Target Price", an
   * unavailable one reads "ยังไม่มีราคาเป้าหมายสำหรับหุ้นนี้". Matching on the
   * copy made this check pass or fail on provider weather rather than on
   * whether the panel is still on the page, which is the only thing the control
   * is asking.
   */
  const analystPanel = await page.locator('[aria-label="Target Price"]').count();
  check(`${tag}: equity keeps its analyst panel`, analystPanel > 0, `sections=${analystPanel}`);
  const text = await pageText(page);
  report.notes.push({ where: `${tag}/financials`, analystPanel, sample: text.slice(0, 120).replace(/\s+/g, ' ') });

  /*
   * The regression that matters most about the entitlement split: an equity's
   * Technical Outlook is still an ELITE value. Pro must still be refused here
   * while it is admitted on a contract, and the padlock must still be the equity
   * capability — if the commodity row had leaked onto this page, a Pro reader
   * would silently have been given a value nobody paid for.
   */
  const locked = await page.locator('[data-testid="technical-outlook-locked"]').count();
  if (tier === 'elite') {
    check(`${tag}: Elite still sees the equity signal`, locked === 0, `locked=${locked}`);
  } else {
    check(`${tag}: ${tier} is still refused the equity signal`, locked > 0, `locked=${locked}`);
    const notice = page.locator('[data-testid="locked-technical.outlook"]').first();
    const noticeCount = await notice.count();
    check(`${tag}: the equity paywall is unchanged`, noticeCount > 0, `count=${noticeCount}`);
    if (noticeCount > 0) {
      const requiredTier = await notice.getAttribute('data-required-tier');
      check(`${tag}: the equity signal still asks for Elite`, requiredTier === 'elite', `data-required-tier=${requiredTier}`);
    }
    // And the commodity row must not appear on an equity page at all.
    const strayCount = await page.locator('[data-testid="locked-technical.outlook.commodity"]').count();
    check(`${tag}: the commodity gate never appears on an equity`, strayCount === 0, `count=${strayCount}`);
  }

  await page.screenshot({ path: `${OUT_DIR}/AAPL-control-${viewport.name}-${tier}.png`, fullPage: true });
}

/**
 * Options entitlement on an equity, which this change must leave exactly alone.
 *
 * Pro carries the chain, Elite adds the walls, Basic has neither — three
 * different correct outcomes, so the check is per tier rather than a single
 * "options exist" assertion that all three would pass.
 */
async function auditOptionsEntitlement(page, viewport, tier) {
  const tag = `AAPL-options@${viewport.name}/${tier}`;
  await page.goto(`${BASE_URL}/stock/AAPL`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('[data-testid="stock-last-price"]', { timeout: 45_000 }).catch(() => undefined);
  await dismissOverlays(page);
  await openTab(page, 'Analysis');
  await page.waitForTimeout(3_500);

  const signalLocked = await page.locator('[data-testid="options-signal-locked"]').count();
  const breakdownLocked = await page.locator('[data-testid="options-signal-breakdown-locked"]').count();
  const chainLocked = await page.locator('[data-testid="options-locked"]').count();
  /*
   * The summary gate is the one this environment can actually observe, and it
   * discriminates: Basic is refused, Pro and Elite are admitted.
   *
   * The per-factor BREAKDOWN gate deliberately is not asserted. Its locked block
   * only exists once the Options Signal reaches `ready`, and no options provider
   * is configured for a local QA server — so the panel renders its "not ready"
   * branch for every plan and the element is absent for Basic, Pro and Elite
   * alike. Asserting on it here would not be testing an entitlement; it would be
   * testing whether a provider answered, and it would read as a Pro regression
   * every time one did not. It is recorded below instead.
   */
  if (tier === 'basic') {
    check(`${tag}: Basic is refused the Options Signal`, signalLocked > 0, `locked=${signalLocked}`);
  } else {
    check(`${tag}: ${tier} keeps the Options Signal summary`, signalLocked === 0, `locked=${signalLocked}`);
  }
  report.notes.push({ where: tag, signalLocked, breakdownLocked, chainLocked });
  await page.screenshot({ path: `${OUT_DIR}/AAPL-options-${viewport.name}-${tier}.png`, fullPage: true });
}

async function auditMarketToday(page, viewport, tier) {
  const tag = `market-today@${viewport.name}/${tier}`;
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('#market-overview', { timeout: 45_000 }).catch(() => undefined);
  await dismissOverlays(page);
  await page.waitForTimeout(3_000);

  for (const contract of CONTRACTS) {
    const card = page.locator(`[data-testid="market-card"][data-symbol="${contract.symbol}"]`).first();
    const present = await card.count();
    check(`${tag}: ${contract.symbol} card exists`, present > 0, '');
    if (!present) continue;
    const text = await card.innerText().catch(() => '');
    check(`${tag}: ${contract.symbol} names the thing`, text.includes(contract.name), text.slice(0, 60).replace(/\n/g, ' | '));
    check(`${tag}: ${contract.symbol} quotes a price`, /\d[\d,]*\.\d/.test(text), text.slice(0, 60).replace(/\n/g, ' | '));
    // A bundled mark paints as an <img>. A monogram is a <span role="img">, and
    // that is precisely the outcome this change exists to remove.
    const image = await card.locator('img').count();
    const monogram = await card.locator('span[role="img"]').count();
    check(`${tag}: ${contract.symbol} paints its mark`, image > 0 && monogram === 0, `img=${image} monogram=${monogram}`);
  }

  const clipping = await page.evaluate(CARD_CLIPPING_PROBE);
  check(`${tag}: no market card clips its own contents`, clipping.clipped.length === 0,
    `${clipping.cardCount} cards, ${clipping.clipped.length} clipped ${JSON.stringify(clipping.clipped).slice(0, 300)}`);

  const overflow = await page.evaluate(OVERFLOW_PROBE);
  if (overflow.length) report.overflow.push({ where: tag, offenders: overflow });
  check(`${tag}: overview fits the viewport`, overflow.length === 0, `${overflow.length} offenders`);
  await page.screenshot({ path: `${OUT_DIR}/market-today-${viewport.name}-${tier}.png`, fullPage: true });
}

async function main() {
  /*
   * All three plans, because the commodity signal now has three different
   * correct answers and only a run that holds all three can tell a working
   * ladder from a gate that is simply always open or always shut.
   */
  const elite = await createQaUser('elite');
  const pro = await createQaUser('pro');
  const basic = await createQaUser('basic');
  console.log(`QA users: ${elite.email} (elite), ${pro.email} (pro), ${basic.email} (basic)`);

  const browser = await chromium.launch({ executablePath: BROWSER, headless: true });
  try {
    for (const user of [elite, pro, basic]) {
      for (const viewport of VIEWPORTS) {
        // Every width for Elite, which is where the layout work is proved. The
        // Pro and Basic passes exist to prove the ENTITLEMENT, and a gate does
        // not change with the viewport, so one width each is the honest cost.
        if (user.tier !== 'elite' && viewport.name !== '390x844') continue;
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          isMobile: viewport.mobile,
          hasTouch: viewport.mobile,
          deviceScaleFactor: 1,
        });
        await context.addInitScript(
          ([key, value]) => { try { window.localStorage.setItem(key, value); } catch { /* private mode */ } },
          [THEME_STORAGE_KEY, JSON.stringify({ theme: 'portkheaw', appearance: 'dark' })],
        );
        const page = await context.newPage();
        page.on('console', (message) => {
          if (message.type() !== 'error') return;
          const text = message.text();
          if (ENVIRONMENTAL_CONSOLE.test(text)) return;
          report.consoleErrors.push({ tier: user.tier, viewport: viewport.name, text: text.slice(0, 200) });
        });

        await signIn(page, user, '/');
        await auditMarketToday(page, viewport, user.tier);
        for (const contract of CONTRACTS) await auditContract(page, contract, viewport, user.tier);
        // The equity control runs on EVERY tier: "Pro is refused here" is only
        // meaningful said beside "Pro is admitted on a contract", and both
        // halves have to come from the same signed-in reader.
        await auditEquityControl(page, viewport, user.tier);
        await auditOptionsEntitlement(page, viewport, user.tier);

        await context.close();
      }
    }
  } finally {
    await browser.close();
    /*
      Was three hand-written `cleanup(...)` calls, one per reader — correct only
      for as long as nobody adds a fourth. The registry sweeps whatever was
      created, and verifies it, which the old version never did.
    */
    report.teardown = await qaAccounts.teardown();
    if (report.teardown.remaining?.length || report.teardown.failed?.length) {
      report.failures.push(`teardown left ${report.teardown.remaining.length} account(s) behind`);
    }
  }

  report.finishedAt = new Date().toISOString();
  report.passed = report.failures.length === 0 && report.consoleErrors.length === 0;
  writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(report, null, 2));
  console.log(`\n${report.checks.filter((c) => c.ok).length}/${report.checks.length} checks passed`);
  if (report.consoleErrors.length) console.log(`console errors: ${JSON.stringify(report.consoleErrors, null, 2)}`);
  if (!report.passed) {
    console.log(`FAILURES:\n${JSON.stringify(report.failures, null, 2)}`);
    process.exitCode = 1;
  }
}

main().catch((cause) => {
  console.error(cause);
  process.exitCode = 1;
});
