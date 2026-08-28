import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(
  resolve(process.cwd(), path),
  'utf8',
);

describe('push service worker contract', () => {
  it('reuses the one app-shell registration', () => {
    const runtime = read('src/components/layout/AppRuntime.tsx');
    const settings = read('src/components/settings/PushPreferences.tsx');
    expect(runtime.match(/serviceWorker\.register/g)).toHaveLength(1);
    expect(settings).not.toContain('serviceWorker.register');
  });

  /*
   * A worker between `next dev` and the browser can pin a component's chunk to
   * the first copy it saw, because a dev chunk URL does not change when the file
   * does — and no amount of deleting `.next`, restarting the server or
   * hard-refreshing dislodges it. It buys nothing while developing, so it does
   * not run, and an existing one is removed rather than left to keep failing.
   */
  it('registers no worker in development, and removes one already installed', () => {
    const runtime = read('src/components/layout/AppRuntime.tsx');
    expect(runtime).toContain("process.env.NODE_ENV !== 'production'");
    expect(runtime).toContain('getRegistrations');
    expect(runtime).toContain('registration.unregister()');
    // The dev branch must return before the registration below it can run.
    expect(runtime.indexOf('registration.unregister()'))
      .toBeLessThan(runtime.indexOf("serviceWorker.register('/sw.js'"));
  });

  it('shows bounded push data with the existing PortKheaw assets', () => {
    const worker = read('public/sw.js');
    expect(worker).toContain("addEventListener('push'");
    expect(worker).toContain('showNotification');
    expect(worker).toContain("icon: '/icons/icon-192.png'");
    expect(worker).toContain("badge: '/icons/icon-192.png'");
    expect(worker).toContain(": '/notifications'");
  });

  it('keeps clicks same-origin and focuses a tab before opening a new one', () => {
    const worker = read('public/sw.js');
    expect(worker).toContain("addEventListener('notificationclick'");
    expect(worker).toContain('requestedUrl.origin === self.location.origin');
    expect(worker.indexOf('existingClient.focus()')).toBeLessThan(
      worker.lastIndexOf('self.clients.openWindow(targetUrl)'),
    );
  });

  /*
   * The failure this pins down did not look like caching from any angle.
   *
   * `/_next/static/` was served cache-first with no revalidation. In production
   * that is correct — a rebuild changes the filename — but `next dev` serves a
   * component's chunk from a STABLE path, so the cache pinned the first version
   * the browser ever saw. Navigation stayed network-first, so the page rendered
   * live server data beside months-old JavaScript, and deleting `.next`,
   * restarting the dev server and hard-refreshing all left it untouched: none of
   * them clears Cache Storage, and a worker intercepts subresources whatever the
   * reload does.
   */
  it('never serves build output from the cache on a development host', () => {
    const worker = read('public/sw.js');
    expect(worker).toContain('IS_DEVELOPMENT_HOST');
    expect(worker).toContain("self.location.hostname === 'localhost'");
    expect(worker).toContain('isBuildOutput && IS_DEVELOPMENT_HOST');
    // The guard has to come before the cache-first branch to mean anything.
    expect(worker.indexOf('isBuildOutput && IS_DEVELOPMENT_HOST'))
      .toBeLessThan(worker.indexOf('caches.match(request)'));
  });

  /*
   * Evicting a poisoned cache depends entirely on the name changing: `activate`
   * deletes every cache that is not the current one, and nothing else ever
   * removes an entry.
   */
  it('purges every cache but the current one, under a name that moved', () => {
    const worker = read('public/sw.js');
    expect(worker).toMatch(/const CACHE_NAME = 'nexora-shell-v\d+'/);
    expect(worker).toContain('keys.filter((key) => key !== CACHE_NAME)');
    expect(worker).toContain('caches.delete(key)');
  });

  it('keeps the private signing key out of every browser source', () => {
    const browserSources = [
      'src/components/settings/PushPreferences.tsx',
      'src/lib/push/client.ts',
      'src/components/layout/AppRuntime.tsx',
      'public/sw.js',
    ].map(read).join('\n');
    expect(browserSources).not.toContain('VAPID_PRIVATE_KEY');
    expect(browserSources).not.toContain('serverEnv');
    expect(read('src/lib/push/service.ts')).toContain(
      'serverEnv.VAPID_PRIVATE_KEY',
    );
  });
});
