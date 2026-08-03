import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

/** Source with comments removed, for assertions about what the code does. */
const readCode = (path: string) => read(path)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('subscription centre vertical slice', () => {
  it('decides the page from the server snapshot and the verified user record', () => {
    const page = read('app/settings/subscription/page.tsx');
    expect(page).toContain("new SubscriptionRepository(supabase).getSnapshot()");
    expect(page).toContain('resolveEffectiveTier(snapshot, snapshot.databaseNow)');
    expect(page).toContain('user.email_confirmed_at');
    expect(page).toContain('resolveTrialState(snapshot, emailVerified)');
    expect(page).toContain("redirect('/auth/sign-in?next=/settings/subscription')");
    // Entitlement state is per-reader; a shared prerender would leak one
    // reader's plan into another's HTML.
    expect(page).toContain("export const dynamic = 'force-dynamic'");
  });

  it('sends no user, tier or timestamp to the trial RPC and revalidates every entitlement surface', () => {
    const actions = read('app/settings/subscription/actions.ts');
    const repository = read('src/lib/subscription/repository.ts');
    expect(repository).toContain("this.client.rpc('start_elite_trial')");
    // No second argument: the RPC takes no parameters at all.
    expect(repository).not.toMatch(/rpc\('start_elite_trial',/);
    expect(actions).toContain("revalidatePath(path)");
    for (const path of ['/settings/subscription', '/settings', '/portfolio', '/tools', '/']) {
      expect(actions).toContain(`'${path}'`);
    }
    expect(actions).toContain("record('trial_started')");
    expect(actions).toContain("record('trial_start_failed'");
    // The trial grant projects no billing identifier. Phase 1's own snapshot
    // mapper legitimately carries them, so this looks only at the grant mapper.
    const grantMapper = repository.slice(repository.indexOf('async startEliteTrial'));
    expect(grantMapper).not.toMatch(/billing/i);
  });

  it('never unlocks optimistically and latches against a double submit', () => {
    const button = read('src/components/subscription/TrialStartButton.tsx');
    expect(button).toContain('if (submitting.current || disabled) return;');
    expect(button).toContain('submitting.current = true;');
    expect(button).toContain('router.refresh()');
    // The latch is a ref read in the handler, never during render.
    expect(button).not.toMatch(/const\s+\w+\s*=\s*pending\s*\|\|\s*submitting\.current/);
  });

  it('derives the comparison from the central catalog instead of restating features', () => {
    const comparison = read('src/components/subscription/PlanComparison.tsx');
    const cards = read('src/components/subscription/PlanCards.tsx');
    expect(comparison).toContain('planFeatureGroups');
    expect(comparison).toContain('planDescriptors');
    expect(cards).toContain('planFeatureRow');
    expect(cards).toContain('planDescriptors');
    // Prices belong to the catalog, not to the card markup.
    for (const price of ['349', '3,490', '1,990', '799', '7,990', '4,490']) {
      expect(cards).not.toContain(`>${price}`);
    }
  });

  /*
   * Phase 4 opens purchasing, but only where a provider is actually configured.
   * The property that replaces "there is never a checkout" is stronger and is
   * the one that matters to a reader: a deployment without credentials shows no
   * pressable control at all — not a disabled button, not a link — just an
   * honest statement, and the decision is the server's, never the card's.
   */
  it('offers no checkout affordance when billing is not configured', () => {
    const purchase = read('src/components/subscription/PlanPurchase.tsx');
    expect(purchase).toContain('ระบบชำระเงินยังไม่เปิด');
    // The closed branch returns before any button exists in the tree.
    const closedBranch = purchase.slice(0, purchase.indexOf('const founder'));
    expect(closedBranch).toContain('!availability.enabled');
    expect(closedBranch).not.toContain('<CheckoutButton');
    expect(closedBranch).not.toMatch(/<button/);

    // The card never decides for itself whether billing is open.
    const cards = readCode('src/components/subscription/PlanCards.tsx');
    expect(cards).toContain('availability');
    expect(cards).not.toMatch(/process\.env|STRIPE_/);
  });

  /*
   * A checkout must carry a plan key and nothing else. An amount, a tier or a
   * discount arriving from a browser is the defect this asserts against.
   */
  it('lets the client name a plan and nothing else', () => {
    const button = readCode('src/components/subscription/CheckoutButton.tsx');
    expect(button).toContain('startCheckoutAction(planKey)');
    expect(button).not.toMatch(/amount|price|baht|discount|coupon|tier|customer/i);

    const actions = readCode('app/settings/subscription/billing-actions.ts');
    expect(actions).toContain('startCheckoutAction(planKey: string)');
    // No second parameter, of any name, on either exported action.
    expect(actions).not.toMatch(/startCheckoutAction\([^)]*,/);
    expect(actions).not.toMatch(/openBillingPortalAction\([^)]+\)/);
  });

  it('keeps the wide comparison inside its own scroller so the page never scrolls sideways', () => {
    const comparison = read('src/components/subscription/PlanComparison.tsx');
    expect(comparison).toContain('overflow-x-auto');
    // Below md the table is replaced entirely rather than squeezed.
    expect(comparison).toContain('hidden overflow-hidden');
    expect(comparison).toContain('md:hidden');
  });

  it('reaches the page from Settings without adding a sixth dock destination', () => {
    const settings = read('app/settings/page.tsx');
    const navigation = read('src/config/navigation.ts');
    expect(settings).toContain('href="/settings/subscription"');
    expect(navigation).not.toContain('/settings/subscription');
  });

  it('explains read-only portfolios from the shared message and links to the plans', () => {
    const client = read('src/components/portfolio/PortfolioClient.tsx');
    const manager = read('src/components/portfolio/PortfolioManager.tsx');
    const errors = read('src/lib/subscription/entitlement-errors.ts');
    expect(errors).toContain('พอร์ตนี้ยังเปิดดูได้ แต่ต้องใช้ Pro เพื่อแก้ไขต่อ');
    expect(client).toContain('READ_ONLY_PORTFOLIO_MESSAGE');
    expect(manager).toContain('READ_ONLY_PORTFOLIO_MESSAGE');
    expect(client).toContain('/settings/subscription');
    expect(client).toContain('portfolioWriteBlock');
    expect(manager).toContain('portfolioWriteBlock');
  });

  it('maps entitlement refusals in every portfolio action module', () => {
    for (const file of [
      'app/portfolio/actions.ts',
      'app/portfolio/portfolio-actions.ts',
      'app/portfolio/target-actions.ts',
    ]) {
      const source = read(file);
      expect(source, file).toContain('entitlementFailure(error)');
    }
    // The mapping itself is written once.
    const shared = read('src/lib/subscription/entitlement-errors.ts');
    expect(shared).toContain('READ_ONLY_SUBSCRIPTION');
    expect(shared).toContain('UPGRADE_REQUIRED');
    expect(shared).toContain('LIMIT_REACHED');
  });
});
