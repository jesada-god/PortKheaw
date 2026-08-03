import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

/** Source with comments removed, for assertions about what the code does. */
const readCode = (path: string) => read(path)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/**
 * Structural guarantees that a behavioural test cannot observe, because they are
 * about what is *absent*: a secret that never reaches a bundle, a client
 * parameter that does not exist, an unlock that is not wired to a redirect.
 */
describe('billing security contract', () => {
  /*
   * The provider secret must be reachable from exactly one module, and that
   * module must be excluded from any client bundle by the build itself.
   */
  it('keeps every provider secret behind server-only modules', () => {
    for (const file of [
      'src/lib/billing/billing-server.ts',
      'src/lib/billing/billing-repository.ts',
      'src/lib/billing/providers/stripe/stripe-provider.ts',
    ]) {
      expect(read(file), file).toContain("import 'server-only'");
    }

    // The pure modules the browser may reach must not name a credential at all.
    for (const file of [
      'src/lib/billing/billing-plans.ts',
      'src/lib/billing/billing-config.ts',
      'src/lib/billing/billing-summary.ts',
      'src/lib/billing/billing-events.ts',
      'src/lib/billing/checkout-eligibility.ts',
    ]) {
      expect(readCode(file), file).not.toMatch(/process\.env/);
    }
  });

  it('never imports the provider SDK from a client component', () => {
    for (const file of [
      'src/components/subscription/CheckoutButton.tsx',
      'src/components/subscription/BillingPortalButton.tsx',
      'src/components/subscription/PlanPurchase.tsx',
      'src/components/subscription/PlanCards.tsx',
      'src/components/subscription/ManageSubscriptionCard.tsx',
    ]) {
      const source = readCode(file);
      expect(source, file).not.toMatch(/from 'stripe'/);
      expect(source, file).not.toMatch(/billing-server|stripe-provider|billing-repository/);
      expect(source, file).not.toMatch(/process\.env/);
    }
  });

  /*
   * The environment is read in one place, through the existing server-env
   * module, rather than each billing module reaching for `process.env`.
   */
  it('reads billing configuration through the one server environment module', () => {
    const server = readCode('src/lib/billing/billing-server.ts');
    expect(server).toContain("from '@/src/config/env/server'");
    expect(server).toContain('resolveBillingConfig(serverEnv)');
    expect(server).not.toMatch(/process\.env/);

    const env = read('src/config/env/server.ts');
    for (const key of [
      'BILLING_ENABLED', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
      'STRIPE_PRICE_PRO_MONTHLY', 'STRIPE_PRICE_ELITE_ANNUAL',
      'STRIPE_COUPON_FOUNDER_PRO', 'STRIPE_COUPON_FOUNDER_ELITE',
    ]) {
      expect(env, key).toContain(key);
    }
    // None of them is NEXT_PUBLIC_, which would inline the value into the bundle.
    expect(env).not.toMatch(/NEXT_PUBLIC_STRIPE|NEXT_PUBLIC_BILLING/);
  });

  /*
   * The amount is never sent. Only a price identifier is, and the provider holds
   * the amount behind it — so neither a browser nor a bug in this file can
   * change what somebody is charged.
   */
  it('sends the provider a price identifier, never an amount', () => {
    const provider = readCode('src/lib/billing/providers/stripe/stripe-provider.ts');
    expect(provider).toContain('line_items: [{ price: priceId, quantity: 1 }]');
    expect(provider).not.toMatch(/unit_amount|amount:|price_data/);
    // Promotion codes are off, so the only discount is the one the server picks.
    expect(provider).toContain('allow_promotion_codes: false');
  });

  it('refuses to open a Founder checkout without its coupon', () => {
    const provider = readCode('src/lib/billing/providers/stripe/stripe-provider.ts');
    expect(provider).toContain("if (plan.founder && !coupon) throw new Error('BILLING_FOUNDER_COUPON_MISSING')");
  });

  /*
   * The checkout's whole input surface is one plan key. Identity comes from the
   * session, and the customer identifier from the account's own row.
   */
  it('takes nothing from the client but a plan key', () => {
    const actions = readCode('app/settings/subscription/billing-actions.ts');
    expect(actions).toContain('startCheckoutAction(planKey: string)');
    expect(actions).toContain('resolveCheckoutEligibility(');
    expect(actions).toContain('await client.auth.getUser()');
    expect(actions).toContain('userId: user.id');

    // The exported actions accept no identity, price or discount. Internal
    // helpers may take whatever they need — they are not a request surface.
    const exported = [...actions.matchAll(/export async function \w+\(([^)]*)\)/g)].map((match) => match[1]);
    expect(exported).toHaveLength(2);
    for (const parameters of exported) {
      expect(parameters).not.toMatch(/\b(userId|customerId|amount|tier|coupon|discount|price|email)\b/);
    }
    expect(exported).toContain('planKey: string');
    expect(exported).toContain('');
  });

  /*
   * With billing unconfigured the provider SDK must not even be loaded. The
   * import is dynamic and sits after the eligibility gate.
   */
  it('never loads or contacts the provider while billing is disabled', () => {
    const actions = readCode('app/settings/subscription/billing-actions.ts');
    expect(actions).not.toMatch(/^import .*stripe-provider/m);
    expect(actions).toContain("await import('@/src/lib/billing/providers/stripe/stripe-provider')");

    // The gate runs before the dynamic import on every path.
    const gateIndex = actions.indexOf('resolveCheckoutEligibility(');
    const importIndex = actions.indexOf("await import('@/src/lib/billing/providers/stripe/stripe-provider')");
    expect(gateIndex).toBeGreaterThan(-1);
    expect(gateIndex).toBeLessThan(importIndex);
  });

  /*
   * The success redirect is a page anybody can type into their address bar. It
   * must not be able to grant anything.
   */
  it('grants nothing from the checkout return URL', () => {
    const provider = readCode('src/lib/billing/providers/stripe/stripe-provider.ts');
    expect(provider).toContain('/settings/subscription?checkout=success');

    // The page reads its state from the database, and the query parameter is not
    // consulted by any entitlement path.
    const page = readCode('app/settings/subscription/page.tsx');
    expect(page).not.toMatch(/searchParams|checkout=success|session_id/);

    const button = readCode('src/components/subscription/CheckoutButton.tsx');
    expect(button).not.toMatch(/setTier|setPlan|optimistic|router\.refresh/);
  });

  /*
   * The webhook is the only thing that may change a plan, so the properties that
   * make it trustworthy are asserted here rather than left to review.
   */
  it('verifies the raw body against a server-held secret before doing anything', () => {
    const route = readCode('app/api/billing/webhook/route.ts');
    // The exact bytes that were signed — `request.json()` would re-serialize and
    // invalidate every signature.
    expect(route).toContain('await request.text()');
    expect(route).not.toMatch(/request\.json\(\)/);
    expect(route).toContain('verifyStripeWebhook(config, rawBody, signature)');
    expect(route).toContain("export const runtime = 'nodejs'");

    // No configuration means no way to tell a real delivery from a forged one.
    expect(route).toContain('if (!config)');
    expect(route).toContain('status: 503');
    expect(route).toContain('status: 400');

    const provider = readCode('src/lib/billing/providers/stripe/stripe-provider.ts');
    expect(provider).toContain('constructEventAsync');
    expect(provider).toContain('config.webhookSecret');
  });

  it('records a digest of the delivery, never the delivery', () => {
    const route = readCode('app/api/billing/webhook/route.ts');
    expect(route).toContain("createHash('sha256').update(rawBody).digest('hex')");
    expect(route).not.toMatch(/JSON\.stringify\(event\)|payload: rawBody|body: rawBody/);
  });

  /*
   * Logs are the easiest place to leak. The event type and an outcome are
   * product facts; an account, a customer or a payload are not.
   */
  it('logs no identifier, secret or payload from the webhook', () => {
    /*
     * Quoted text inside a log call is a fixed label chosen here — `'stripe'`,
     * `'invalid_signature'` — and is safe by construction. What must never
     * appear is a *reference* to a runtime value, so the literals are stripped
     * before the scan and only identifiers are examined.
     */
    const callsWithoutLiterals = (source: string) =>
      [...source.matchAll(/\brecord\(([^)]*)\)/g)]
        .map((match) => match[1].replace(/'[^']*'/g, "''"))
        .join('\n');

    const route = callsWithoutLiterals(readCode('app/api/billing/webhook/route.ts'));
    expect(route.length).toBeGreaterThan(0);
    for (const forbidden of [
      'userId', 'user.id', 'customerId', 'eventId', 'rawBody', 'signature',
      'email', 'payloadDigest', 'config',
    ]) {
      expect(route, forbidden).not.toContain(forbidden);
    }

    const actions = callsWithoutLiterals(readCode('app/settings/subscription/billing-actions.ts'));
    for (const forbidden of ['user.id', 'userId', 'email', 'customerId', 'url', 'session']) {
      expect(actions, forbidden).not.toContain(forbidden);
    }
  });

  /*
   * Entitlement must not be decided in the route. It hands the verified event to
   * the database routine, which owns idempotency, locking and staleness.
   */
  it('leaves every entitlement decision to the database routine', () => {
    const route = readCode('app/api/billing/webhook/route.ts');
    expect(route).toContain('applyBillingEvent(event, payloadDigest)');
    // The route touches no table and holds no database client of its own.
    expect(route).not.toMatch(/\.from\(/);
    expect(route).not.toMatch(/createAdminClient|createClient/);

    const repository = readCode('src/lib/billing/billing-repository.ts');
    expect(repository).toContain("admin.rpc('apply_billing_subscription_event'");
    // The repository reads the subscription table but never writes it: every
    // mutation goes through the routine that owns locking and idempotency.
    expect(repository).not.toMatch(/\.(update|upsert|insert|delete)\(/);
  });

  it('asks the provider to redeliver only when processing genuinely failed', () => {
    const route = readCode('app/api/billing/webhook/route.ts');
    // Duplicates, stale events and mismatches are handled outcomes, answered 200,
    // so the provider stops retrying them.
    expect(route).toContain('status: 200');
    expect(route).toContain('status: 500');
    expect(route).toContain("outcome === 'applied'");
  });
});
