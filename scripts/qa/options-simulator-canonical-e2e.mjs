import { chromium } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE_URL = (process.env.QA_BASE_URL ?? 'https://portkheaw.vercel.app').replace(/\/$/, '');
const EXPECTED_SHA = process.env.QA_EXPECTED_SHA?.toLowerCase() ?? null;
const QA_LABEL = process.env.QA_LABEL ?? 'runtime';
const BROWSER = process.env.QA_BROWSER_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OUT_DIR = `.qa/artifacts/options-simulator-canonical-${QA_LABEL}`;
if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Missing Supabase QA environment');
mkdirSync(OUT_DIR, { recursive: true });

const report = {
  baseUrl: BASE_URL,
  expectedSha: EXPECTED_SHA,
  startedAt: new Date().toISOString(),
  deployment: null,
  network: {},
  fresh: {},
  saved: {},
  runtime: [],
  failures: [],
  cleanup: {},
};

let browser;
let userId;
let email;
let password;

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
  if (!response.ok) throw new Error(`Supabase QA request failed: ${response.status} ${path}`);
  return body;
}

async function createEliteQaUser() {
  email = `options.canonical.qa.${Date.now()}@example.com`;
  password = `Qa!${randomUUID()}Aa7`;
  const created = await supabase('/auth/v1/admin/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: 'Options Canonical E2E', qa_owner: 'codex-options-canonical-e2e' } }),
  });
  userId = created.id;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const rows = await supabase(`/rest/v1/user_subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=user_id`);
    if (Array.isArray(rows) && rows.length === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const now = Date.now();
  await supabase(`/rest/v1/user_subscriptions?user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({
      tier: 'elite', status: 'active', trial_started_at: null, trial_ends_at: null, trial_used_at: null,
      current_period_start: new Date(now - 60_000).toISOString(),
      current_period_end: new Date(now + 30 * 86_400_000).toISOString(),
      cancel_at_period_end: false,
    }),
  });
}

const isoDate = (days) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

async function setInput(page, selector, value) {
  const input = page.locator(selector);
  await input.fill(String(value));
  await input.press('Tab');
}

async function signIn(page) {
  await page.goto(`${BASE_URL}/auth/sign-in?next=${encodeURIComponent('/tools/what-if')}&qa=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/auth/sign-in'), { timeout: 60_000, waitUntil: 'commit' }),
    page.locator('form button[type="submit"]').click(),
  ]);
}

async function chooseSymbol(page) {
  const search = page.locator('[data-validation-path="symbol"]');
  await page.waitForTimeout(750);
  await search.pressSequentially('AAPL', { delay: 35 });
  const option = page.locator('button').filter({ has: page.locator('strong', { hasText: 'AAPL' }) }).first();
  await option.waitFor({ timeout: 15_000 });
  await option.click();
  await setInput(page, '[data-validation-path="underlyingPrice"]', 100);
}

async function enterLongCall(page) {
  await page.getByRole('button', { name: 'ข้อมูลสัญญา', exact: true }).click();
  await page.locator('[data-testid="option-legs-form"]').waitFor();
  await setInput(page, '[data-validation-path="legs.0.quantity"]', 1);
  await setInput(page, '[data-validation-path="legs.0.strike"]', 100);
  await setInput(page, '[data-validation-path="legs.0.expiration"]', isoDate(90));
  const premium = page.locator('[data-validation-path="legs.0.entryPremium"]');
  await premium.focus();
  await premium.press('Control+A');
  await premium.press('Backspace');
  await premium.type('500');
  await premium.press('Tab');
  await setInput(page, '[data-validation-path="legs.0.impliedVolatility"]', 25);
  await setInput(page, '[data-validation-path="legs.0.multiplier"]', 100);
}

async function runWhatIf(page) {
  await page.getByRole('button', { name: 'What-If', exact: true }).click();
  await setInput(page, '[data-validation-path="scenarios.0.targetPrice"]', 110);
  await setInput(page, '[data-validation-path="scenarios.0.valuationDate"]', isoDate(30));
  const responsePromise = page.waitForResponse((response) => response.url().includes('/api/option-simulations/compute/what-if') && response.request().method() === 'POST');
  await page.locator('[data-testid="desktop-calculate-action"] button').click();
  const response = await responsePromise;
  const body = await response.json();
  await page.locator('[data-testid="what-if-results"]').waitFor({ timeout: 60_000 });
  return { status: response.status(), body };
}

async function runMonteCarlo(page) {
  await page.getByRole('button', { name: 'Monte Carlo', exact: true }).click();
  await page.locator('[data-validation-path="monteCarlo.paths"]').selectOption('1000');
  const responsePromise = page.waitForResponse((response) => response.url().includes('/api/option-simulations/compute/monte-carlo') && response.request().method() === 'POST');
  await page.locator('[data-testid="desktop-simulation-action"] button').click();
  const response = await responsePromise;
  const body = await response.json();
  await page.locator('[data-testid="monte-carlo-results"]').waitFor({ timeout: 90_000 });
  return { status: response.status(), body };
}

