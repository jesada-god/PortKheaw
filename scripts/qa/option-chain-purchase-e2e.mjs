/**
 * End-to-end QA for Options Chain -> Portfolio.
 *
 * Drives the real browser through the real production build: sign in, open a
 * symbol's Analysis tab, add a live contract to an Options portfolio from the
 * chain, and then read the ledger back out of the database to prove the row that
 * landed is the row the reader was shown.
 *
 * The run also probes the database routine directly with the reader's own token,
 * because three of its guarantees — the cash check, idempotent replay, and the
 * refusal of a replay that carries different terms — are enforced in the database
 * and a disabled button in the browser proves none of them.
 *
 * Everything is done as a disposable account created for the run and deleted at
 * the end, so nothing here touches a real reader's portfolio.
 *
 * Usage:
 *   node --env-file-if-exists=.env.local scripts/qa/option-chain-purchase-e2e.mjs
 *
 * Environment:
 *   QA_BASE_URL     the server under test (default http://localhost:3100)
 *   QA_SYMBOL       the underlying to trade (default AAPL)
 *   QA_LABEL        names the artifact directory (default runtime)
 *   QA_BROWSER_PATH path to Chrome
 */
import { chromium } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { assertQaTarget, createQaAccounts, qaOwner } from './qa-accounts.mjs';

const BASE_URL = (process.env.QA_BASE_URL ?? 'http://localhost:3100').replace(/\/$/, '');
const SYMBOL = (process.env.QA_SYMBOL ?? 'AAPL').toUpperCase();
const QA_LABEL = process.env.QA_LABEL ?? 'runtime';
const BROWSER = process.env.QA_BROWSER_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const OUT_DIR = `.qa/artifacts/option-chain-purchase-${QA_LABEL}`;
if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY) throw new Error('Missing Supabase QA environment');

/* Creates a real reader — see `scripts/qa/qa-accounts.mjs`. */
assertQaTarget(SUPABASE_URL, 'qa:option-chain-purchase');
const qaAccounts = createQaAccounts({ url: SUPABASE_URL, serviceKey: SERVICE_KEY, label: 'qa:option-chain-purchase' });
mkdirSync(OUT_DIR, { recursive: true });

const OPENING_CASH = 50_000;
const CONTRACT_MULTIPLIER = 100;

const report = {
  baseUrl: BASE_URL,
  symbol: SYMBOL,
  startedAt: new Date().toISOString(),
  account: {},
  chain: {},
  purchases: [],
  ledger: {},
  portfolioUi: {},
  viewports: [],
  basicPaywall: {},
  databaseGate: {},
  cleanup: {},
  failures: [],
};

const check = (condition, message, details = null) => {
  if (!condition) report.failures.push({ message, details });
  return Boolean(condition);
};

let browser;
let userId;
let email;
let password;
let accessToken;
let portfolioId;

async function supabase(path, init = {}, key = SERVICE_KEY) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${init.token ?? key}`, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, ok: response.ok, body };
}

async function rpc(name, body, token = accessToken) {
  return supabase(`/rest/v1/rpc/${name}`, {
    method: 'POST',
    token,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, ANON_KEY);
}

// ---------------------------------------------------------------------------
// The disposable account, and the portfolio it will buy into
// ---------------------------------------------------------------------------

async function createQaAccount() {
  email = `option.chain.purchase.qa.${Date.now()}@example.com`;
  password = `Qa!${randomUUID()}Aa7`;
  const created = await supabase('/auth/v1/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: 'Option Chain Purchase E2E', qa_owner: qaOwner('option-chain-purchase-e2e') },
    }),
  });
  if (!created.ok) throw new Error(`Could not create the QA account: ${created.status}`);
  userId = created.body.id;
  qaAccounts.register({ userId, email });

  // The signup trigger writes the subscription row; wait for it rather than race it.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const rows = await supabase(`/rest/v1/user_subscriptions?user_id=eq.${userId}&select=user_id`);
    if (Array.isArray(rows.body) && rows.body.length === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const now = Date.now();
  const granted = await supabase(`/rest/v1/user_subscriptions?user_id=eq.${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      tier: 'elite', status: 'active', trial_started_at: null, trial_ends_at: null, trial_used_at: null,
      /*
       * The database honours a paid tier only when the row also carries a
       * trusted billing mode — `resolve_effective_subscription_tier` reads
       * `billing_provider_mode in ('test','live')` before it will return
       * anything but 'basic'. Without this the account looks Elite in the table
       * and Basic at every gate, and the run fails on an entitlement refusal
       * that has nothing to do with the feature under test.
       */
      billing_provider: 'stripe', billing_provider_mode: 'test',
      current_period_start: new Date(now - 60_000).toISOString(),
      current_period_end: new Date(now + 30 * 86_400_000).toISOString(),
      cancel_at_period_end: false,
    }),
  });
  if (!granted.ok) throw new Error(`Could not grant the QA tier: ${granted.status} ${JSON.stringify(granted.body)}`);

  const session = await supabase('/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }, ANON_KEY);
  if (!session.ok) throw new Error(`Could not mint a QA session: ${session.status}`);
  accessToken = session.body.access_token;
  report.account = { userId, email, tier: 'elite' };
}

