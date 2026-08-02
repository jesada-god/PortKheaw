import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

function argument(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const baseUrl = argument('base-url').replace(/\/$/, '');
const outputDirectory = argument('output-dir');
const storageStatePath = argument('storage-state');
const storageStateSourceUrl = argument('storage-state-source-url');
const saveStorageStatePath = argument('save-storage-state');
const loginTimeoutMs = Number(argument('login-timeout-ms', '600000'));
const viewportTimeoutMs = Number(argument('viewport-timeout-ms', '300000'));
const createAlert = argument('create-alert', 'true') !== 'false';
const executablePath = argument('chrome-path', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');

if (!baseUrl || !outputDirectory) {
  throw new Error('--base-url and --output-dir are required');
}

mkdirSync(outputDirectory, { recursive: true });

const viewports = [
  { name: 'desktop-1440x900', width: 1440, height: 900 },
  { name: 'mobile-390x844', width: 390, height: 844 },
  { name: 'mobile-320x720', width: 320, height: 720 },
];

const report = {
  baseUrl,
  startedAt: new Date().toISOString(),
  usedStorageState: Boolean(storageStatePath && existsSync(storageStatePath)),
  createdAlert: false,
  viewports: [],
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function storageStateForBaseUrl(path, sourceUrl, targetUrl) {
  if (!path || !existsSync(path)) return undefined;

  const state = JSON.parse(readFileSync(path, 'utf8'));
  if (!sourceUrl || new URL(sourceUrl).origin === new URL(targetUrl).origin) {
    return state;
  }

  const source = new URL(sourceUrl);
  const target = new URL(targetUrl);
  const sourceCookieDomain = source.hostname.replace(/^\./, '');
  const cookies = state.cookies
    .filter((cookie) => cookie.domain.replace(/^\./, '') === sourceCookieDomain)
    .map((cookie) => ({
      ...cookie,
      domain: target.hostname,
      secure: target.protocol === 'https:',
    }));
  const localStorage = state.origins.find((entry) => entry.origin === source.origin)?.localStorage ?? [];

  return {
    cookies,
    origins: localStorage.length ? [{ origin: target.origin, localStorage }] : [],
  };
}

async function withTimeout(label, timeoutMs, operation) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`TIMEOUT: ${label} after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function ensureAuthenticated(page) {
  await page.goto(`${baseUrl}/alerts`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (!new URL(page.url()).pathname.startsWith('/auth/')) return;

  console.log(`AUTH_REQUIRED: headed browser is waiting up to ${Math.round(loginTimeoutMs / 60000)} minutes`);
  const deadline = Date.now() + loginTimeoutMs;
  while (Date.now() < deadline) {
    const current = new URL(page.url());
    if (current.origin === new URL(baseUrl).origin && current.pathname === '/alerts') {
      await page.getByRole('heading', { name: 'การแจ้งเตือนราคา', exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
      console.log('AUTH_READY');
      return;
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error(`TIMEOUT: manual-login after ${loginTimeoutMs}ms`);
}

function collectPageErrors(page) {
  const state = {
    consoleErrors: [],
    pageErrors: [],
    httpErrors: [],
    requestFailures: [],
  };
  page.on('console', (message) => {
    if (message.type() === 'error') state.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => state.pageErrors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) {
      state.httpErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? 'unknown failure';
    if (failure !== 'net::ERR_ABORTED') state.requestFailures.push(`${request.method()} ${request.url()} ${failure}`);
  });
  return state;
}

function resetErrors(errors) {
  errors.consoleErrors.length = 0;
  errors.pageErrors.length = 0;
  errors.httpErrors.length = 0;
  errors.requestFailures.length = 0;
}

async function assertNoOverflow(page, route) {
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  assert(
    dimensions.scrollWidth <= dimensions.clientWidth && dimensions.bodyScrollWidth <= dimensions.clientWidth,
    `${route} has horizontal overflow: ${JSON.stringify(dimensions)}`,
  );
  return dimensions;
}

async function verifyHeaderAndBack(page, viewport) {
  await page.goto(`${baseUrl}/settings`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.goto(`${baseUrl}/alerts`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const title = page.getByRole('heading', { name: 'การแจ้งเตือนราคา', exact: true });
  await title.waitFor({ state: 'visible', timeout: 30_000 });
  assert((await title.textContent()) === 'การแจ้งเตือนราคา', 'alert title is not complete');
  const titleGeometry = await title.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      left: rect.left,
      right: rect.right,
      width: rect.width,
      viewportWidth: document.documentElement.clientWidth,
      visibleAtCenter: Boolean(hit && (hit === element || element.contains(hit))),
      clipped: element.scrollWidth > element.clientWidth,
    };
  });
  assert(!titleGeometry.clipped, `alert title is clipped: ${JSON.stringify(titleGeometry)}`);
  assert(titleGeometry.right <= titleGeometry.viewportWidth, `alert title exits viewport: ${JSON.stringify(titleGeometry)}`);
  assert(titleGeometry.visibleAtCenter, 'alert title is covered by another header control');

  const back = page.getByRole('button', { name: 'ย้อนกลับ', exact: true });
  const backBox = await back.boundingBox();
  assert(backBox && backBox.width >= 44 && backBox.height >= 44, `back target is smaller than 44px: ${JSON.stringify(backBox)}`);
  await back.click();
  await page.waitForURL((url) => url.pathname === '/settings', { timeout: 30_000 });
  await page.goto(`${baseUrl}/alerts`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (viewport.width < 640) {
    assert(!(await page.getByRole('button', { name: 'โปรไฟล์' }).isVisible()), 'secondary profile action should hide on narrow alert header');
  }
  return titleGeometry;
}

async function verifyAlertModal(page, viewport, shouldCreate) {
  await page.getByRole('button', { name: /สร้าง Alert/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: 30_000 });
  const save = dialog.getByRole('button', { name: 'บันทึกการแจ้งเตือน', exact: true });
  const cancel = dialog.getByRole('button', { name: 'ยกเลิก', exact: true });
  const target = dialog.locator('input[inputmode="decimal"]');
  const symbol = dialog.locator('input[placeholder="เช่น AAPL"]');
  assert(await save.isVisible(), 'save button is missing');
  assert(await cancel.isVisible(), 'cancel button is missing');
  assert(await save.isDisabled(), 'save should be disabled while required fields are incomplete');
  assert((await target.inputValue()) === '', 'target price must start empty');
  await target.fill('6');
  assert((await target.inputValue()) === '6', 'typing 6 produced a leading zero');
  await symbol.fill('AAPL');
  assert(!(await save.isDisabled()), 'save stayed disabled after valid input');

  await target.focus();
  const modalGeometry = await page.evaluate(() => {
    const footer = document.querySelector('[data-testid="modal-footer"]');
    const saveButton = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('บันทึกการแจ้งเตือน'));
    const nav = document.querySelector('nav[aria-label="เมนูหลัก"]');
    const footerRect = footer?.getBoundingClientRect();
    const saveRect = saveButton?.getBoundingClientRect();
    const navRect = nav?.getBoundingClientRect();
    const hit = saveRect ? document.elementFromPoint(saveRect.left + saveRect.width / 2, saveRect.top + saveRect.height / 2) : null;
    return {
      viewportHeight: window.visualViewport?.height ?? window.innerHeight,
      footerBottom: footerRect?.bottom ?? null,
      footerTop: footerRect?.top ?? null,
      navTop: navRect?.top ?? null,
      saveHit: Boolean(saveButton && hit && (hit === saveButton || saveButton.contains(hit))),
      bodyOverflowY: document.querySelector('[data-testid="modal-body"]')
        ? getComputedStyle(document.querySelector('[data-testid="modal-body"]')).overflowY
        : null,
    };
  });
  assert(modalGeometry.footerBottom !== null && modalGeometry.footerBottom <= modalGeometry.viewportHeight + 1, `modal footer exits visual viewport: ${JSON.stringify(modalGeometry)}`);
  assert(modalGeometry.saveHit, `modal footer is covered by bottom navigation/overlay: ${JSON.stringify(modalGeometry)}`);
  assert(modalGeometry.bodyOverflowY === 'auto', `modal body is not independently scrollable: ${JSON.stringify(modalGeometry)}`);

  if (shouldCreate) {
    await save.click();
    await dialog.waitFor({ state: 'hidden', timeout: 45_000 });
    await page.getByText('สร้างการแจ้งเตือนแล้ว', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
  } else if (viewport.width === 390) {
    const before = page.url();
    await cancel.click();
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
    assert(page.url() === before, 'cancel navigated away from the alerts page');
  } else {
    const before = page.url();
    await dialog.getByRole('button', { name: 'ปิดหน้าต่าง', exact: true }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
    assert(page.url() === before, 'modal X navigated away from the alerts page');
  }

  return modalGeometry;
}

async function verifySettingsSwitches(page, viewport) {
  await page.goto(`${baseUrl}/settings`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const switches = page.getByRole('switch');
  const count = await switches.count();
  assert(count >= 5, `expected at least 5 shared settings switches, found ${count}`);
  const measurements = [];
  for (let index = 0; index < count; index += 1) {
    const measurement = await switches.nth(index).evaluate((control) => {
      const track = control.getBoundingClientRect();
      const knob = control.querySelector('span')?.getBoundingClientRect();
      const card = control.closest('.rounded-2xl')?.getBoundingClientRect();
      return {
        label: control.getAttribute('aria-label'),
        checked: control.getAttribute('aria-checked'),
        disabled: control.hasAttribute('disabled'),
        track: { left: track.left, right: track.right, top: track.top, bottom: track.bottom, width: track.width, height: track.height },
        knob: knob ? { left: knob.left, right: knob.right, top: knob.top, bottom: knob.bottom } : null,
        card: card ? { left: card.left, right: card.right } : null,
        usesAbsoluteKnob: knob ? getComputedStyle(control.querySelector('span')).position === 'absolute' : null,
      };
    });
    assert(measurement.track.width >= 55 && measurement.track.width <= 57, `switch track width changed: ${JSON.stringify(measurement)}`);
    assert(measurement.track.height >= 43 && measurement.track.height <= 45, `switch track height changed: ${JSON.stringify(measurement)}`);
    assert(measurement.knob && measurement.knob.left >= measurement.track.left && measurement.knob.right <= measurement.track.right, `switch knob exceeds track: ${JSON.stringify(measurement)}`);
    assert(measurement.card && measurement.track.left >= measurement.card.left && measurement.track.right <= measurement.card.right, `switch exceeds settings card: ${JSON.stringify(measurement)}`);
    assert(!measurement.usesAbsoluteKnob, `switch knob uses absolute positioning: ${JSON.stringify(measurement)}`);
    measurements.push(measurement);
  }
  const states = new Set(measurements.map((measurement) => measurement.checked));
  assert(states.has('true') && states.has('false'), `settings did not expose both on/off switch states: ${JSON.stringify(measurements)}`);
  if (viewport.width <= 320) {
    assert(measurements.every((measurement) => measurement.track.right <= viewport.width), 'a 320px switch exits the viewport');
  }
  return measurements;
}

const browser = await chromium.launch({
  executablePath,
  headless: false,
  args: ['--disable-background-networking'],
});

let context;
try {
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ...(storageStatePath && existsSync(storageStatePath)
      ? { storageState: storageStateForBaseUrl(storageStatePath, storageStateSourceUrl, baseUrl) }
      : {}),
  });
  const page = await context.newPage();
  const errors = collectPageErrors(page);
  await ensureAuthenticated(page);
  resetErrors(errors);

  for (let index = 0; index < viewports.length; index += 1) {
    const viewport = viewports[index];
    console.log(`VIEWPORT_START: ${viewport.name}`);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    resetErrors(errors);
    const result = { name: viewport.name, ...viewport };
    try {
      await withTimeout(viewport.name, viewportTimeoutMs, async () => {
        result.header = await verifyHeaderAndBack(page, viewport);
        result.alertsOverflow = await assertNoOverflow(page, '/alerts');
        result.modal = await verifyAlertModal(page, viewport, createAlert && index === 0);
        if (createAlert && index === 0) report.createdAlert = true;
        result.settingsSwitches = await verifySettingsSwitches(page, viewport);
        result.settingsOverflow = await assertNoOverflow(page, '/settings');
        await page.goto(`${baseUrl}/alerts`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        result.finalAlertsOverflow = await assertNoOverflow(page, '/alerts');
        await page.screenshot({ path: join(outputDirectory, `${viewport.name}.png`), fullPage: true });
      });
      result.errors = structuredClone(errors);
      const errorCount = errors.consoleErrors.length + errors.pageErrors.length + errors.httpErrors.length + errors.requestFailures.length;
      assert(errorCount === 0, `browser errors detected: ${JSON.stringify(errors)}`);
      result.ok = true;
      console.log(`VIEWPORT_PASS: ${viewport.name}`);
      report.viewports.push(result);
    } catch (error) {
      result.ok = false;
      result.error = error instanceof Error ? error.message : String(error);
      result.errors = structuredClone(errors);
      report.viewports.push(result);
      await page.screenshot({ path: join(outputDirectory, `${viewport.name}-failure.png`), fullPage: true }).catch(() => undefined);
      writeFileSync(join(outputDirectory, 'qa-report.json'), JSON.stringify(report, null, 2));
      console.error(`VIEWPORT_FAIL: ${viewport.name}: ${result.error}`);
      throw error;
    }
  }

  if (saveStorageStatePath) {
    await context.storageState({ path: saveStorageStatePath });
  }
  report.completedAt = new Date().toISOString();
  writeFileSync(join(outputDirectory, 'qa-report.json'), JSON.stringify(report, null, 2));
  console.log(`QA_PASS: ${report.viewports.length} viewports; createdAlert=${report.createdAlert}`);
} finally {
  await context?.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
}
