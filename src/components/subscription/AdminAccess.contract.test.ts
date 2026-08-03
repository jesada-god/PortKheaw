import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

/** Source with comments removed, for assertions about what the code does. */
const readCode = (path: string) => read(path)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('admin access vertical slice', () => {
  it('resolves role, plan and preview in one trusted place instead of per component', () => {
    const resolver = read('src/lib/subscription/account-access.ts');
    expect(resolver).toContain("import 'server-only'");
    expect(resolver).toContain("client.rpc('get_my_account_access')");
    expect(resolver).toContain('resolveAccountAccess({');

    /*
     * Both entitlement entry points read that one resolver. If either grew its
     * own database read, a preview could apply on a page and not in an API — the
     * exact shape of leak this phase exists to prevent.
     */
    for (const file of ['src/lib/subscription/page-entitlement.ts', 'src/lib/subscription/server-entitlement.ts']) {
      const source = readCode(file);
      expect(source, file).toContain('resolveRequestAccountAccess');
      expect(source, file).not.toContain('get_my_subscription_snapshot');
      expect(source, file).not.toContain('SubscriptionRepository');
    }

    // No component decides a role for itself.
    const components = ['AdminAccessCard', 'AdminPreviewBanner', 'AdminPreviewSelector', 'AccountBadges'];
    for (const name of components) {
      const source = readCode(`src/components/subscription/${name}.tsx`);
      expect(source, name).not.toMatch(/role\s*===\s*['"]admin['"]/);
      expect(source, name).not.toMatch(/rpc\(/);
    }
  });

  it('keeps the three tiers apart wherever they are consumed', () => {
    const page = readCode('src/lib/subscription/page-entitlement.ts');
    expect(page).toContain('effectiveAccessTier');
    expect(page).toContain('subscriptionEffectiveTier');

    // Feature gating reads effective access…
    expect(readCode('app/layout.tsx')).toContain('tier={entitlement.effectiveAccessTier}');
    expect(readCode('app/stock/[symbol]/page.tsx')).toContain('entitlement.effectiveAccessTier');

    // …while the subscription hero and plan cards keep describing the real plan.
    const subscription = readCode('app/settings/subscription/page.tsx');
    expect(subscription).toContain('resolveEffectiveTier(snapshot, snapshot.databaseNow)');
    expect(subscription).toContain('<CurrentPlanHero');
    expect(subscription).toContain('effectiveTier={effectiveTier}');
    expect(subscription).not.toContain('effectiveTier={access.effectiveAccessTier}');

    // And the profile's plan line names the subscription, not the preview.
    expect(readCode('app/profile/page.tsx')).toContain('planDescriptor(access.subscriptionEffectiveTier)');
  });

  it('lets no client choose a role, a tier or a preview', () => {
    const actions = readCode('app/settings/subscription/actions.ts');
    // The action takes a mode and nothing else — no user id, no tier, no expiry.
    expect(actions).toContain('setAdminAccessPreviewAction(mode: AdminPreviewMode)');
    expect(actions).toContain('adminPreviewModes.includes(mode)');
    expect(actions).toContain('await requireAdmin()');
    expect(actions).not.toMatch(/setAdminAccessPreviewAction\([^)]*userId/);
    /*
     * The action reports the expiry the database chose; it must never compute
     * one. No clock is read here at all, so there is no value for a caller to
     * influence and no way for the window to drift from the sixty minutes the
     * migration defines.
     */
    expect(actions).not.toMatch(/new Date\(|Date\.now\(|interval/);

    const repository = readCode('src/lib/subscription/account-access.ts');
    expect(repository).toContain("rpc('set_my_admin_access_preview', { input_mode: mode })");
    expect(repository).not.toMatch(/input_user_id|user_id:/);

    // The selector and the exit button carry no authority of their own.
    for (const name of ['AdminPreviewSelector', 'AdminPreviewExitButton']) {
      const source = readCode(`src/components/subscription/${name}.tsx`);
      expect(source, name).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
      expect(source, name).not.toMatch(/fetch\(/);
    }
  });

  it('never unlocks optimistically and re-reads the server before showing a change', () => {
    const selector = readCode('src/components/subscription/AdminPreviewSelector.tsx');
    // The radio's checked state is the server-resolved mode, not local state.
    expect(selector).toContain('checked={selected}');
    expect(selector).toContain('const selected = mode === currentMode;');
    expect(selector).not.toMatch(/setCurrentMode|useState<AdminPreviewMode>/);
    // Success is applied by a full reload, never by mutating client state.
    expect(selector).toContain('reloadAfterAccessChange()');
    expect(readCode('src/components/subscription/AdminPreviewExitButton.tsx')).toContain('reloadAfterAccessChange()');
    expect(readCode('src/components/subscription/admin-preview-reload.ts')).toContain('window.location.reload()');
  });

  it('invalidates every entitlement surface, including dynamic segments', () => {
    const actions = readCode('app/settings/subscription/actions.ts');
    // The layout invalidation is what covers `/stock/[symbol]` and friends; a
    // path list alone would leave them holding the previous tier's render.
    expect(actions).toContain("revalidatePath('/', 'layout')");
    expect(actions).toContain('revalidateEveryEntitlementSurface()');
  });

  it('keeps entitled responses per-reader so no cache can share them across plans', () => {
    const entitled = read('src/lib/subscription/entitled-response.ts');
    expect(entitled).toContain("'Cache-Control', 'private, no-store, max-age=0'");
    expect(entitled).toContain("headers.delete('CDN-Cache-Control')");
    expect(entitled).toContain("headers.delete('Vercel-CDN-Cache-Control')");
    expect(entitled).toContain("'Vary'");
    expect(entitled).toContain("'X-Entitlement-Tier'");

    // The pages whose whole subject is the reader's access are never prerendered.
    for (const page of ['app/profile/page.tsx', 'app/settings/subscription/page.tsx']) {
      expect(read(page), page).toContain("export const dynamic = 'force-dynamic'");
    }
  });

  it('shows the operator control and the banner to administrators only', () => {
    const profile = readCode('app/profile/page.tsx');
    expect(profile).toContain('{access.isAdmin && (');
    expect(profile).toContain('<AdminPreviewSelector');

    const subscription = readCode('app/settings/subscription/page.tsx');
    expect(subscription).toContain('{access.isAdmin && <AdminAccessCard');

    // The banner refuses at its own top, so a wiring mistake still renders nothing.
    const banner = readCode('src/components/subscription/AdminPreviewBanner.tsx');
    expect(banner).toContain("if (!entitlement.isAdmin || entitlement.adminPreviewMode === 'actual') return null;");
  });

  it('separates operator access from a paid plan in the subscription centre', () => {
    const card = read('src/components/subscription/AdminAccessCard.tsx');
    expect(card).toContain('สิทธิ์ผู้ดูแลระบบ PortKheaw');
    expect(card).toContain('ไม่ใช่แพ็กเกจ Elite แบบชำระเงิน');

    // Buying is still closed, and this phase did not open it.
    const cards = readCode('src/components/subscription/PlanCards.tsx');
    expect(cards).toContain('เปิดให้สมัคร เร็ว ๆ นี้');
    expect(cards).not.toMatch(/checkout|stripe|omise|paypal/i);
  });

  it('refuses an administrator the one real trial grant', () => {
    const actions = readCode('app/settings/subscription/actions.ts');
    expect(actions).toContain('if (access.isAdmin) {');
    expect(actions).toContain('ADMIN_TRIAL_BLOCKED_MESSAGE');
    // The refusal is before the RPC, so `trial_used_at` is never written.
    const guardIndex = actions.indexOf('if (access.isAdmin) {');
    const rpcIndex = actions.indexOf('startEliteTrial()');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(rpcIndex);

    expect(read('app/settings/subscription/page.tsx')).toContain('trialBlockedReason={access.isAdmin');
  });

  it('records preview events in the existing log shape without adding a dependency', () => {
    const actions = read('app/settings/subscription/actions.ts');
    for (const event of [
      'admin_access_preview_started',
      'admin_access_preview_changed',
      'admin_access_preview_cleared',
      'admin_access_preview_failed',
    ]) {
      expect(actions).toContain(event);
    }
    // Nothing personal, and no analytics import.
    expect(readCode('app/settings/subscription/actions.ts')).not.toMatch(/userId|user\.id|email|token/);
    expect(actions).not.toMatch(/from '(posthog|mixpanel|@sentry|@vercel\/analytics)/);
  });

  it('takes every badge and banner tone from a theme token defined in both appearances', () => {
    const tokens = ['--plan-basic', '--plan-pro', '--plan-elite', '--plan-elite-trial', '--role-admin'];
    for (const appearance of ['dark', 'light'] as const) {
      const css = read(`src/themes/portkheaw/${appearance}.css`);
      for (const token of tokens) expect(css, `${appearance} ${token}`).toContain(`${token}:`);
    }
    for (const name of ['AccountBadges', 'AdminPreviewBanner', 'AdminPreviewSelector', 'AdminAccessCard']) {
      const source = read(`src/components/subscription/${name}.tsx`);
      expect(source, name).not.toMatch(/(?:text|bg|border)-\[#[0-9a-fA-F]{3,8}\]/);
      expect(source, name).not.toMatch(/\b(?:text|bg|border)-(?:slate|gray|zinc|neutral|stone)-\d{2,3}\b/);
    }
  });
});