async function readRuntimeState(page, testId) {
  const section = page.locator(`[data-testid="${testId}"]`);
  const text = await section.innerText();
  const attributes = await section.evaluate((element) => ({
    initialRisk: element.getAttribute('data-initial-risk'),
    maxLoss: element.getAttribute('data-max-loss'),
    returnPct: element.getAttribute('data-return-pct'),
    breakEvenCount: element.getAttribute('data-break-even-count'),
    scoreStatus: element.getAttribute('data-score-status'),
  }));
  const breakEvenText = await section.locator('[data-testid="break-even-values"]').allInnerTexts().catch(() => []);
  return { attributes, breakEvenText, text };
}

function assertCanonical(scope, apiResult, runtimeState, scoreStatus = null) {
  const canonicalSummary = {
    breakEvenPrices: apiResult?.breakEvenPrices,
    initialDebit: apiResult?.initialDebit,
    initialRisk: apiResult?.initialRisk,
    maxLoss: apiResult?.maxLoss,
    returnPct: apiResult?.returnPct,
  };
  check(Array.isArray(apiResult?.breakEvenPrices) && apiResult.breakEvenPrices.length === 1, `${scope}: API break-even count is not one`, canonicalSummary);
  check(Number.isFinite(apiResult?.initialRisk) && apiResult.initialRisk > 0, `${scope}: API initialRisk is not positive`, apiResult?.initialRisk);
  check(Number.isFinite(apiResult?.maxLoss) && apiResult.maxLoss > 0, `${scope}: API maxLoss is not positive`, apiResult?.maxLoss);
  check(Number.isFinite(apiResult?.returnPct), `${scope}: API returnPct is unavailable`, apiResult?.returnPct);
  check(Number(runtimeState.attributes.breakEvenCount) === 1, `${scope}: rendered state break-even count is not one`, runtimeState.attributes);
  check(Number(runtimeState.attributes.initialRisk) === apiResult?.initialRisk, `${scope}: state initialRisk differs from API`, { api: apiResult?.initialRisk, dom: runtimeState.attributes.initialRisk });
  check(Number(runtimeState.attributes.maxLoss) === apiResult?.maxLoss, `${scope}: state maxLoss differs from API`, { api: apiResult?.maxLoss, dom: runtimeState.attributes.maxLoss });
  check(Number(runtimeState.attributes.returnPct) === apiResult?.returnPct, `${scope}: state returnPct differs from API`, { api: apiResult?.returnPct, dom: runtimeState.attributes.returnPct });
  check(runtimeState.breakEvenText.length === 1, `${scope}: DOM does not render exactly one break-even value`, runtimeState.breakEvenText);
  check(!runtimeState.text.includes('คำนวณ % ไม่ได้'), `${scope}: DOM still says percentage is unavailable`);
  check(!runtimeState.text.includes('Score Unavailable'), `${scope}: DOM still says Score Unavailable`);
  if (scoreStatus !== null) {
    check(scoreStatus === 'available', `${scope}: API Scenario Quality Score is unavailable`, scoreStatus);
    check(runtimeState.attributes.scoreStatus === 'available', `${scope}: DOM Scenario Quality Score is unavailable`, runtimeState.attributes.scoreStatus);
  }
}

async function hardReload(page, path) {
  const session = await page.context().newCDPSession(page);
  await session.send('Network.enable');
  await session.send('Network.setCacheDisabled', { cacheDisabled: true });
  await session.send('Network.clearBrowserCache');
  await page.goto(`${BASE_URL}${path}?qa=${Date.now()}`, { waitUntil: 'networkidle', timeout: 60_000 });
}

