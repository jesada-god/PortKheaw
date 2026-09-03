/**
 * UI redesign — authenticated visual QA for the three surfaces that changed most.
 *
 * The public run (`ui-redesign-responsive-qa.mjs`) can only reach signed-out
 * routes, which means it never sees the portfolio hero, the holdings rows, the
 * accounting band, stock detail's metric bands and tab rail, or the Tools
 * catalogue — exactly where the redesign did its heaviest work. This signs in
 * and photographs them.
 *
 * Authentication is NOT new. It is the mechanism `phase1-ux-qa.mjs` already
 * uses: a throwaway Supabase user created through the admin API, its
 * subscription row patched to the tier under test, then a real sign-in through
 * the product's own form. Seeding likewise goes through the product's own RPCs
 * (`create_portfolio`, `create_portfolio_ledger_transaction`,
 * `get_or_create_default_watchlist`), never a hand-written row, so what is
 * photographed is what the app itself would have produced.
 *
 * Unlike the phase-1 script this one DELETES its user at the end, because it
 * exists to take pictures rather than to leave a fixture behind.
 *
 * Nothing here touches application code, authentication, or entitlement logic.
 */
import { chromium } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { assertQaTarget, createQaAccounts, qaOwner } from './qa-accounts.mjs';

const BASE_URL = (process.env.QA_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const BROWSER = process.env.QA_BROWSER_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OUT_DIR = '.qa/artifacts/ui-redesign-auth';
const THEME_STORAGE_KEY = 'portkheaw-theme-preferences';

if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Missing Supabase QA environment (.env.local)');

/*
 * This script creates a real reader, so it may not run against production.
 * See `scripts/qa/qa-accounts.mjs` for why the guard and the teardown are one
 * module rather than a pattern nine scripts copy.
 */
assertQaTarget(SUPABASE_URL, 'qa:ui-redesign-auth');
const qaAccounts = createQaAccounts({ url: SUPABASE_URL, serviceKey: SERVICE_KEY, label: 'qa:ui-redesign-auth' });
mkdirSync(OUT_DIR, { recursive: true });

const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900, mobile: false },
  { name: '390x844', width: 390, height: 844, mobile: true },
];

/**
 * One entry per PICTURE, not per route.
 *
 * Several of the things this run exists to verify are behind a control: the
 * portfolio masks every figure until the eye is pressed, so a default shot
 * shows six dots where the hierarchy under review should be; the accounting
 * band and a holding's detail band are both disclosures; and stock detail's
 * data bands, chart and financial bands are three different tabs. `prepare`
 * puts each surface into the state worth photographing, using the same controls
 * a reader would.
 */
