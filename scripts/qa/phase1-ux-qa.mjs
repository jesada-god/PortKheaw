/**
 * Phase 1 UX — one QA run across the seven surfaces that changed.
 *
 * What this proves that no unit test can: that a real session, with a real
 * ledger, a real watchlist and a real price alert behind it, reaches every one
 * of these pages without a console error and without anything running off the
 * side of a phone — in both appearances, at three widths.
 *
 * The overflow probe measures every element against the viewport rather than
 * trusting `document.scrollWidth`: the shell clips with `overflow-x-hidden`, so
 * a row that runs off the screen is cut off rather than scrollable and the
 * document measurement stays clean.
 */
import { chromium } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { assertNotProduction } from '../../src/lib/dev/db-target.ts';

const BASE_URL = (process.env.QA_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const BROWSER = process.env.QA_BROWSER_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OUT_DIR = '.qa/artifacts/phase1-ux';
const THEME_STORAGE_KEY = 'portkheaw-theme-preferences';
/** Leave the accounts behind for inspection. Debugging only. */
const KEEP = process.argv.includes('--keep');
if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Missing Supabase QA environment');

/*
 * ===========================================================================
 * THIS SCRIPT CREATES REAL ACCOUNTS, SO IT REFUSES PRODUCTION
 * ===========================================================================
 * It signs in as real readers, which means real `auth.users` rows, a real
 * subscription row, real watchlist items and a real price alert. It had been
 * running against PRODUCTION for as long as it has existed: `.env.local` is
 * this repo's production configuration by convention — `db-target.ts` says so
 * and names that project ref — and the npm script reads it. Because the script
 * never deleted anything, every run left two accounts in production, and a
 * second tool (`trial:qa-cleanup`) existed to go and find them afterwards.
 *
 * A QA script should not need another script following it around. It cleans up
 * after itself now, and it refuses to run anywhere it should never have been
 * writing. `assertNotProduction` throws and has no override flag, for the
 * reasons its own header sets out.
 */
assertNotProduction(SUPABASE_URL, 'qa:phase1-ux');

mkdirSync(OUT_DIR, { recursive: true });

const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900, mobile: false },
  { name: '390x844', width: 390, height: 844, mobile: true },
  { name: '430x932', width: 430, height: 932, mobile: true },
];

const SURFACES = [
  { id: 'home', path: '/', expect: '[data-testid="upcoming-section"]' },
  { id: 'portfolio', path: '/portfolio', expect: '[data-testid="portfolio-hero"]' },
  { id: 'watchlist', path: '/watchlist', expect: null },
  { id: 'search', path: '/search', expect: null },
  { id: 'stock-detail', path: '/stock/AAPL', expect: null },
  { id: 'tools', path: '/tools', expect: '[data-testid="tool-card-stock-planner"]' },
  { id: 'upcoming', path: '/upcoming', expect: '[data-testid="upcoming-section"]' },
];

const report = {
  baseUrl: BASE_URL,
  startedAt: new Date().toISOString(),
  surfaces: [],
  features: [],
  entitlement: [],
  failures: [],
};

function check(condition, message, details = null) {
  if (!condition) report.failures.push({ message, details });
  return Boolean(condition);
}

/*
  The realtime market feed is a separate service (the Railway gateway) and is not
  running for a local QA server, so Stock Detail's socket is refused on every
  visit. It is recorded but never counted as a failure: it is a property of the
  QA environment, not of the page under test.
*/
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

let accessToken = null;

async function rpc(name, args, token = accessToken) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: response.ok, status: response.status, body };
}

/**
 * EVERY ACCOUNT THIS RUN MADE, in creation order.
 *
 * Registered inside `createQaUser` rather than at each call site, because the
 * two calls are in different places and the second one is easy to miss: `run`
 * makes the Pro reader, and `eliteSummaryCheck` makes an Elite one four hundred
 * lines away, inside a helper invoked from one branch of a nested loop. A
 * teardown written against the call sites would have swept one of the two and
 * looked like it worked.
 */
const createdUsers = [];

/**
 * The seeded rows an account owns, in the order they have to go.
 *
 * DELETING THE USER IS NOT ENOUGH, and the first version of this teardown found
 * that out the honest way — by failing:
 *
 *     23503: update or delete on table "portfolios" violates foreign key
 *     constraint "portfolio_transactions_portfolio_id_fkey"
 *
 * `portfolio_transactions` does not cascade from `portfolios`, so an account
 * with a seeded ledger cannot be deleted until its own rows are. Which also
 * means the accounts this script has been leaving behind were never removable
 * by `trial:qa-cleanup` either: it calls the same admin delete and would have
 * hit the same constraint.
 *
 * Each step is its own request so a failure names the table it happened on —
 * the discipline `verify-overview-alert-sweep.ts` states for its own teardown.
 * Rows this run did not create are not touched: every filter is the account's
 * own id.
 */
