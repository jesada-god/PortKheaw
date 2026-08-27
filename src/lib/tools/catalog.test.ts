import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasCapability, requiredTierFor } from '@/src/lib/subscription/capabilities';
import { upgradeTargetTier } from '@/src/lib/subscription/upgrade-copy';
import { TOOL_ASSET_SCOPE_LABEL, TOOL_CATALOG, TOOL_CATEGORIES, toolRequiredTier } from './catalog';

const toolsPageSource = readFileSync(join(process.cwd(), 'app/tools/page.tsx'), 'utf8');
const plannerPageSource = readFileSync(join(process.cwd(), 'app/tools/stock-planner/page.tsx'), 'utf8');

describe('tools catalog', () => {
  it('places What-If at Pro, Monte Carlo at Elite and the Stock Planner at Pro', () => {
    const whatIf = TOOL_CATALOG.find((tool) => tool.id === 'what-if');
    const monteCarlo = TOOL_CATALOG.find((tool) => tool.id === 'monte-carlo');
    const planner = TOOL_CATALOG.find((tool) => tool.id === 'stock-planner');
    expect(whatIf?.capability).toBe('simulator.what_if');
    expect(monteCarlo?.capability).toBe('simulator.monte_carlo');
    expect(planner?.capability).toBe('planner.stock');
    expect(toolRequiredTier(whatIf!)).toBe('pro');
    expect(toolRequiredTier(monteCarlo!)).toBe('elite');
    expect(toolRequiredTier(planner!)).toBe('pro');
  });

  /*
    The one thing a beginner has to know before opening a tool: which instrument
    it is for. It is a field on the entry and a lookup on the page, so a tool
    cannot ship without one and the index cannot print a scope the catalog did
    not declare.
  */
  it('tells the reader which instrument every tool is for, before it is opened', () => {
    const scopes = Object.fromEntries(TOOL_CATALOG.map((tool) => [tool.id, tool.assetScope]));
    expect(scopes).toEqual({ 'what-if': 'options', 'monte-carlo': 'options', 'stock-planner': 'stock' });
    expect(TOOL_ASSET_SCOPE_LABEL.options).toBe('สำหรับสัญญาออปชัน');
    // ETFs are named on the label because the planner takes them; the scope key
    // stays `stock`, which is what the routing rule reads.
    expect(TOOL_ASSET_SCOPE_LABEL.stock).toBe('สำหรับหุ้นและ ETF รายตัว');
    // Printed on the card itself, not only inside the tool.
    expect(toolsPageSource).toContain('TOOL_ASSET_SCOPE_LABEL[tool.assetScope]');
  });

  /*
    The Stock Planner computes in the browser, so no API route stands behind it.
    Its page is therefore the enforcement point, and it must refuse on the
    server: `hasCapability` decides, and the workspace is only ever returned
    inside the entitled branch.
  */
  it('refuses an unentitled reader on the server rather than in the browser', () => {
    expect(plannerPageSource).toContain("resolvePageEntitlement");
    expect(plannerPageSource).toContain("hasCapability(entitlement.effectiveAccessTier, CAPABILITY)");
    expect(plannerPageSource).not.toContain("'use client'");
    const entitledBranch = plannerPageSource.slice(plannerPageSource.indexOf('if (hasCapability'));
    const workspaceUse = entitledBranch.indexOf('<StockPlannerWorkspace />');
    const lockedBranch = entitledBranch.indexOf('const copy = upgradeCopy');
    expect(workspaceUse).toBeGreaterThan(-1);
    expect(workspaceUse).toBeLessThan(lockedBranch);
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

  it('fails closed for the Stock Planner: Basic sees the card, Pro and Elite open it', () => {
    expect(hasCapability('basic', 'planner.stock')).toBe(false);
    expect(hasCapability('pro', 'planner.stock')).toBe(true);
    expect(hasCapability('elite', 'planner.stock')).toBe(true);
  });

  it('routes every tool to a page that exists and a category the filter offers', () => {
    for (const tool of TOOL_CATALOG) {
      expect(TOOL_CATEGORIES).toContain(tool.category);
      expect(() => readFileSync(join(process.cwd(), `app${tool.route}/page.tsx`), 'utf8')).not.toThrow();
    }
  });
});

/**
 * THE LOCKED CARD SAYS WHAT THE TOOL IS AND WHICH PLAN OPENS IT. Nothing else.
 *
 * It used to carry a tinted "ปลดล็อกแล้วได้อะไร" box with three bulleted
 * outcomes and a labelled ตัวอย่าง sentence, and this block held three tests
 * over that copy — that every tool had at least two preview lines, that the
 * illustrative one was labelled, and that none of it contained a digit so it
 * could never be read as a figure about the reader's own positions.
 *
 * The copy is gone: it was written to sell somebody on opening a tool, and a
 * catalogue of three items does not need selling. What survives is the property
 * that actually mattered — a locked card costs nothing and reveals nothing —
 * which is now the only thing asserted, and is asserted more strictly than
 * before because there is no preview to make an exception for.
 */
describe('a locked tool card', () => {
  it('adds no request and no computation for a locked reader', () => {
    expect(toolsPageSource).not.toContain('fetch(');
    expect(toolsPageSource).not.toContain('useEffect');
  });

  it('reveals no figure of any kind, from the catalog or the page', () => {
    for (const tool of TOOL_CATALOG) {
      // Titles carry no numbers either, so a digit anywhere in a tool's own copy
      // would be a figure that arrived from somewhere it should not have.
      expect(`${tool.title} ${tool.description}`).not.toMatch(/\d/);
    }
  });

  it('names the plan from the matrix rather than writing it into the card', () => {
    expect(toolsPageSource).toContain('toolRequiredTier(tool)');
    expect(toolsPageSource).toContain('PLAN_DISPLAY_NAME[tier]');
  });
});