async function seedOptionsPortfolio() {
  const created = await rpc('create_portfolio', { input_name: 'QA Options Chain', input_type: 'OPTION' });
  if (!created.ok) throw new Error(`Could not create the QA portfolio: ${created.status} ${JSON.stringify(created.body)}`);
  portfolioId = created.body;

  const deposit = await rpc('create_portfolio_ledger_transaction', {
    input_portfolio_id: portfolioId,
    input_type: 'deposit',
    input_symbol: null,
    input_quantity: null,
    input_price: null,
    input_amount: OPENING_CASH,
    input_fee: null,
    input_original_currency: 'USD',
    input_fx_rate_at_transaction: null,
    input_occurred_at: new Date(Date.now() - 3_600_000).toISOString(),
    input_broker: null,
    input_underlying_symbol: null,
    input_contract_symbol: null,
    input_option_kind: null,
    input_option_side: null,
    input_strike_price: null,
    input_expiration_date: null,
    input_multiplier: null,
    input_note: 'QA opening cash',
    input_idempotency_key: randomUUID(),
  });
  if (!deposit.ok) throw new Error(`Could not seed cash: ${deposit.status} ${JSON.stringify(deposit.body)}`);

  const balance = await rpc('portfolio_cash_balance_usd', { target_portfolio: portfolioId }, SERVICE_KEY);
  check(Number(balance.body) === OPENING_CASH, 'Seeded cash balance is not the opening deposit', balance.body);
  report.account.portfolioId = portfolioId;
  report.account.openingCash = Number(balance.body);
}

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

async function openBrowser() {
  browser = await chromium.launch({ executablePath: BROWSER, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page = await context.newPage();
  /*
   * `useAppActive` gates every market fetch on `document.hasFocus()`, which is
   * false in a headless window — without this the chain never loads and the run
   * would read as a product failure.
   */
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });

  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // The market socket points at the Railway gateway, which a local build has no
    // entitlement to reach. Its retries are environment, not the feature under test.
    if (text.includes('[market-ws]') || text.includes('/ws')) return;
    report.chain.consoleErrors = [...(report.chain.consoleErrors ?? []), text];
  });
  page.on('response', async (response) => {
    if (!response.url().includes('/api/market/options/')) return;
    const body = await response.text().catch(() => '');
    report.chain.optionsRequests = [...(report.chain.optionsRequests ?? []), {
      url: response.url().replace(BASE_URL, ''),
      status: response.status(),
      error: (() => { try { return JSON.parse(body)?.error ?? null; } catch { return null; } })(),
      contracts: (() => { try { return JSON.parse(body)?.data?.contracts?.length ?? null; } catch { return null; } })(),
    }];
  });
  return page;
}

async function signIn(page) {
  await page.goto(`${BASE_URL}/auth/sign-in?next=${encodeURIComponent(`/stock/${SYMBOL}`)}`, {
    waitUntil: 'domcontentloaded', timeout: 60_000,
  });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/auth/sign-in'), { timeout: 60_000, waitUntil: 'commit' }),
    page.locator('form button[type="submit"]').click(),
  ]);
  const hydrated = await page.waitForFunction(() => typeof window.next !== 'undefined', null, { timeout: 60_000 })
    .then(() => true).catch(() => false);
  check(hydrated, 'The page never hydrated; a stale build manifest is being served');
}

