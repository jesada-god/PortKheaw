import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('portfolio entitlement vertical slice', () => {
  it('renders a locked Options choice for Basic and labels the required tier', () => {
    const manager = read('src/components/portfolio/PortfolioManager.tsx');
    expect(manager).toContain('portfolioCreationEntitlement');
    expect(manager).toContain('<Lock');
    expect(manager).toContain('ใช้ได้ใน Pro');
    expect(manager).toContain("requestUpgrade({ capability: 'portfolio.options.create'");
    expect(manager).toContain("requestUpgrade({ capability: 'portfolio.multiple.create'");
  });

  it('derives UI tier from the one effective-access resolver and returns typed server errors', () => {
    const page = read('app/portfolio/page.tsx');
    const actions = read('app/portfolio/portfolio-actions.ts');
    /*
     * Phase 3.2: this page read the subscription snapshot directly, so it was
     * the one surface that gated on what a reader had paid for rather than on
     * what they may open. It must now read the same resolver as the root layout
     * and every API guard, and must not reach for the plan snapshot again.
     */
    expect(page).toContain('resolvePageEntitlement()');
    expect(page).toContain('entitlement.effectiveAccessTier');
    expect(page).not.toContain('SubscriptionRepository');
    expect(page).not.toContain('getEffectiveTier');
    /*
     * The typed codes moved into one shared mapper when the read-only refusal
     * joined them, so the action module is checked for routing through it and
     * the codes themselves are checked where they are now defined.
     */
    expect(actions).toContain('entitlementFailure(error)');
    const entitlementErrors = read('src/lib/subscription/entitlement-errors.ts');
    expect(entitlementErrors).toContain("'UPGRADE_REQUIRED'");
    expect(entitlementErrors).toContain("'LIMIT_REACHED'");
  });

  it('does not perform local-clock entitlement checks in render components', () => {
    const sources = [
      read('app/portfolio/page.tsx'),
      read('src/components/portfolio/PortfolioClient.tsx'),
      read('src/components/portfolio/PortfolioManager.tsx'),
    ].join('\n');
    expect(sources).not.toMatch(/Date\.now\(\).*tier|tier.*Date\.now\(\)/);
  });
});