try {
  await createEliteQaUser();
  browser = await chromium.launch({ executablePath: BROWSER, headless: true, args: ['--disable-extensions', '--disable-background-networking', '--disable-application-cache'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'th-TH', timezoneId: 'Asia/Bangkok', serviceWorkers: 'block', extraHTTPHeaders: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await session.send('Network.enable');
  await session.send('Network.setCacheDisabled', { cacheDisabled: true });
  page.on('console', (message) => { if (message.type() === 'error') report.runtime.push({ type: 'console', text: message.text() }); });
  page.on('pageerror', (error) => report.runtime.push({ type: 'pageerror', text: error.message }));
  page.on('dialog', (dialog) => void dialog.accept());
  await page.route(/\/api\/market\/search(?:\?|$)/, (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [{ symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', currency: 'USD', assetType: 'Stock', status: 'active' }] }) }));
  await page.route('**/api/market/quote/AAPL', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { symbol: 'AAPL', price: 100 }, meta: { provider: 'e2e-fixture', timestamp: new Date().toISOString(), freshness: { status: 'delayed', asOf: new Date().toISOString() } } }) }));

  const versionResponse = await context.request.get(`${BASE_URL}/api/version?qa=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' } });
  report.deployment = { status: versionResponse.status(), body: await versionResponse.json(), headers: versionResponse.headers() };
  if (EXPECTED_SHA) check(report.deployment.body.commitSha === EXPECTED_SHA, 'Production SHA does not match expected commit', report.deployment.body);

  await signIn(page);
  await hardReload(page, '/tools/what-if');
  await chooseSymbol(page);
  await enterLongCall(page);

  const whatIfNetwork = await runWhatIf(page);
  const whatIfState = await readRuntimeState(page, 'what-if-results');
  report.network.whatIf = whatIfNetwork;
  report.fresh.whatIf = whatIfState;
  assertCanonical('fresh What-If', whatIfNetwork.body?.data?.valuation, whatIfState);

  const monteNetwork = await runMonteCarlo(page);
  const monteState = await readRuntimeState(page, 'monte-carlo-results');
  report.network.monteCarlo = monteNetwork;
  report.fresh.monteCarlo = monteState;
  assertCanonical('fresh Monte Carlo', monteNetwork.body?.data?.result, monteState, monteNetwork.body?.data?.scenarioScore?.status);
  await page.screenshot({ path: `${OUT_DIR}/fresh-long-call.png`, fullPage: true });

  const saveResponsePromise = page.waitForResponse((response) => response.url().endsWith('/api/option-simulations') && response.request().method() === 'POST');
  await page.locator('[data-testid="save-simulation-actions"]').getByRole('button', { name: 'บันทึก', exact: true }).click();
  const saveResponse = await saveResponsePromise;
  const savedBody = await saveResponse.json();
  report.network.save = { status: saveResponse.status(), body: savedBody };
  await page.locator('[data-testid="save-simulation-actions"] [role="status"]').filter({ hasText: 'บันทึกแล้ว' }).waitFor({ timeout: 30_000 });

  await hardReload(page, '/tools/what-if');
  const savedCard = page.locator('article').filter({ has: page.locator('strong', { hasText: 'New AAPL simulation' }) }).first();
  await savedCard.waitFor({ timeout: 30_000 });
  await savedCard.getByRole('button', { name: 'เปิด', exact: true }).click();
  await page.locator('[data-testid="what-if-results"]').waitFor({ timeout: 30_000 });
  const savedWhatIfState = await readRuntimeState(page, 'what-if-results');
  const snapshot = savedBody?.data?.resultSnapshot;
  report.saved.whatIf = savedWhatIfState;
  assertCanonical('saved What-If', snapshot?.whatIf, savedWhatIfState);

  await page.getByRole('button', { name: 'Monte Carlo', exact: true }).click();
  await page.locator('[data-testid="monte-carlo-results"]').waitFor({ timeout: 90_000 });
  await page.locator('[data-testid="monte-carlo-results"][data-score-status="available"]').waitFor({ timeout: 90_000 });
  const savedMonteState = await readRuntimeState(page, 'monte-carlo-results');
  report.saved.monteCarlo = savedMonteState;
  assertCanonical('saved Monte Carlo', snapshot?.monteCarlo, savedMonteState, snapshot?.scenarioScore?.status);
  await page.screenshot({ path: `${OUT_DIR}/saved-long-call.png`, fullPage: true });
  check(report.runtime.length === 0, 'Browser runtime emitted errors', report.runtime);
} catch (error) {
  report.failures.push({ message: 'E2E aborted', details: { name: error.name, message: error.message, stack: error.stack } });
} finally {
  if (browser) await browser.close().catch(() => undefined);
  report.cleanup.browserClosed = true;
  if (userId) {
    try {
      await supabase(`/auth/v1/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
      report.cleanup.userDeleted = true;
    } catch (error) {
      report.cleanup.userDeleted = false;
      report.failures.push({ message: 'QA user cleanup failed', details: error.message });
    }
  }
  report.finishedAt = new Date().toISOString();
  writeFileSync(`${OUT_DIR}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
}

if (report.failures.length) {
  console.error(JSON.stringify({ deployment: report.deployment?.body, failures: report.failures, cleanup: report.cleanup }, null, 2));
  process.exitCode = 1;
} else {
  const summarize = (state) => ({
    attributes: state.attributes,
    breakEvenValues: state.breakEvenText,
  });
  console.log(JSON.stringify({
    deployment: report.deployment?.body,
    fresh: {
      whatIf: summarize(report.fresh.whatIf),
      monteCarlo: summarize(report.fresh.monteCarlo),
    },
    saved: {
      whatIf: summarize(report.saved.whatIf),
      monteCarlo: summarize(report.saved.monteCarlo),
    },
    cleanup: report.cleanup,
  }, null, 2));
}
