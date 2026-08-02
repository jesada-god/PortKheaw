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