async function purgeSeededRows(userId) {
  const gone = [];
  const del = async (label, path) => {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method: 'DELETE',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, Prefer: 'return=minimal' },
    });
    gone.push(`${label}${response.ok ? '' : ` FAILED ${response.status}`}`);
  };
  const owner = `user_id=eq.${encodeURIComponent(userId)}`;

  await del('price_alerts', `price_alerts?${owner}`);

  const lists = await supabase(`/rest/v1/watchlists?${owner}&select=id`);
  const listIds = (Array.isArray(lists) ? lists : []).map((row) => row.id);
  if (listIds.length > 0) {
    await del('watchlist_items', `watchlist_items?watchlist_id=in.(${listIds.join(',')})`);
    await del('watchlists', `watchlists?${owner}`);
  }

  /*
    Transactions before portfolios: that is the constraint that failed, and the
    order is the fix rather than a precaution.
  */
  const portfolios = await supabase(`/rest/v1/portfolios?${owner}&select=id`);
  const portfolioIds = (Array.isArray(portfolios) ? portfolios : []).map((row) => row.id);
  if (portfolioIds.length > 0) {
    await del('portfolio_transactions', `portfolio_transactions?portfolio_id=in.(${portfolioIds.join(',')})`);
    await del('portfolios', `portfolios?${owner}`);
  }
  return gone;
}

/**
 * Delete every account this run made, and prove it.
 *
 * Newest first, so a partial failure leaves the older ledger intact rather than
 * a half-swept pair.
 *
 * Then it CHECKS, rather than assuming: a `GET` on each id must answer 404. A
 * teardown that reports success from the delete call alone is a teardown that
 * tells you the mess is gone on exactly the runs where it is not — and the
 * first version of this one did exactly that until the check was added.
 */
