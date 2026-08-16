import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { requiredTierFor } from '@/src/lib/subscription/capabilities';
import { TOOL_CATALOG, TOOL_CATEGORIES, toolRequiredTier } from './catalog';

const toolsPageSource = readFileSync(join(process.cwd(), 'app/tools/page.tsx'), 'utf8');

/**
 * The index was regrouped, not re-gated. These hold the two apart: the layout
 * assertions describe what a reader sees, and the entitlement assertion says the
 * plan every card names still comes from the one capability matrix.
 */
describe('tools index presentation', () => {
  it('groups the catalog under its own two headings instead of a tab strip', () => {
    expect(TOOL_CATEGORIES).toEqual(['วิเคราะห์หุ้น', 'วิเคราะห์ Options']);
    expect(toolsPageSource).toContain('TOOL_CATEGORIES.map((category)');
    expect(toolsPageSource).toContain('TOOL_CATALOG.filter((tool) => tool.category === category)');
    expect(toolsPageSource).not.toContain('<Tabs');
    expect(toolsPageSource).not.toContain('activeTab');
  });

  it('answers what a tool does, who it is for and which plan it needs, on every card', () => {
    for (const tool of TOOL_CATALOG) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.audience.startsWith('เหมาะกับ')).toBe(true);
    }
    expect(toolsPageSource).toContain('{tool.description}');
    expect(toolsPageSource).toContain('{tool.audience}');
    expect(toolsPageSource).toContain('TOOL_ASSET_SCOPE_LABEL[tool.assetScope]');
    expect(toolsPageSource).toContain('PLAN_DISPLAY_NAME');
  });

  it('leaves entitlement exactly where it was — derived, never written on the card', () => {
    for (const tool of TOOL_CATALOG) {
      expect(toolRequiredTier(tool)).toBe(requiredTierFor(tool.capability));
    }
    expect(toolsPageSource).toContain('const unlocked = can(tool.capability)');
    expect(toolsPageSource).toContain("requestUpgrade({ capability: tool.capability");
    expect(toolsPageSource).not.toMatch(/tag:\s*'(PRO|ELITE|BASIC)'/i);
  });
});