async function openChain(page) {
  await page.goto(`${BASE_URL}/stock/${SYMBOL}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => typeof window.next !== 'undefined', null, { timeout: 60_000 });

  // The tab bar only answers once React has hydrated, so click until it takes.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.getByRole('button', { name: 'Analysis', exact: true }).click({ timeout: 15_000 }).catch(() => {});
    const opened = await page.locator('[data-testid="options-chain-panel"]')
      .waitFor({ timeout: 3_000 }).then(() => true).catch(() => false);
    if (opened) break;
  }
  const panel = page.locator('[data-testid="options-chain-panel"]');
  check(await panel.count() === 1, 'The Options Chain panel never opened');

  /*
   * The panel loads expirations and then waits: nothing is fetched until a
   * reader picks one, which is the beginner flow rather than a stall. Choose the
   * first expiry at least three weeks out — a same-week contract can be a
   * penny-wide, quote-less strip that would refuse the purchase for reasons that
   * have nothing to do with the path under test.
   */
  const expirations = page.locator('select[aria-label="วันหมดอายุออปชัน"]');
  await expirations.waitFor({ timeout: 60_000 });
  const offered = (await expirations.locator('option').evaluateAll(
    (options) => options.map((option) => option.value).filter(Boolean),
  ));
  const horizon = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
  const chosen = offered.find((value) => value >= horizon) ?? offered.at(-1);
  report.chain.expiration = chosen;
  check(Boolean(chosen), 'The panel offered no expirations', offered);
  await expirations.selectOption(chosen);

  const rendered = await page.locator('[data-testid="options-strike-row"]').first()
    .waitFor({ timeout: 180_000 }).then(() => true).catch(() => false);
  const rows = await page.locator('[data-testid="options-strike-row"]').count();
  report.chain.strikeRows = rows;
  if (!rendered) {
    // Say what the panel says. A provider refusal and a broken panel look the
    // same from a timed-out locator, and they are not the same finding.
    report.chain.panelText = await panel.innerText().catch(() => null);
    await page.screenshot({ path: `${OUT_DIR}/chain-not-rendered.png`, fullPage: false }).catch(() => {});
  }
  check(rows > 0, 'The chain rendered no strike rows', report.chain.panelText);
  return rows > 0;
}

/** The first contract on `side` whose Add button is live, with the contract it names. */
async function chooseContract(page, side) {
  const buttons = page.locator(`[data-testid="option-add-to-portfolio-${side}"]`);
  const total = await buttons.count();
  check(total > 0, `No ${side} contract offered an add-to-portfolio control`);
  const button = buttons.first();
  const cell = page.locator(`[data-testid="option-cell-${side}"]`).first();
  const contractSymbol = (await cell.locator('[data-testid="option-contract-symbol"]').first().innerText()).trim();
  report.chain[`${side}ContractSymbol`] = contractSymbol;
  await button.scrollIntoViewIfNeeded();
  await button.click();
  await page.locator('[data-testid="option-portfolio-sheet"]').waitFor({ timeout: 30_000 });
  return contractSymbol;
}

const moneyToNumber = (text) => Number(String(text).replace(/[^0-9.-]/g, ''));
const firstLine = (text) => String(text ?? '').split('\n')[0].trim();

async function readSheet(page) {
  const sheet = page.locator('[data-testid="option-portfolio-sheet"]');
  const text = await sheet.innerText();
  const price = await sheet.locator('input[type="number"]').nth(1).inputValue();
  const contracts = await sheet.locator('input[type="number"]').first().inputValue();
  const values = await sheet.locator('dd').allInnerTexts();
  const submit = sheet.locator('button[type="submit"]');
  return {
    text,
    price,
    contracts,
    values,
    submitDisabled: await submit.isDisabled(),
    cost: moneyToNumber(values.at(-4) ?? ''),
    cashAfter: moneyToNumber(values.at(-1) ?? ''),
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** Every buy_to_open row the QA portfolio holds, newest first. */
async function ledgerRows() {
  const rows = await supabase(
    `/rest/v1/portfolio_transactions?portfolio_id=eq.${portfolioId}&transaction_type=eq.buy_to_open&select=*&order=created_at.asc`,
  );
  return Array.isArray(rows.body) ? rows.body : [];
}

/**
 * One purchase, from the chain button to the row it wrote.
 *
 * `cashBefore` is passed in rather than read here because the second purchase
 * must reconcile against what the first one left, not against the opening
 * deposit — that is the arithmetic a second buy can break.
 */
async function purchaseOneContract(page, side, cashBefore, rowsBefore) {
  const contractSymbol = await chooseContract(page, side);
  const sheet = await readSheet(page);
  const record = {
    side,
    contractSymbol,
    contracts: sheet.contracts,
    price: sheet.price,
    cost: sheet.cost,
    cashAfter: sheet.cashAfter,
    submitDisabled: sheet.submitDisabled,
  };
  report.purchases = [...(report.purchases ?? []), record];

  check(sheet.text.includes(contractSymbol), `The ${side} sheet does not name the contract that was clicked`, contractSymbol);
  check(Number(sheet.contracts) === 1, `The ${side} sheet did not default to one contract`, sheet.contracts);
  check(Number(sheet.price) > 0, `The ${side} sheet did not prefill a positive Ask`, sheet.price);
  check(sheet.text.includes('Multiplier') && sheet.text.includes(String(CONTRACT_MULTIPLIER)),
    `The ${side} sheet does not state the standard multiplier`, sheet.values);

  const expectedCost = Number(sheet.price) * CONTRACT_MULTIPLIER * Number(sheet.contracts);
  check(Math.abs(sheet.cost - expectedCost) < 0.01,
    `The ${side} sheet cost is not contracts x multiplier x price`, { shown: sheet.cost, expected: expectedCost });
  check(Math.abs(sheet.cashAfter - (cashBefore - expectedCost)) < 0.01,
    `The ${side} sheet cash-after does not reconcile with the cash on hand`,
    { shown: sheet.cashAfter, expected: cashBefore - expectedCost });

  if (sheet.submitDisabled) {
    /*
     * A refusal here is a real product answer, not a harness fault. Record the
     * sheet's own words: "ตลาดปิด" and "ราคาเก่าเกินไป" are different findings and
     * only one of them is a defect.
     */
    record.refusal = sheet.text.split('\n').filter((line) => line.includes('ราคา') || line.includes('ตลาด') || line.includes('พอร์ต')).slice(-3);
    check(false, `The ${side} sheet refused the purchase; see purchases[].refusal`, record.refusal);
    await page.screenshot({ path: `${OUT_DIR}/${side}-refused.png`, fullPage: false }).catch(() => {});
    return null;
  }

  await page.screenshot({ path: `${OUT_DIR}/${side}-sheet-before-confirm.png`, fullPage: false });
  await page.locator('[data-testid="option-portfolio-sheet"] button[type="submit"]').click();
  const confirmed = await page.getByText('เพิ่มออปชันเข้าพอร์ตแล้ว').waitFor({ timeout: 60_000 })
    .then(() => true).catch(() => false);
  record.toastShown = confirmed;
  check(confirmed, `No success toast appeared after confirming the ${side} purchase`);
  // The sheet closing is the client half of the refresh: the dialog is dismissed
  // by the success path itself, which is also what calls router.refresh().
  record.sheetClosed = await page.locator('[data-testid="option-portfolio-sheet"]')
    .waitFor({ state: 'detached', timeout: 30_000 }).then(() => true).catch(() => false);
  check(record.sheetClosed, `The ${side} sheet stayed open after a successful purchase`);
  await page.screenshot({ path: `${OUT_DIR}/${side}-after-confirm.png`, fullPage: false });

  // ---------------------------------------------------------------------
  // What actually landed in the ledger
  // ---------------------------------------------------------------------
  const rows = await ledgerRows();
  const written = rows.filter((row) => row.contract_symbol === contractSymbol);
  record.ledgerRowsForContract = written.length;
  record.ledgerRowsTotal = rows.length;
  // One click, one row — the assertion a double submit or a retried action breaks.
  check(written.length === 1, `The ${side} purchase did not create exactly one ledger row`, written.length);
  check(rows.length === rowsBefore + 1, `The ${side} purchase changed the ledger by more than one row`,
    { before: rowsBefore, after: rows.length });

  const row = written[0];
  if (row) {
    record.ledgerRow = {
      transactionType: row.transaction_type,
      contractSymbol: row.contract_symbol,
      underlyingSymbol: row.underlying_symbol,
      optionKind: row.option_kind,
      optionSide: row.option_side,
      quantity: row.quantity,
      multiplier: row.multiplier,
      price: row.normalized_price_usd,
      strike: row.strike_price,
      expiration: row.expiration_date,
      occurredAt: row.occurred_at,
      note: row.note,
    };
    check(row.option_kind === side, `The ledger row is not a ${side}`, row.option_kind);
    check(row.option_side === 'long', 'The ledger row is not a long position', row.option_side);
    check(row.underlying_symbol === SYMBOL, 'The ledger row names a different underlying', row.underlying_symbol);
    check(Number(row.multiplier) === CONTRACT_MULTIPLIER, 'The ledger row does not carry the standard multiplier', row.multiplier);
    check(Number(row.quantity) === Number(sheet.contracts), 'The ledger quantity differs from the sheet', { row: row.quantity, sheet: sheet.contracts });
    check(Math.abs(Number(row.normalized_price_usd) - Number(sheet.price)) < 1e-8, 'The ledger price differs from the sheet', { row: row.normalized_price_usd, sheet: sheet.price });
    check(String(row.note ?? '').includes('Options Chain quote'), 'The ledger row does not record the quote it was priced from', row.note);
  }

  const balance = Number((await rpc('portfolio_cash_balance_usd', { target_portfolio: portfolioId }, SERVICE_KEY)).body);
  record.databaseCashAfter = balance;
  check(Math.abs(balance - (cashBefore - expectedCost)) < 0.01,
    `The derived cash balance does not match what the ${side} sheet promised`,
    { database: balance, sheet: sheet.cashAfter });

  return { contractSymbol, cost: expectedCost, price: Number(sheet.price), cashAfter: balance, rowsAfter: rows.length };
}

/**
 * What the reader sees afterwards, on the page the position actually lives on.
 *
 * A ledger row nobody can find is not a delivered purchase, so this reads the
 * portfolio back through the UI: both contracts as open positions, the cost
 * basis and P&L the ledger implies, and both purchases on the timeline.
 */
async function verifyPortfolioUi(page, bought) {
  await page.goto(`${BASE_URL}/portfolio`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => typeof window.next !== 'undefined', null, { timeout: 60_000 });
  await page.getByRole('tab', { name: 'พอร์ตออปชัน' }).click({ timeout: 30_000 });
  await page.getByRole('button', { name: 'เปิดดู' }).first().click({ timeout: 30_000 });

  const table = page.locator('[data-testid="options-desktop-table"]');
  await table.waitFor({ timeout: 60_000 });
  /*
   * Balances are privacy-masked by default, so every money cell reads `••••••`
   * until this is pressed. Without it the run can confirm the columns exist and
   * nothing about the numbers in them.
   */
  await page.getByRole('button', { name: 'แสดงยอดเงินชั่วคราว' }).first().click({ timeout: 30_000 });
  const tableText = await table.innerText();
  const rowCount = await table.locator('tbody tr').count();
  const cells = await table.locator('tbody tr').evaluateAll(
    (rows) => rows.map((row) => [...row.querySelectorAll('td')].map((cell) => cell.innerText.trim())),
  );

  const timeline = page.locator('[data-testid="portfolio-transaction-timeline"]');
  await timeline.waitFor({ timeout: 30_000 });
  const timelineText = await timeline.innerText();

  report.portfolioUi = {
    positionRows: rowCount,
    columns: await table.locator('thead th').allInnerTexts(),
    rows: cells,
    timelineExcerpt: timelineText.slice(0, 1_200),
  };

  check(rowCount === bought.length, 'The options table does not show both purchased positions',
    { rows: rowCount, expected: bought.length });
  for (const label of ['ต้นทุนคงเหลือ', 'มูลค่าปัจจุบัน', 'Today P&L', 'Unrealized P&L', 'จำนวน']) {
    check(report.portfolioUi.columns.includes(label),
      `The options table does not show ${label}`, report.portfolioUi.columns);
  }
  check(!tableText.includes('••••'), 'The options table stayed privacy-masked, so no number was verified');

  /*
   * Cost basis and P&L, per position. The display currency is a reader
   * preference, so the amounts are checked as a ratio against each other and
   * against the premium paid — which holds in USD or THB — rather than against a
   * hard-coded dollar string that a THB reader would fail.
   */
  for (const purchase of bought) {
    const row = cells.find((columns) => firstLine(columns[3]).includes(purchase.price.toFixed(2)));
    check(Boolean(row), 'No options row carries the premium that was paid', { price: purchase.price, cells });
    if (!row) continue;
    // Several cells stack a value over a caption (the P&L percent, the quote
    // provenance line); the value is always the first line.
    const [, side, quantity, avgPremium, costBasis, , marketValue, , unrealized] = row.map(firstLine);
    check(side === 'LONG', 'The position is not long', side);
    check(Number(quantity) === 1, 'The position does not hold one contract', quantity);
    check(moneyToNumber(avgPremium) === purchase.price, 'Avg premium is not the price paid', { shown: avgPremium, paid: purchase.price });
    // Cost basis is premium x 100 in the same currency the row is rendered in.
    const impliedRate = moneyToNumber(costBasis) / purchase.cost;
    check(Number.isFinite(impliedRate) && impliedRate > 0,
      'The cost basis did not render a number', { costBasis, cost: purchase.cost });
    check(Math.abs(moneyToNumber(costBasis) - moneyToNumber(avgPremium) * CONTRACT_MULTIPLIER) < 0.01,
      'The cost basis is not premium x multiplier', { costBasis, avgPremium });
    check(Number.isFinite(moneyToNumber(marketValue)), 'The position shows no current value', marketValue);
    check(Number.isFinite(moneyToNumber(unrealized)), 'The position shows no unrealized P&L', unrealized);
    report.portfolioUi[`${purchase.contractSymbol}`] = { avgPremium, costBasis, marketValue, unrealized };
  }
  const timelineBuys = (timelineText.match(/Buy to open/gi) ?? []).length;
  report.portfolioUi.timelineBuyToOpen = timelineBuys;
  check(timelineBuys >= bought.length, 'The timeline does not list both purchases',
    { found: timelineBuys, expected: bought.length, excerpt: report.portfolioUi.timelineExcerpt });

  await page.screenshot({ path: `${OUT_DIR}/portfolio-after-purchases.png`, fullPage: true }).catch(() => {});
}

const VIEWPORTS = [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'mobile-320', width: 320, height: 720 },
];

/**
 * The same signed-in reader, at the three widths the product supports.
 *
 * Run on one session rather than three, so this is the *same* Elite account that
 * just bought the two contracts — the positions, cash and P&L it reads are the
 * ones the purchases produced, not a fixture.
 */
async function runViewportSweep(page, bought) {
  report.viewports = [];
  for (const viewport of VIEWPORTS) {
    const mobile = viewport.width < 768;
    const errorsBefore = (report.chain.consoleErrors ?? []).length;
    const result = { ...viewport };
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    // --- The chain, and both sides of it ---
    await page.goto(`${BASE_URL}/stock/${SYMBOL}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForFunction(() => typeof window.next !== 'undefined', null, { timeout: 60_000 });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await page.getByRole('button', { name: 'Analysis', exact: true }).click({ timeout: 15_000 }).catch(() => {});
      if (await page.locator('[data-testid="options-chain-panel"]').count()) break;
    }
    const expirations = page.locator('select[aria-label="วันหมดอายุออปชัน"]');
    await expirations.waitFor({ timeout: 60_000 });
    await expirations.selectOption(report.chain.expiration);
    await page.locator('[data-testid="options-strike-row"]').first().waitFor({ timeout: 180_000 });
    result.callAddButtons = await page.locator('[data-testid="option-add-to-portfolio-call"]').count();
    result.putAddButtons = await page.locator('[data-testid="option-add-to-portfolio-put"]').count();
    check(result.callAddButtons > 0 && result.putAddButtons > 0,
      `Call and Put are not both purchasable at ${viewport.name}`, result);

    // The sheet has to fit the window it opens in — at 320 it is the tightest
    // thing the product renders.
    await page.locator('[data-testid="option-add-to-portfolio-call"]').first().click();
    const sheet = page.locator('[data-testid="option-portfolio-sheet"]');
    await sheet.waitFor({ timeout: 30_000 });
    // The sheet renders its quote first and its cost preview only once the
    // portfolio list has loaded; reading innerText before that reads
    // "กำลังโหลดพอร์ต…" and proves nothing about the layout.
    await sheet.getByText('เงินสดหลังซื้อ').waitFor({ timeout: 30_000 });
    const sheetText = await sheet.innerText();
    result.sheetShowsCost = sheetText.includes('เงินที่ใช้') && sheetText.includes('เงินสดหลังซื้อ');
    result.sheetOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    check(result.sheetShowsCost, `The sheet hides cost or cash-after at ${viewport.name}`, sheetText.slice(0, 400));
    check(!result.sheetOverflow, `The open sheet overflows horizontally at ${viewport.name}`);
    await page.screenshot({ path: `${OUT_DIR}/sheet-${viewport.name}.png`, fullPage: false }).catch(() => {});
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => {});

    // --- The portfolio: cash, P&L, Kheaw, and the responsive layout ---
    await page.goto(`${BASE_URL}/portfolio`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForFunction(() => typeof window.next !== 'undefined', null, { timeout: 60_000 });
    result.kheawVisible = await page.locator('img[alt*="Kheaw"]').first()
      .isVisible({ timeout: 30_000 }).catch(() => false);
    check(result.kheawVisible, `น้อง Kheaw is not shown at ${viewport.name}`);

    await page.getByRole('tab', { name: 'พอร์ตออปชัน' }).click({ timeout: 30_000 });
    await page.getByRole('button', { name: 'เปิดดู' }).first().click({ timeout: 30_000 });
    await page.getByRole('button', { name: 'แสดงยอดเงินชั่วคราว' }).first().click({ timeout: 30_000 });
    const holder = page.locator(mobile ? '[data-testid="options-mobile-cards"]' : '[data-testid="options-desktop-table"]');
    result.responsiveLayout = await holder.isVisible();
    check(result.responsiveLayout,
      `The options list did not use its ${mobile ? 'mobile card' : 'desktop table'} layout at ${viewport.name}`);
    const holderText = await holder.innerText();
    result.showsBothPositions = bought.every((purchase) => holderText.includes(purchase.price.toFixed(2)));
    result.showsPnl = holderText.includes('Unrealized P&L') || holderText.includes('%');
    const pageText = await page.locator('body').innerText();
    result.showsCash = pageText.includes('เงินสด');
    check(result.showsBothPositions, `Both positions are not shown at ${viewport.name}`, holderText.slice(0, 500));
    check(result.showsPnl, `P&L is not shown at ${viewport.name}`);
    check(result.showsCash, `Cash is not shown at ${viewport.name}`);

    result.horizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    check(!result.horizontalOverflow, `The portfolio page overflows horizontally at ${viewport.name}`);
    await page.screenshot({ path: `${OUT_DIR}/portfolio-${viewport.name}.png`, fullPage: true }).catch(() => {});

    result.newConsoleErrors = (report.chain.consoleErrors ?? []).slice(errorsBefore);
    check(result.newConsoleErrors.length === 0, `Console errors at ${viewport.name}`, result.newConsoleErrors);
    report.viewports.push(result);
  }
}

