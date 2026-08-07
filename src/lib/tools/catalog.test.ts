import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasCapability, requiredTierFor } from '@/src/lib/subscription/capabilities';
import { upgradeTargetTier } from '@/src/lib/subscription/upgrade-copy';
import { TOOL_CATALOG, TOOL_CATEGORIES, toolRequiredTier } from './catalog';

const toolsPageSource = readFileSync(join(process.cwd(), 'app/tools/page.tsx'), 'utf8');

describe('tools catalog', () => {
  it('places What-If at Pro and Monte Carlo at Elite', () => {
    const whatIf = TOOL_CATALOG.find((tool) => tool.id === 'what-if');
    const monteCarlo = TOOL_CATALOG.find((tool) => tool.id === 'monte-carlo');
    expect(whatIf?.capability).toBe('simulator.what_if');
    expect(monteCarlo?.capability).toBe('simulator.monte_carlo');
    expect(toolRequiredTier(whatIf!)).toBe('pro');
    expect(toolRequiredTier(monteCarlo!)).toBe('elite');
  });

  /*
    The badge, the paywall prompt and the route guard must all name the same
    plan. They do so by all deriving it, so this asserts the derivation rather
    than three copies of the answer.
  */
  it('derives every badge from the same matrix the upgrade prompt reads', () => {
    for (const tool of TOOL_CATALOG) {
      expect(toolRequiredTier(tool)).toBe(requiredTierFor(tool.capability));
      expect(toolRequiredTier(tool)).toBe(upgradeTargetTier(tool.capability));
    }
  });

  it('never hard-codes a plan name in the tools index', () => {
    expect(toolsPageSource).not.toMatch(/tag:\s*'(PRO|ELITE|BASIC)'/i);
    expect(toolsPageSource).not.toMatch(/'(PRO|ELITE)'\s*\?/);
    expect(toolsPageSource).toContain('toolRequiredTier');
    expect(toolsPageSource).toContain('PLAN_DISPLAY_NAME');
  });

  it('fails closed: Pro reaches What-If but not Monte Carlo, Elite reaches both', () => {
    expect(hasCapability('basic', 'simulator.what_if')).toBe(false);
    expect(hasCapability('basic', 'simulator.monte_carlo')).toBe(false);
    expect(hasCapability('pro', 'simulator.what_if')).toBe(true);
    expect(hasCapability('pro', 'simulator.monte_carlo')).toBe(false);
    expect(hasCapability('elite', 'simulator.what_if')).toBe(true);
    expect(hasCapability('elite', 'simulator.monte_carlo')).toBe(true);
  });

  it('routes every tool to a page that exists and a category the filter offers', () => {
    for (const tool of TOOL_CATALOG) {
      expect(TOOL_CATEGORIES).toContain(tool.category);
      expect(() => readFileSync(join(process.cwd(), `app${tool.route}/page.tsx`), 'utf8')).not.toThrow();
    }
  });
});
