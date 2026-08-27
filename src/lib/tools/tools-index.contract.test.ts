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
   * NAME, ONE LINE, BUTTON — and the two facts that are not copy.
   *
   * The card used to answer a third question, "เหมาะกับคนที่…", in a field
   * called `audience`. That went with the value preview and the sample outcome:
   * all three were written to sell a reader on opening the tool, and a
   * catalogue of three items does not need selling.
   *
   * The instrument scope stays, and is the one line here worth defending. It is
   * the only thing a reader cannot infer from the name — somebody holding
   * shares opened "ทดลองสถานการณ์" and met a form asking for a strike — so it
   * is a fact about the tool rather than a pitch for it. The plan badge stays
   * for the same reason: it answers "can I open this".
   */
  it('says the tool’s name, what it does in one line, and which plan opens it', () => {
    for (const tool of TOOL_CATALOG) {
      expect(tool.description.length).toBeGreaterThan(0);
      // One line means one sentence: no bullet, no second clause after a break.
      expect(tool.description).not.toContain('\n');
      expect(tool.description).not.toContain('•');
    }
    expect(toolsPageSource).toContain('{tool.description}');
    expect(toolsPageSource).toContain('TOOL_ASSET_SCOPE_LABEL[tool.assetScope]');
    expect(toolsPageSource).toContain('PLAN_DISPLAY_NAME');
  });

  it('carries no copy written to sell the tool', () => {
    /*
     * Comments stripped: the block at the top of the page lists what each card
     * used to carry, by name. A source-reading test that could not tell code
     * from the note explaining a removal would forbid documenting it.
     */
    const code = toolsPageSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('ปลดล็อกแล้วได้อะไร');
    expect(code).not.toContain('ตัวอย่าง');
    expect(code).not.toContain('tool.audience');
    expect(code).not.toContain('valuePreview');
    expect(code).not.toContain('sampleOutcome');
    for (const tool of TOOL_CATALOG) {
      expect(tool.description).not.toMatch(/เครื่องมือนี้จะช่วย|เหมาะกับ|ช่วยให้คุณ/);
    }
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
