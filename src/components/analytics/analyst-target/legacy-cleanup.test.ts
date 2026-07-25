import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('legacy valuation cleanup', () => {
  it('leaves no reachable Fair Value API, UI or Nexora price-target calculator', () => {
    expect(existsSync(join(root, 'app/api/analytics/fair-value/[symbol]/route.ts'))).toBe(false);
    expect(existsSync(join(root, 'src/lib/analytics/valuation/orchestration.ts'))).toBe(false);
    expect(existsSync(join(root, 'src/components/analytics/fair-value/FairValueCard.tsx'))).toBe(false);
    expect(existsSync(join(root, 'app/tools/price-target/page.tsx'))).toBe(false);
    expect(existsSync(join(root, 'src/lib/price-target/calculations.ts'))).toBe(false);
    expect(existsSync(join(root, 'src/components/price-target/PriceTargetWorkspace.tsx'))).toBe(false);
  });

  it('does not advertise or gate the removed system', () => {
    const sources = [
      read('src/components/stock/StockDetailClient.tsx'),
      read('src/components/stock/ChartPanel.tsx'),
      read('app/tools/page.tsx'),
      read('src/config/features.ts'),
      read('.env.example'),
    ].join('\n');
    expect(sources).not.toMatch(
      /Fair Value|FEATURE_FAIR_VALUE|nexora-fv|Fundamental Fair Value|DCF|FCFF|FCFE|DDM/i,
    );
  });

  it('keeps Analyst Consensus independent from legacy FMP target endpoints', () => {
    const runtime = [
      read('src/lib/analytics/analyst-target/providers.ts'),
      read('src/lib/analytics/analyst-target/service.ts'),
      read('src/lib/analytics/analyst-target/types.ts'),
    ].join('\n');
    expect(runtime).not.toMatch(
      /financial-modeling-prep|tipranks-search|price-target-news|price-target-consensus/i,
    );
  });
});