/**
 * The paywall, proved by taking the entitlement away from the account that just
 * used it. Elite success is already established above — this is the other half:
 * the same page, the same reader, one tier lower.
 */
async function runBasicPaywall(page) {
  const downgraded = await supabase(`/rest/v1/user_subscriptions?user_id=eq.${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier: 'basic' }),
  });
  if (!downgraded.ok) {
    check(false, 'Could not downgrade the QA account to Basic', downgraded.body);
    return;
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/stock/${SYMBOL}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => typeof window.next !== 'undefined', null, { timeout: 60_000 });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.getByRole('button', { name: 'Analysis', exact: true }).click({ timeout: 15_000 }).catch(() => {});
    if (await page.locator('[data-testid="options-chain-panel-locked"]').count()) break;
    if (await page.locator('[data-testid="options-chain-panel"]').count()) break;
  }
  const locked = await page.locator('[data-testid="options-chain-panel-locked"]').count();
  const open = await page.locator('[data-testid="options-chain-panel"]').count();
  const addButtons = await page.locator('[data-testid="option-add-to-portfolio-call"]').count();
  report.basicPaywall = { lockedPanels: locked, openPanels: open, addButtons };
  check(locked === 1, 'A Basic account was not shown the Options Chain paywall', report.basicPaywall);
  check(addButtons === 0, 'A Basic account was still offered an add-to-portfolio control', addButtons);
  await page.screenshot({ path: `${OUT_DIR}/basic-paywall.png`, fullPage: false }).catch(() => {});

  /*
   * Put the tier back. The database probes that follow test the purchase
   * routine's own refusals — cash, idempotency, ownership — and a Basic account
   * is refused earlier than any of them, by the entitlement gate. Leaving the
   * downgrade in place would replace four findings with one that is already
   * proved above.
   */
  const restored = await supabase(`/rest/v1/user_subscriptions?user_id=eq.${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier: 'elite' }),
  });
  report.basicPaywall.tierRestored = restored.ok;
  check(restored.ok, 'Could not restore the QA account to Elite after the paywall check', restored.body);
}