async function teardownAccounts() {
  if (createdUsers.length === 0) return { deleted: 0, failed: [], remaining: [] };
  console.log('\nteardown');
  const failed = [];
  for (const account of [...createdUsers].reverse()) {
    try {
      const rows = await purgeSeededRows(account.userId);
      await supabase(`/auth/v1/admin/users/${encodeURIComponent(account.userId)}`, { method: 'DELETE' });
      console.log(`  deleted ${account.tier.padEnd(5)} ${account.email}${rows.length ? `  [${rows.join(', ')}]` : ''}`);
    } catch (error) {
      failed.push({ ...account, error: error instanceof Error ? error.message : String(error) });
      console.log(`  FAILED  ${account.tier.padEnd(5)} ${account.email}: ${error instanceof Error ? error.message : error}`);
    }
  }
  const remaining = [];
  for (const account of createdUsers) {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(account.userId)}`, {
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
    if (response.ok) remaining.push({ userId: account.userId, email: account.email });
  }
  console.log(remaining.length === 0
    ? `  verified: ${createdUsers.length} account(s) created, 0 left behind`
    : `  VERIFY FAILED: ${remaining.length} account(s) still present`);
  return { deleted: createdUsers.length - failed.length, failed, remaining };
}

async function createQaUser(tier) {
  const email = `phase1.ux.qa.${tier}.${Date.now()}@example.com`;
  const password = `Qa!${randomUUID()}Aa7`;
  const created = await supabase('/auth/v1/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: `Phase1 UX QA ${tier}`, qa_owner: 'phase1-ux-qa' } }),
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
      /*
       * The database honours a paid tier only when the row also carries a
       * trusted billing mode, so without this the account reads Pro in the
       * table and Basic at every gate.
       */
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
  createdUsers.push({ userId, email, tier });
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
        // Text inside a scroller — or inside the scroller itself — is reachable
        // by scrolling, so it is not cut off. The edge-to-edge market carousel
        // is exactly this shape and is deliberate.
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

async function seedAccount(user) {
  /*
   * Seeded the way the product writes: the ledger through its own RPC, the
   * watchlist through the same default-list routine the repository calls. A
   * row inserted around those would be a fixture the app never produced.
   */
  const portfolio = await rpc('create_portfolio', { input_name: 'QA Phase 1', input_type: 'STOCK' });
  if (!portfolio.ok) throw new Error(`Could not create the QA portfolio: ${portfolio.status} ${JSON.stringify(portfolio.body)}`);
  const portfolioId = portfolio.body;

  const ledger = async (fields) => {
    const result = await rpc('create_portfolio_ledger_transaction', {
      input_portfolio_id: portfolioId,
      input_symbol: null, input_quantity: null, input_price: null, input_amount: null, input_fee: null,
      input_original_currency: 'USD', input_fx_rate_at_transaction: null,
      input_broker: null, input_underlying_symbol: null, input_contract_symbol: null,
      input_option_kind: null, input_option_side: null, input_strike_price: null,
      input_expiration_date: null, input_multiplier: null, input_note: 'QA phase 1',
      input_idempotency_key: randomUUID(),
      ...fields,
    });
    if (!result.ok) throw new Error(`Could not seed ${fields.input_type}: ${result.status} ${JSON.stringify(result.body)}`);
  };

  await ledger({ input_type: 'deposit', input_amount: '50000', input_occurred_at: new Date(Date.now() - 7_200_000).toISOString() });
  await ledger({ input_type: 'acquisition', input_symbol: 'AAPL', input_quantity: '20', input_price: '180', input_fee: '0', input_occurred_at: new Date(Date.now() - 5_400_000).toISOString() });
  await ledger({ input_type: 'acquisition', input_symbol: 'NVDA', input_quantity: '15', input_price: '120', input_fee: '0', input_occurred_at: new Date(Date.now() - 5_000_000).toISOString() });
  await ledger({ input_type: 'acquisition', input_symbol: 'MSFT', input_quantity: '8', input_price: '400', input_fee: '0', input_occurred_at: new Date(Date.now() - 4_800_000).toISOString() });

  const watchlist = await rpc('get_or_create_default_watchlist', {});
  if (!watchlist.ok) throw new Error(`Could not create the QA watchlist: ${watchlist.status}`);
  for (const symbol of ['AAPL', 'NVDA', 'TSLA']) {
    await fetch(`${SUPABASE_URL}/rest/v1/watchlist_items`, {
      method: 'POST',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ watchlist_id: watchlist.body, symbol }),
    });
  }

  /*
   * One enabled alert, deliberately far from the market. It proves the reverse
   * of the feature: an alert nowhere near its target must NOT appear as
   * something coming up.
   */
  await fetch(`${SUPABASE_URL}/rest/v1/price_alerts`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      user_id: user.userId, symbol: 'AAPL', condition: 'above',
      target_value: '9999', cooldown_minutes: 60, enabled: true,
    }),
  });
  report.seed = { portfolioId, watchlistId: watchlist.body };
}

async function visit(page, surface, viewport, appearance) {
  const errors = [];
  const onConsole = (message) => { if (message.type() === 'error') errors.push(message.text()); };
  const onPageError = (error) => errors.push(String(error));
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  await page.goto(`${BASE_URL}${surface.path}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await dismissOverlays(page);
  if (surface.expect) {
    await page.locator(surface.expect).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
  }
  await page.waitForTimeout(1_500);
  const overflow = await page.evaluate(OVERFLOW_PROBE);
  const consoleErrors = appErrors(errors);
  page.off('console', onConsole);
  page.off('pageerror', onPageError);
  const row = { surface: surface.id, viewport: viewport.name, appearance, overflow, consoleErrors };
  report.surfaces.push(row);
  check(overflow.length === 0, `overflow on ${surface.id} at ${viewport.name} (${appearance})`, overflow);
  check(consoleErrors.length === 0, `console errors on ${surface.id} at ${viewport.name} (${appearance})`, consoleErrors);
  await page.screenshot({ path: `${OUT_DIR}/${surface.id}-${viewport.name}-${appearance}.png`, fullPage: false });
}