const SURFACES = [
  {
    id: 'portfolio-hero',
    path: '/portfolio',
    expect: '[data-testid="portfolio-hero"]',
    prepare: reveal,
  },
  {
    id: 'portfolio-holdings',
    path: '/portfolio',
    /*
     * The holding rows, not the tracker home — `prepare` drills into the
     * equities group, and that screen has its own header rather than the
     * tracker's hero. Expecting `portfolio-hero` here reported four phantom
     * failures against a screen that had rendered perfectly.
     */
    expect: '[data-testid="holding-card"]',
    async prepare(page) {
      await reveal(page);
      // Into the equities group, where the holding rows live.
      await page.getByRole('button', { name: /หุ้นสหรัฐฯ/ }).first().click({ timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(900);
      // First holding expanded, so its detail band and Lots are in frame.
      await page.locator('[data-testid="holding-card"] button').first().click({ timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(700);
      // And the accounting band, which is the densest thing phase 3 changed.
      await page.locator('[data-testid="portfolio-accounting-details"] button').first()
        .click({ timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(700);
    },
  },
  { id: 'stock-overview', path: '/stock/AAPL', expect: '[data-testid="stock-last-price"]' },
  {
    id: 'stock-chart',
    path: '/stock/AAPL',
    expect: '[data-testid="stock-last-price"]',
    async prepare(page) {
      await page.getByRole('button', { name: 'Chart', exact: true }).first().click({ timeout: 20_000 }).catch(() => undefined);
      await page.waitForTimeout(3_500);
    },
  },
  {
    id: 'stock-financials',
    path: '/stock/AAPL',
    expect: '[data-testid="stock-last-price"]',
    /*
     * The Market Signal footer carries the line saying the card describes what
     * price did rather than predicting what it will do. jsdom can prove the
     * classes that would collapse it are absent; only a real layout can prove
     * the sentence is on screen and un-clipped at 390px, which is `mustRead`.
     */
    mustRead: '[data-testid="signal-footer"]',
    async prepare(page) {
      await page.getByRole('button', { name: 'Financials', exact: true }).first().click({ timeout: 20_000 }).catch(() => undefined);
      await page.waitForTimeout(2_500);
    },
  },
  { id: 'tools', path: '/tools', expect: '[data-testid="tool-card-stock-planner"]' },
];

/** Press the eye, so the figures under review are figures and not six dots. */
async function reveal(page) {
  await page.locator('[aria-label="แสดงยอดเงินชั่วคราว"]').first()
    .click({ timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(500);
}

const APPEARANCES = ['dark', 'light'];

/*
 * The realtime market feed is a separate service (the Railway gateway) and is
 * not running for a local QA server, so Stock Detail's socket is refused on
 * every visit. Recorded but never counted as a failure: a property of the QA
 * environment, not of the page under test. Same filter as `phase1-ux-qa.mjs`.
 */
const ENVIRONMENTAL_CONSOLE = /market-ws|ws:\/\/localhost|ws:\/\/127\.0\.0\.1|ERR_CONNECTION_REFUSED|Failed to load resource|favicon|manifest/;

const report = {
  baseUrl: BASE_URL,
  startedAt: new Date().toISOString(),
  shots: [],
  overflow: [],
  consoleErrors: [],
  missingAnchors: [],
  clipped: [],
  cleanup: null,
};

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

let accessToken = null;

async function rpc(name, args) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: response.ok, status: response.status, body };
}

/** Elite, so every gated band on stock detail and every tool renders unlocked. */
async function createQaUser(tier = 'elite') {
  const email = `ui.redesign.qa.${Date.now()}@example.com`;
  const password = `Qa!${randomUUID()}Aa7`;
  const created = await supabase('/auth/v1/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email, password, email_confirm: true,
      user_metadata: { full_name: 'UI Redesign QA', qa_owner: qaOwner('ui-redesign-qa') },
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
      billing_provider: 'stripe', billing_provider_mode: 'test',
      trial_started_at: null, trial_ends_at: null, trial_used_at: null,
      current_period_start: new Date(now - 60_000).toISOString(),
      current_period_end: new Date(now + 30 * 86_400_000).toISOString(),
      cancel_at_period_end: false,
    }),
  });
  const session = await supabase('/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  accessToken = session.access_token;
  return qaAccounts.register({ userId, email, password });
}

/** Seeded the way the product writes: through the RPCs the app itself calls. */
async function seed() {
  const portfolio = await rpc('create_portfolio', { input_name: 'พอร์ตทดสอบ QA', input_type: 'STOCK' });
  if (!portfolio.ok) throw new Error(`create_portfolio failed: ${portfolio.status} ${JSON.stringify(portfolio.body)}`);
  const portfolioId = portfolio.body;

  const ledger = async (fields) => {
    const result = await rpc('create_portfolio_ledger_transaction', {
      input_portfolio_id: portfolioId,
      input_symbol: null, input_quantity: null, input_price: null, input_amount: null, input_fee: null,
      input_original_currency: 'USD', input_fx_rate_at_transaction: null,
      input_broker: null, input_underlying_symbol: null, input_contract_symbol: null,
      input_option_kind: null, input_option_side: null, input_strike_price: null,
      input_expiration_date: null, input_multiplier: null, input_note: 'ui redesign qa',
      input_idempotency_key: randomUUID(),
      ...fields,
    });
    if (!result.ok) throw new Error(`seed ${fields.input_type} failed: ${result.status} ${JSON.stringify(result.body)}`);
  };

  await ledger({ input_type: 'deposit', input_amount: '50000', input_occurred_at: new Date(Date.now() - 7_200_000).toISOString() });
  await ledger({ input_type: 'acquisition', input_symbol: 'AAPL', input_quantity: '20', input_price: '180', input_fee: '0', input_occurred_at: new Date(Date.now() - 5_400_000).toISOString() });
  await ledger({ input_type: 'acquisition', input_symbol: 'NVDA', input_quantity: '15', input_price: '120', input_fee: '0', input_occurred_at: new Date(Date.now() - 5_000_000).toISOString() });
  await ledger({ input_type: 'acquisition', input_symbol: 'MSFT', input_quantity: '8', input_price: '400', input_fee: '0', input_occurred_at: new Date(Date.now() - 4_800_000).toISOString() });

  const watchlist = await rpc('get_or_create_default_watchlist', {});
  if (!watchlist.ok) throw new Error(`watchlist failed: ${watchlist.status}`);
  for (const symbol of ['AAPL', 'NVDA', 'TSLA']) {
    await fetch(`${SUPABASE_URL}/rest/v1/watchlist_items`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ watchlist_id: watchlist.body, symbol }),
    });
  }
}

/** Deletes one QA account and everything it owns, child rows first. */
async function cleanup(userId) {
  const owned = `user_id=eq.${encodeURIComponent(userId)}`;
  const portfolios = await supabase(`/rest/v1/portfolios?${owned}&select=id`);
  for (const portfolio of portfolios ?? []) {
    await supabase(`/rest/v1/portfolio_transactions?portfolio_id=eq.${encodeURIComponent(portfolio.id)}`, { method: 'DELETE' });
  }
  const watchlists = await supabase(`/rest/v1/watchlists?${owned}&select=id`);
  for (const watchlist of watchlists ?? []) {
    await supabase(`/rest/v1/watchlist_items?watchlist_id=eq.${encodeURIComponent(watchlist.id)}`, { method: 'DELETE' });
  }
  await supabase(`/rest/v1/watchlists?${owned}`, { method: 'DELETE' });
  await supabase(`/rest/v1/portfolios?${owned}`, { method: 'DELETE' });
  await supabase(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
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

/** Onboarding cards, release announcements and consent dialogs must not sit over the shot. */
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
    offenders.push({
      tag: node.tagName.toLowerCase(),
      testid: node.getAttribute('data-testid') || '',
      cls: (node.getAttribute('class') || '').slice(0, 130),
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      viewport,
    });
  }
  return offenders.slice(0, 10);
})()`;

/**
 * Is this block fully readable, or has the layout quietly eaten part of it?
 *
 * A disclosure that renders but is clipped to one line has not been made. Four
 * ways that happens, all checked: the box is not painted, it is painted at zero
 * size, its content is taller than the box holding it (a clamp, a fixed height,
 * an `overflow: hidden` ancestor), or it runs off the side of the screen.
 */
const CLIP_PROBE = (selector) => {
  const node = document.querySelector(selector);
  if (!node) return { problem: 'missing' };
  const style = getComputedStyle(node);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return { problem: 'hidden', display: style.display, visibility: style.visibility, opacity: style.opacity };
  }
  const rect = node.getBoundingClientRect();
  const viewport = document.documentElement.clientWidth;
  if (rect.width <= 1 || rect.height <= 1) return { problem: 'collapsed', width: rect.width, height: rect.height };
  if (rect.right > viewport + 1 || rect.left < -1) {
    return { problem: 'offscreen', left: Math.round(rect.left), right: Math.round(rect.right), viewport };
  }
  for (const line of [node, ...node.querySelectorAll('*')]) {
    if (line.scrollHeight > line.clientHeight + 1) {
      return {
        problem: 'clipped',
        text: (line.textContent || '').slice(0, 60),
        scrollHeight: line.scrollHeight,
        clientHeight: line.clientHeight,
      };
    }
    if (getComputedStyle(line).webkitLineClamp !== 'none') {
      return { problem: 'clamped', text: (line.textContent || '').slice(0, 60) };
    }
  }
  return null;
};

async function main() {
  const user = await createQaUser('elite');
  console.log(`QA user ${user.email}`);
  await seed();
  console.log('seeded portfolio ledger and watchlist through the product RPCs');

  const browser = await chromium.launch({ executablePath: BROWSER, headless: true });

  try {
    for (const appearance of APPEARANCES) {
      for (const viewport of VIEWPORTS) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          isMobile: viewport.mobile,
          hasTouch: viewport.mobile,
          deviceScaleFactor: 1,
        });
        await context.addInitScript(
          ([key, value]) => {
            try { window.localStorage.setItem(key, value); } catch { /* private mode */ }
          },
          [THEME_STORAGE_KEY, JSON.stringify({ theme: 'portkheaw', appearance })],
        );
        const page = await context.newPage();
        const errors = [];
        page.on('console', (message) => {
          if (message.type() !== 'error') return;
          const text = message.text();
          if (ENVIRONMENTAL_CONSOLE.test(text)) return;
          errors.push(text.slice(0, 220));
        });

        await signIn(page, user, '/portfolio');

        for (const surface of SURFACES) {
          await page.goto(`${BASE_URL}${surface.path}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
          await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => undefined);
          await dismissOverlays(page);
          if (surface.prepare) await surface.prepare(page);
          if (surface.expect) {
            const found = await page.locator(surface.expect).first()
              .waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false);
            if (!found) {
              report.missingAnchors.push({ appearance, viewport: viewport.name, surface: surface.id, selector: surface.expect });
            }
          }
          await page.waitForTimeout(900);

          if (surface.mustRead) {
            const problem = await page.evaluate(CLIP_PROBE, surface.mustRead);
            if (problem) {
              report.clipped.push({
                appearance, viewport: viewport.name, surface: surface.id, selector: surface.mustRead, ...problem,
              });
            }
          }

          const offenders = await page.evaluate(OVERFLOW_PROBE);
          if (offenders.length > 0) {
            report.overflow.push({ appearance, viewport: viewport.name, surface: surface.id, offenders });
          }
          const file = `${OUT_DIR}/${surface.id}-${appearance}-${viewport.name}.png`;
          await page.screenshot({ path: file, fullPage: true });
          report.shots.push(file);
        }

        if (errors.length > 0) {
          report.consoleErrors.push({ appearance, viewport: viewport.name, errors: [...new Set(errors)] });
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
    /*
     * This run exists to take pictures, so it takes its fixture away with it.
     *
     * Deleting the auth user is NOT enough on its own, and assuming it was is
     * how the first run left a user behind: `portfolio_transactions` references
     * `portfolios` without ON DELETE CASCADE, so the ledger rows pin the
     * portfolio, the portfolio pins the account, and the admin delete comes
     * back 500 with a 23503. The owned rows therefore come out in dependency
     * order — transactions, then watchlist items, then their parents — before
     * the account itself.
     *
     * Every statement is filtered to THIS run's user or to a portfolio it owns.
     * Nothing here is a blanket delete.
     */
    /*
      This script already knew about the foreign key — the paragraph above is
      the one that worked it out — and it still could not prove it had won: a
      failed delete printed "remove it manually" and the run carried on. The
      shared teardown does the same ordered purge and then CHECKS, and residue
      is a failure of the run.
    */
    report.cleanup = await qaAccounts.teardown();
    if (report.cleanup.remaining?.length || report.cleanup.failed?.length) {
      report.missingAnchors.push({ surface: 'teardown', detail: `${report.cleanup.remaining.length} account(s) left behind` });
    }
  }

  report.finishedAt = new Date().toISOString();
  writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(report, null, 2));

  const failed = report.overflow.length > 0 || report.consoleErrors.length > 0
    || report.missingAnchors.length > 0 || report.clipped.length > 0;
  if (report.missingAnchors.length > 0) {
    console.error('SURFACE DID NOT RENDER:');
    console.error(JSON.stringify(report.missingAnchors, null, 2));
  }
  if (report.overflow.length > 0) {
    console.error('HORIZONTAL OVERFLOW:');
    console.error(JSON.stringify(report.overflow, null, 2));
  }
  if (report.consoleErrors.length > 0) {
    console.error('CONSOLE ERRORS:');
    console.error(JSON.stringify(report.consoleErrors, null, 2));
  }
  if (report.clipped.length > 0) {
    console.error('DISCLOSURE NOT FULLY READABLE:');
    console.error(JSON.stringify(report.clipped, null, 2));
  }
  if (!failed) console.log('Portfolio, Stock Detail and Tools: clean at 1440x900 and 390x844, dark and light.');
  console.log(`Screenshots and report: ${OUT_DIR}`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
