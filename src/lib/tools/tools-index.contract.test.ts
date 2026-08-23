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

  /*
    The card answers three things and stops: what the tool is, what it does, and
    which plan opens it. The paragraph naming who each tool was "เหมาะกับ" is
    gone, and the description is one line rather than a sentence — a catalogue
    entry, not a pitch. The instrument label stays, because it is the one fact a
    reader needs before opening a tool that the name does not carry.
  */
  it('answers what a tool does and which plan it needs, in one line per card', () => {
    for (const tool of TOOL_CATALOG) {
      expect(tool.description.length).toBeGreaterThan(0);
      // One line, not a paragraph: short enough that no card wraps into prose.
      expect(tool.description.length).toBeLessThanOrEqual(48);
      expect(tool.description).not.toMatch(/เหมาะ(กับ|สำหรับ)|เพื่อดูว่า/);
    }
    expect(toolsPageSource).toContain('{tool.description}');
    expect(toolsPageSource).not.toContain('tool.audience');
    expect(toolsPageSource).toContain('TOOL_ASSET_SCOPE_LABEL[tool.assetScope]');
    expect(toolsPageSource).toContain('PLAN_DISPLAY_NAME');
  });

  /*
    The row under the rule printed the category that the heading directly above
    the grid already printed. One of the two had to go, and it was not the
    heading.
  */
  it('does not repeat the category heading inside the card', () => {
    expect(toolsPageSource).not.toContain('{tool.category}');
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
