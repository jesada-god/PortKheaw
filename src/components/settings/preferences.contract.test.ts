import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('settings preferences contract', () => {
  it('offers all three motion modes and hides unfinished device settings', () => {
    const device = read('src/components/settings/DevicePreferences.tsx');
    expect(device).toContain('value="system"');
    expect(device).toContain('value="reduce"');
    expect(device).toContain('value="normal"');
    expect(device).not.toContain('Data Saver');
  });

  it('uses a page-local reveal without disabling the persisted privacy preference', () => {
    const hook = read('src/hooks/usePortfolioPrivacy.ts');
    const runtime = read('src/components/layout/AppRuntime.tsx');
    const store = read('src/store/useStore.ts');
    expect(hook).toContain('temporarilyRevealed');
    expect(hook).toContain('DEVICE_PREFERENCES_SYNC_EVENT');
    expect(hook).not.toContain('setPrivacyMode(false)');
    expect(runtime).toContain("event.key === 'nexora-ai-storage'");
    expect(store).toContain('privacyMode: true');
    expect(read('src/lib/privacy.ts')).toContain("'••••••'");
    expect(read('src/components/alerts/NotificationsClient.tsx')).toContain('maskedMessage(item, privacyMode)');
  });

  it('saves notification switches immediately and exposes a retry state', () => {
    const notifications = read('src/components/settings/NotificationPreferences.tsx');
    expect(notifications).toContain('saveNotificationToggleAction');
    expect(notifications).toContain('บันทึกแล้ว');
    expect(notifications).toContain('ลองอีกครั้ง');
    expect(notifications).toContain('Asia/Bangkok (UTC+7)');
  });

  it('authenticates and validates every account-setting write', () => {
    const actions = read('app/settings/actions.ts');
    expect(actions).toContain('safeParse');
    expect(actions).toContain('client.auth.getUser()');
    expect(actions).not.toContain('formData.get(\'userId\')');
  });
});