async function featureChecks(page) {
  // Portfolio — the daily insight card and its one drill-down.
  await page.goto(`${BASE_URL}/portfolio`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await dismissOverlays(page);
  const insight = page.locator('[data-testid="portfolio-daily-insight"]');
  const hasInsight = await insight.count() > 0;
  report.features.push({ id: 'portfolio-daily-insight', present: hasInsight });
  check(hasInsight, 'the portfolio daily insight card did not render for a seeded ledger');
  if (hasInsight) {
    await page.locator('[data-testid="daily-insight-toggle"]').click({ timeout: 10_000 }).catch(() => undefined);
    const detail = await page.locator('[data-testid="daily-insight-detail"]').count();
    report.features.push({ id: 'daily-insight-detail', present: detail > 0 });
    check(detail > 0, 'ดูรายละเอียด did not reveal the decomposition');
  }

  // Watchlist — sorting control and a context line.
  await page.goto(`${BASE_URL}/watchlist`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await dismissOverlays(page);
  const sortOptions = await page.locator('[data-testid="watchlist-sort"] option').allTextContents();
  report.features.push({ id: 'watchlist-sort', options: sortOptions });
  check(sortOptions.includes('การเปลี่ยนแปลง') && sortOptions.includes('ตัวอักษร') && sortOptions.includes('เพิ่มล่าสุด'),
    'watchlist sorting does not offer change/alphabetical/recently added', sortOptions);
  await page.selectOption('[data-testid="watchlist-sort"]', 'symbol').catch(() => undefined);
  const firstSymbol = (await page.locator('article button >> nth=0').first().textContent().catch(() => '')) ?? '';
  report.features.push({ id: 'watchlist-sort-applied', firstSymbol: firstSymbol.trim().slice(0, 24) });

  // Search — a result navigates to Stock Detail.
  await page.goto(`${BASE_URL}/search`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await dismissOverlays(page);
  await page.fill('input[aria-label="ค้นหา Symbol หรือชื่อบริษัท"]', 'AAPL');
  await page.locator('[data-testid="search-result-AAPL"]').first().waitFor({ timeout: 30_000 });
  await page.locator('[data-testid="search-result-AAPL"]').first().click();
  await page.waitForURL((url) => url.pathname.startsWith('/stock/'), { timeout: 30_000 }).catch(() => undefined);
  const navigated = page.url().includes('/stock/AAPL');
  report.features.push({ id: 'search-navigation', navigated, url: page.url() });
  check(navigated, 'a search result did not open Stock Detail', page.url());

  // Stock Detail — the summary card, when a canonical source answered.
  await page.waitForTimeout(2_000);
  const summaryRows = await page.locator('[data-testid="stock-summary-card"] li').count();
  report.features.push({ id: 'stock-summary-card', rows: summaryRows });

  // Upcoming — the full list renders for a seeded account.
  await page.goto(`${BASE_URL}/upcoming`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await dismissOverlays(page);
  const upcoming = await page.locator('[data-testid="upcoming-section"]').count();
  const upcomingRows = await page.locator('[data-testid="upcoming-section"] li').count();
  report.features.push({ id: 'upcoming-route', present: upcoming > 0, rows: upcomingRows });
  check(upcoming > 0, '/upcoming did not render the unified section');
  /*
    THE FIXTURE'S ALERT MUST NOT BE HERE, and that is the claim it was seeded to
    make.

    `seedAccount` writes one enabled alert on AAPL at 9999 — thousands of
    percent above the market and deliberately so, because the feature being
    proved is the NEGATIVE one: an alert nowhere near its target is not
    something coming up, and must not be listed as though it were.

    Until now this run only recorded the row count and asserted the section
    existed. So the day a far-off alert started appearing, the count would have
    moved from 0 to 1 in the report and every check would still have passed —
    the one fixture written to catch that would have watched it happen. The
    account is otherwise fresh, with no earnings date and no option expiry, so
    zero is the whole expected content of this list.
  */
  check(
    upcomingRows === 0,
    `/upcoming listed ${upcomingRows} row(s); the seeded alert is 9999 on AAPL and must not be "coming up"`,
    { rows: upcomingRows },
  );
}

/**
 * The summary card's level rows come from the market-signal engine, which is an
 * Elite value — so the card is exercised in full only by an Elite reader. A Pro
 * reader legitimately sees fewer rows, which is why the count is recorded on
 * both rather than asserted on either.
 */
async function eliteSummaryCheck(browser) {
  const elite = await createQaUser('elite');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await signIn(page, elite, '/');
    await dismissOverlays(page);
    await page.goto(`${BASE_URL}/stock/AAPL`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await dismissOverlays(page);
    await page.waitForTimeout(4_000);
    const rows = await page.locator('[data-testid="stock-summary-card"] li').allTextContents();
    report.features.push({ id: 'stock-summary-card-elite', rows: rows.length, text: rows.map((row) => row.slice(0, 90)) });
    if (rows.length > 0) {
      await page.locator('[data-testid="stock-summary-card"] li button').first().click();
      await page.waitForTimeout(800);
      /*
        The tab strip marks its selection with the accent border rather than an
        ARIA state, so the selected tab is read the way the reader sees it.
      */
      const activeTab = await page.evaluate(`(() => {
        const buttons = [...document.querySelectorAll('main button')];
        const selected = buttons.find((button) => (button.className || '').includes('border-[var(--accent)]'));
        return selected ? selected.textContent.trim() : null;
      })()`);
      report.features.push({ id: 'stock-summary-navigates', tab: activeTab });
      check(activeTab === 'Chart', 'a summary row did not move the reader to its section', activeTab);
    }
  } finally {
    await context.close();
  }
}

async function entitlementChecks(context, user) {
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/tools`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await dismissOverlays(page);
  const cards = await page.locator('[data-testid^="tool-card-"]').evaluateAll((nodes) => nodes.map((node) => ({
    id: node.getAttribute('data-testid'),
    capability: node.getAttribute('data-capability'),
    requiredTier: node.getAttribute('data-required-tier'),
    locked: node.getAttribute('data-locked'),
  })));
  report.entitlement.push({ tier: user.tier, cards });
  const byId = Object.fromEntries(cards.map((card) => [card.id, card]));
  check(byId['tool-card-stock-planner']?.requiredTier === 'pro', 'Stock Planner no longer requires Pro', cards);
  check(byId['tool-card-what-if']?.requiredTier === 'pro', 'What-If no longer requires Pro', cards);
  check(byId['tool-card-monte-carlo']?.requiredTier === 'elite', 'Monte Carlo no longer requires Elite', cards);
  if (user.tier === 'pro') {
    check(byId['tool-card-monte-carlo']?.locked === 'true', 'Monte Carlo is not locked for a Pro reader', cards);
    check(byId['tool-card-stock-planner']?.locked === 'false', 'Stock Planner is locked for a Pro reader', cards);
  }
  const headings = await page.locator('main h2, div > section > h2').allTextContents();
  report.entitlement.push({ headings });
  await page.close();
}

async function run() {
  /*
    THE ACCOUNTS ARE CREATED INSIDE THE TRY.

    They used to be made above it, so a failure in `seedAccount` — or in
    `chromium.launch`, which needs a browser binary that is not always there —
    leaked the Pro reader before the `finally` existed to catch it. The two
    steps most likely to fail early are exactly the two that used to run
    unprotected.
  */
  let browser = null;
  try {
    const user = await createQaUser('pro');
    await seedAccount(user);
    browser = await chromium.launch({ executablePath: BROWSER, headless: true });
    for (const viewport of VIEWPORTS) {
      for (const appearance of ['dark', 'light']) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          isMobile: viewport.mobile,
          hasTouch: viewport.mobile,
          deviceScaleFactor: viewport.mobile ? 3 : 1,
        });
        /*
          Only the stored preference is seeded. The pre-paint bootstrap in the
          app is what stamps `data-appearance`, and writing it here ran before
          the document existed — which is a fault in the harness, not the page.
        */
        await context.addInitScript(([key, value]) => {
          window.localStorage.setItem(key, JSON.stringify({ state: { appearance: value }, version: 0 }));
        }, [THEME_STORAGE_KEY, appearance]);
        const page = await context.newPage();
        await signIn(page, user, '/');
        await dismissOverlays(page);
        for (const surface of SURFACES) await visit(page, surface, viewport, appearance);
        if (viewport.name === '390x844' && appearance === 'dark') {
          await featureChecks(page);
          await entitlementChecks(context, user);
          await eliteSummaryCheck(browser);
        }
        await context.close();
      }
    }
  } finally {
    if (browser) await browser.close();
    /*
      TEARDOWN RUNS WHATEVER HAPPENED. A red assertion, a thrown fixture, a
      missing browser — none of them is a reason to leave two accounts in a
      database. `--keep` is the only way past it, and it prints what it left so
      the ids are in the log rather than in somebody's memory.
    */
    if (KEEP) {
      report.teardown = { kept: true, accounts: createdUsers };
      console.log(`\n--keep: leaving ${createdUsers.length} account(s) in place:`);
      for (const account of createdUsers) console.log(`  ${account.tier.padEnd(5)} ${account.email} (${account.userId})`);
    } else {
      report.teardown = await teardownAccounts();
      /*
        A teardown that could not finish is a FAILURE of the run. The whole
        point is that nothing is left behind; reporting the surfaces as green
        while two accounts survive is the state this change exists to end.
      */
      if (report.teardown.remaining.length > 0 || report.teardown.failed.length > 0) {
        report.failures.push(`teardown left ${report.teardown.remaining.length} account(s) behind`);
      }
    }
    report.finishedAt = new Date().toISOString();
    writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      failures: report.failures,
      surfaces: report.surfaces.length,
      features: report.features,
      entitlement: report.entitlement,
      teardown: report.teardown,
    }, null, 2));
  }
  if (report.failures.length > 0) process.exitCode = 1;
}

await run();
