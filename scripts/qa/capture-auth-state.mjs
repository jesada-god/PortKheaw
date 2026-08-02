import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright-core';

function argument(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const baseUrl = argument('base-url').replace(/\/$/, '');
const outputDirectory = argument('output-dir');
const profileDirectory = argument('profile-dir');
const storageStatePath = argument('storage-state');
const loginTimeoutMs = Number(argument('login-timeout-ms', '600000'));
const executablePath = argument('chrome-path', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');

if (!baseUrl || !outputDirectory || !profileDirectory || !storageStatePath) {
  throw new Error('--base-url, --output-dir, --profile-dir, and --storage-state are required');
}

mkdirSync(outputDirectory, { recursive: true });
mkdirSync(profileDirectory, { recursive: true });
mkdirSync(dirname(storageStatePath), { recursive: true });

const context = await chromium.launchPersistentContext(profileDirectory, {
  executablePath,
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: ['--disable-background-networking'],
});

const startedAt = new Date().toISOString();
let page;
try {
  page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${baseUrl}/alerts`, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  const deadline = Date.now() + loginTimeoutMs;
  console.log(`AUTH_REQUIRED: headed Chrome is waiting up to ${Math.round(loginTimeoutMs / 60000)} minutes`);
  while (Date.now() < deadline) {
    const current = new URL(page.url());
    if (current.origin === new URL(baseUrl).origin && current.pathname === '/alerts') {
      await page.waitForTimeout(1_000);
      const confirmed = new URL(page.url());
      if (confirmed.origin === current.origin && confirmed.pathname === '/alerts') {
        await context.storageState({ path: storageStatePath });
        writeFileSync(
          join(outputDirectory, 'auth-capture-report.json'),
          JSON.stringify(
            {
              baseUrl,
              startedAt,
              completedAt: new Date().toISOString(),
              storageStateSaved: existsSync(storageStatePath),
            },
            null,
            2,
          ),
        );
        console.log('AUTH_READY: session verified and storage state saved');
        process.exitCode = 0;
        break;
      }
    }
    await page.waitForTimeout(1_000);
  }

  if (!existsSync(storageStatePath)) {
    throw new Error(`TIMEOUT: manual-login after ${loginTimeoutMs}ms`);
  }
} catch (error) {
  await page
    ?.screenshot({ path: join(outputDirectory, 'auth-capture-failure.png'), fullPage: true })
    .catch(() => undefined);
  throw error;
} finally {
  await context.close().catch(() => undefined);
}