/**
 * The browser half. Isolated so a market the provider will not serve stops this
 * and nothing else — the database guarantees below hold regardless of whether a
 * live chain was available, and skipping them would leave the run saying less
 * than it could.
 */
async function runBrowserPurchase() {
  const page = await openBrowser();
  await signIn(page);
  if (!await openChain(page)) return;

  const bought = [];
  let cash = OPENING_CASH;
  let rows = 0;
  // A Call and a Put, in one session, into one portfolio: the two sides price and
  // post differently, and a run that only ever buys a Call proves half the path.
  for (const side of ['call', 'put']) {
    const result = await purchaseOneContract(page, side, cash, rows);
    if (!result) return;
    bought.push(result);
    cash = result.cashAfter;
    rows = result.rowsAfter;
  }

  const symbols = new Set(bought.map((purchase) => purchase.contractSymbol));
  check(symbols.size === bought.length, 'Both purchases landed on the same contract', [...symbols]);
  check(rows === bought.length, 'The ledger holds a duplicate of a purchase', { rows, purchases: bought.length });
  report.ledger = {
    rowCount: rows,
    cashAfter: cash,
    contracts: [...symbols],
  };
  check(Math.abs(cash - (OPENING_CASH - bought.reduce((total, purchase) => total + purchase.cost, 0))) < 0.01,
    'The cash left does not equal the opening deposit less both purchases',
    { cash, opening: OPENING_CASH, spent: bought.reduce((total, purchase) => total + purchase.cost, 0) });

  await verifyPortfolioUi(page, bought);
  await runViewportSweep(page, bought);
  // Last, because it takes the entitlement away and nothing after it could buy.
  await runBasicPaywall(page);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

try {
  await createQaAccount();
  await seedOptionsPortfolio();
  try {
    await runBrowserPurchase();
  } catch (error) {
    report.failures.push({ message: 'The browser purchase threw', details: String(error?.stack ?? error) });
  }

  // -----------------------------------------------------------------------
  // The guarantees the browser cannot demonstrate
  // -----------------------------------------------------------------------
  const cashNow = Number((await rpc('portfolio_cash_balance_usd', { target_portfolio: portfolioId }, SERVICE_KEY)).body);
  /*
   * A synthetic OCC symbol whose root, expiry, kind and strike agree with the
   * other arguments, so the ledger's symbol resolution has nothing to object to
   * and each refusal below is the one being probed.
   */
  const purchase = (overrides = {}) => ({
    input_portfolio_id: portfolioId,
    input_underlying_symbol: SYMBOL,
    input_contract_symbol: `${SYMBOL}260918C00250000`,
    input_option_kind: 'call',
    input_strike_price: 250,
    input_expiration_date: '2026-09-18',
    input_contracts: 1,
    input_purchase_price: 1.5,
    input_occurred_at: new Date().toISOString(),
    input_quote_timestamp: new Date().toISOString(),
    input_idempotency_key: randomUUID(),
    ...overrides,
  });

  // 1. Cash the portfolio does not have is refused inside the transaction.
  const overspend = await rpc('create_portfolio_option_purchase', purchase({
    input_contracts: Math.ceil(cashNow / CONTRACT_MULTIPLIER) + 100,
  }));
  report.databaseGate.insufficientCash = { status: overspend.status, message: overspend.body?.message ?? overspend.body };
  check(String(overspend.body?.message ?? '').includes('INSUFFICIENT_CASH'),
    'A purchase beyond the portfolio cash was not refused', overspend.body);

  /*
   * 2. The same key with the same terms replays to the same row. The terms have
   * to be pinned, not regenerated: the routine compares the stored row field by
   * field, and a second `now()` is a different occurrence — correctly a conflict,
   * not a replay.
   */
  const replayKey = randomUUID();
  const replayTerms = purchase({ input_idempotency_key: replayKey });
  const first = await rpc('create_portfolio_option_purchase', replayTerms);
  const second = await rpc('create_portfolio_option_purchase', replayTerms);
  report.databaseGate.idempotentReplay = { first: first.body, second: second.body, matched: first.body === second.body };
  check(first.ok && first.body, 'The idempotency probe could not create its first row', first.body);
  check(first.body === second.body, 'A replayed purchase created a second row', { first: first.body, second: second.body });

  // 3. The same key with different terms is refused rather than silently ignored.
  const conflict = await rpc('create_portfolio_option_purchase', {
    ...replayTerms, input_contracts: 2,
  });
  report.databaseGate.idempotencyConflict = { status: conflict.status, message: conflict.body?.message ?? conflict.body };
  check(String(conflict.body?.message ?? '').includes('IDEMPOTENCY_CONFLICT'),
    'A key reused with different terms was not refused', conflict.body);

  // 4. A portfolio that is not the caller's is refused on ownership alone.
  const foreign = await rpc('create_portfolio_option_purchase', purchase({ input_portfolio_id: randomUUID() }));
  report.databaseGate.foreignPortfolio = { status: foreign.status, message: foreign.body?.message ?? foreign.body };
  check(String(foreign.body?.message ?? '').includes('Portfolio not found'),
    'A purchase into a portfolio the caller does not own was not refused', foreign.body);

  /*
   * The last word, and deliberately blunt: the database probes above pass on
   * their own, so without this a run that never reached the browser at all would
   * report a clean sheet. A PASS has to mean a reader bought a contract.
   */
  check(report.ledger.rowCount === 2,
    'Both a Call and a Put were not completed through the browser',
    { purchases: report.purchases, ledger: report.ledger });
} catch (error) {
  report.failures.push({ message: 'The run threw', details: String(error?.stack ?? error) });
} finally {
  await browser?.close().catch(() => {});
  /*
    Was a hand-rolled version of the shared teardown: it knew about the ledger
    foreign key (the paragraph that worked it out is now in `qa-accounts.mjs`)
    but only cleared `portfolio_transactions`, leaving the two option children
    that hold the same RESTRICT.
  */
  const teardown = await qaAccounts.teardown();
  report.cleanup.accountDeleted = teardown.remaining.length === 0;
  report.cleanup.teardown = teardown;
  check(teardown.remaining.length === 0, 'The QA account was not deleted', teardown);
  report.finishedAt = new Date().toISOString();
  report.verdict = report.failures.length === 0 ? 'PASS' : 'FAIL';
  writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.verdict === 'FAIL') process.exitCode = 1;
}
