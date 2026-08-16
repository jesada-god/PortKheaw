/**
 * Market Dashboard Info buttons — one QA run over the behaviour contract.
 *
 * The two section Info affordances used to fail in opposite directions, and
 * neither failure is reachable from jsdom: the industry one was a `title`
 * attribute, which a real browser shows on hover and a phone never shows at
 * all, and the breadth one was a CSS `group-hover`/`group-focus-within` panel,
 * which a real tap left stuck open. So this run drives a real Chrome at a
 * desktop and a touch viewport and checks the same eight things at both.
 *
 * Both sections live inside the "ข้อมูลเชิงลึกของตลาด" disclosure, which the run
 * opens first — the Info panels must still be closed after it does.
 *
 * Signed-out is enough: the overview renders both sections for any visitor.
 *
 *   QA_BASE_URL=https://… node scripts/qa/dashboard-info-qa.mjs
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE_URL = (process.env.QA_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const BROWSER = process.env.QA_BROWSER_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT_DIR = '.qa/artifacts/dashboard-info';
mkdirSync(OUT_DIR, { recursive: true });

/*
 * 390 and 430 are both here on purpose: the breadth badge row wraps at 390 and
 * does not at 430, which moves its Info trigger from the left edge to the middle
 * of the row and flips which side an anchored panel would overflow.
 */
const VIEWPORTS = [
  { name: 'desktop-1440x900', width: 1440, height: 900, mobile: false },
  { name: 'mobile-390x844', width: 390, height: 844, mobile: true },
  { name: 'mobile-430x932', width: 430, height: 932, mobile: true },
];

const INFOS = [
  {
    testId: 'industry-info',
    label: 'ข้อมูลอุตสาหกรรมเด่นวันนี้',
    heading: 'อุตสาหกรรมเด่นวันนี้',
    expect: 'อย่างน้อย 5 ตัวต่อกลุ่ม',
  },
  {
    testId: 'breadth-info',
    label: 'ข้อมูลภาพรวมแรงซื้อแรงขาย',
    heading: 'ภาพรวมแรงซื้อแรงขาย',
    expect: 'previous regular close',
  },
];

/* The gateway socket and third-party logo hosts are properties of the QA
   environment, not of the interaction under test. */
const ENVIRONMENTAL_CONSOLE = /market-ws|ws:\/\/|ERR_CONNECTION_REFUSED|Failed to load resource|favicon/;

const report = { baseUrl: BASE_URL, startedAt: new Date().toISOString(), checks: [], failures: [] };

function check(condition, message, details = null) {
  report.checks.push({ message, ok: Boolean(condition), details });
  if (!condition) report.failures.push({ message, details });
  return Boolean(condition);
}

const panel = (page, testId) => page.locator(`[data-testid="${testId}-panel"]`);
const trigger = (page, testId) => page.locator(`[data-testid="${testId}-trigger"]`);

/** Opens the affordance the way the reader does: a tap on touch, a click otherwise. */
async function press(page, locator, mobile) {
  await locator.scrollIntoViewIfNeeded();
  if (mobile) await locator.tap();
  else await locator.click();
  await page.waitForTimeout(120);
}

