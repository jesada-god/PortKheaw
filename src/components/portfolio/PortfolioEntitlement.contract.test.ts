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
    expect(manager).toContain('disabled={!optionsEntitlement.canCreate}');
  });

  it('derives UI tier from the server subscription snapshot and returns typed server errors', () => {
    const page = read('app/portfolio/page.tsx');
    const repository = read('src/lib/subscription/repository.ts');
    const actions = read('app/portfolio/portfolio-actions.ts');
    expect(page).toContain('subscriptionRepository.getEffectiveTier()');
    expect(repository).toContain("this.client.rpc('get_my_subscription_snapshot')");
    expect(repository).toContain('resolveEffectiveTier(snapshot, snapshot.databaseNow)');
    expect(actions).toContain("code: 'UPGRADE_REQUIRED'");
    expect(actions).toContain("code: 'LIMIT_REACHED'");
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