async function runViewport(browser, viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
    deviceScaleFactor: viewport.mobile ? 3 : 1,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !ENVIRONMENTAL_CONSOLE.test(message.text())) {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  const at = (message) => `[${viewport.name}] ${message}`;

  try {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});

    const insights = page.locator('summary', { hasText: 'ข้อมูลเชิงลึกของตลาด' }).first();
    await insights.waitFor({ state: 'visible', timeout: 30_000 });
    await press(page, insights, viewport.mobile);

    // Breadth arrives from a refresh fired on mount; its Info only exists with data.
    await trigger(page, 'breadth-info').waitFor({ state: 'attached', timeout: 45_000 }).catch(() => {});

    for (const info of INFOS) {
      const found = await trigger(page, info.testId).count();
      if (!check(found === 1, at(`${info.heading}: exactly one Info trigger`), { found })) continue;

      const button = trigger(page, info.testId);
      check(
        await button.evaluate((node) => node.tagName === 'BUTTON' && node.type === 'button'),
        at(`${info.heading}: the Info affordance is a real <button>`),
      );
      check(
        (await button.getAttribute('aria-label')) === info.label,
        at(`${info.heading}: aria-label is "${info.label}"`),
        { actual: await button.getAttribute('aria-label') },
      );
      // 1 — closed on load.
      check(await panel(page, info.testId).count() === 0, at(`${info.heading}: closed on load`));
      // The old hover-only affordances must be gone.
      check(
        await button.evaluate((node) => !node.closest('[title]') && !node.hasAttribute('title')),
        at(`${info.heading}: no native title tooltip left behind`),
      );

      // Hover alone must not open it — the panel is a tap affordance on every device.
      if (!viewport.mobile) {
        await button.hover();
        await page.waitForTimeout(300);
        check(await panel(page, info.testId).count() === 0, at(`${info.heading}: hover does not open it`));
      }

      // 2/4 — a press opens it, with its own explanation.
      await press(page, button, viewport.mobile);
      const opened = await panel(page, info.testId).count() === 1
        && await panel(page, info.testId).isVisible();
      check(opened, at(`${info.heading}: a press opens the panel`));
      if (opened) {
        const text = (await panel(page, info.testId).textContent()) ?? '';
        check(text.includes(info.expect), at(`${info.heading}: shows its own explanation`), { text });
        check(
          (await button.getAttribute('aria-expanded')) === 'true',
          at(`${info.heading}: aria-expanded flips to true`),
        );
        const box = await panel(page, info.testId).boundingBox();
        check(
          box !== null && box.x >= -1 && box.x + box.width <= viewport.width + 1,
          at(`${info.heading}: the panel stays inside the viewport`),
          box,
        );
        // The other Info must not have been opened with it.
        const other = INFOS.find((candidate) => candidate.testId !== info.testId);
        check(
          await panel(page, other.testId).count() === 0,
          at(`${info.heading}: opening it leaves ${other.heading} closed`),
        );
        await page.screenshot({
          path: `${OUT_DIR}/${viewport.name}-${info.testId}-open.png`,
          fullPage: false,
        });
      }

      // 3/5 — a second press closes it.
      await press(page, button, viewport.mobile);
      check(await panel(page, info.testId).count() === 0, at(`${info.heading}: a second press closes it`));
      check(
        (await button.getAttribute('aria-expanded')) === 'false',
        at(`${info.heading}: aria-expanded flips back to false`),
      );

      // 6 — a press outside closes it. The section heading is outside the
      // wrapper and navigates nowhere.
      await press(page, button, viewport.mobile);
      check(await panel(page, info.testId).count() === 1, at(`${info.heading}: reopens after closing`));
      await press(page, page.locator('h2', { hasText: info.heading }).first(), viewport.mobile);
      check(await panel(page, info.testId).count() === 0, at(`${info.heading}: an outside press closes it`));

      // 7 — Escape closes it, hands focus back, and does not collapse the
      // enclosing disclosure the reader opened to get here.
      await press(page, button, viewport.mobile);
      check(await panel(page, info.testId).count() === 1, at(`${info.heading}: reopens before Escape`));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(120);
      check(await panel(page, info.testId).count() === 0, at(`${info.heading}: Escape closes it`));
      check(
        await button.evaluate((node) => document.activeElement === node),
        at(`${info.heading}: Escape returns focus to the trigger`),
      );
      check(
        await page.locator('details:has(summary:has-text("ข้อมูลเชิงลึกของตลาด"))').first()
          .evaluate((node) => node.open),
        at(`${info.heading}: Escape leaves the enclosing disclosure open`),
      );

      // The tap target must be reachable by a thumb even where the icon is 18px.
      const target = await button.evaluate((node) => {
        const own = node.getBoundingClientRect();
        const after = getComputedStyle(node, '::after');
        const inset = Number.parseFloat(after.insetBlockStart || '0');
        const grow = Number.isFinite(inset) ? Math.abs(inset) * 2 : 0;
        return { width: own.width + grow, height: own.height + grow };
      });
      check(
        target.width >= 44 && target.height >= 44,
        at(`${info.heading}: tap target is at least 44×44`),
        target,
      );
    }

    // 10 — the rest of the section still works: the retry buttons are intact.
    check(
      await page.locator('button[aria-label="โหลดข้อมูลส่วนนี้ใหม่"]').count() >= 3,
      at('the section refresh buttons are untouched'),
    );
    check(consoleErrors.length === 0, at('no console errors'), consoleErrors);
  } finally {
    await context.close();
  }
}

async function run() {
  const browser = await chromium.launch({ executablePath: BROWSER, headless: true });
  try {
    for (const viewport of VIEWPORTS) await runViewport(browser, viewport);
  } finally {
    await browser.close();
  }
  report.finishedAt = new Date().toISOString();
  writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(report, null, 2));
  for (const entry of report.checks) console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.message}`);
  console.log(`\n${report.checks.length - report.failures.length}/${report.checks.length} checks passed`);
  if (report.failures.length) {
    console.error(JSON.stringify(report.failures, null, 2));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
