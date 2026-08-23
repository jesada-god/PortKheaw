import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { plannerAcceptsAsset, PLANNER_OPTION_REFUSAL } from './planner-asset-scope';
import { horizonIsFuture, stockPlanCreateSchema, stockPlanUpdateSchema, updateKeepsOrdering } from './stock-plan-schema';
import { TOOL_CATALOG, TOOL_CATEGORIES } from './catalog';

/**
 * The Planner's edges: what it will plan, what a request may say, and what its
 * routes are structurally required to do before they answer anybody.
 *
 * The last group reads the route source as text. That is a blunt instrument and
 * it is used on purpose: these are the properties whose absence is invisible in
 * every other test — a route that forgot its entitlement guard passes its own
 * behavioural tests perfectly, because the tests sign in first.
 */

const VALID_PLAN = {
  symbol: 'AAPL', baselinePrice: 100, targetPrice: 120, invalidationPrice: 90,
  horizonDate: '2026-12-31',
};

function routeSource(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('what the planner will plan', () => {
  it.each(['stock', 'etf', 'adr', 'reit', 'fund', 'otc'] as const)('accepts %s', (assetType) => {
    expect(plannerAcceptsAsset(assetType).supported).toBe(true);
  });

  it.each([
    ['crypto', 'คริปโท'],
    ['index', 'ดัชนี'],
  ] as const)('refuses %s with a reason a reader can act on', (assetType, phrase) => {
    const decision = plannerAcceptsAsset(assetType);
    expect(decision.supported).toBe(false);
    expect(decision.supported === false && decision.message).toContain(phrase);
    expect(decision.supported === false && decision.message).toContain('v1');
  });

  /*
    The fail-safe direction. An instrument nobody has classified is precisely the
    one whose semantics cannot be vouched for, so it is refused rather than
    allowed through on the assumption it is probably a share.
  */
  it('refuses an unclassified instrument rather than assuming it is equity', () => {
    expect(plannerAcceptsAsset('unknown').supported).toBe(false);
  });

  it('names the options tool when refusing a contract', () => {
    expect(PLANNER_OPTION_REFUSAL).toContain('What-If');
  });
});

describe('what a request may say', () => {
  it('accepts a well-formed plan', () => {
    expect(stockPlanCreateSchema.safeParse(VALID_PLAN).success).toBe(true);
  });

  it.each([
    ['a target at the baseline', { targetPrice: 100 }],
    ['an invalidation level at the baseline', { invalidationPrice: 100 }],
    ['an inverted plan', { targetPrice: 90, invalidationPrice: 120 }],
    ['a zero price', { baselinePrice: 0 }],
    ['a negative price', { invalidationPrice: -1 }],
    ['a malformed symbol', { symbol: 'not a symbol!' }],
    ['a malformed date', { horizonDate: '31/12/2026' }],
  ])('refuses %s', (_label, overrides) => {
    expect(stockPlanCreateSchema.safeParse({ ...VALID_PLAN, ...overrides }).success).toBe(false);
  });

  /*
    The single most important line in this file. An edit request has no field
    that could carry a baseline, so no caller can express moving one — the
    property is structural rather than checked.
  */
  it('gives an edit no way to name a baseline at all', () => {
    const parsed = stockPlanUpdateSchema.safeParse({
      targetPrice: 140, invalidationPrice: 85, horizonDate: '2027-01-31', baselinePrice: 999,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).not.toHaveProperty('baselinePrice');
  });

  it('judges an edit against the stored baseline, not against anything sent', () => {
    const edit = { targetPrice: 140, invalidationPrice: 85, horizonDate: '2027-01-31' };
    expect(updateKeepsOrdering(edit, 100).ok).toBe(true);
    // The same edit is nonsense against a baseline of 200: the "target" is below it.
    expect(updateKeepsOrdering(edit, 200).ok).toBe(false);
    expect(updateKeepsOrdering({ ...edit, invalidationPrice: 150 }, 100).ok).toBe(false);
  });

  it('requires a horizon strictly in the future', () => {
    expect(horizonIsFuture('2026-12-31', '2026-08-14')).toBe(true);
    expect(horizonIsFuture('2026-08-14', '2026-08-14')).toBe(false);
    expect(horizonIsFuture('2026-08-13', '2026-08-14')).toBe(false);
  });
});

describe('every planner route is gated on the server', () => {
  const ROUTES = [
    'app/api/stock-plans/route.ts',
    'app/api/stock-plans/[id]/route.ts',
    'app/api/tools/planner-price/[symbol]/route.ts',
  ];

  it.each(ROUTES)('%s guards on planner.stock', (path) => {
    const source = routeSource(path);
    expect(source).toContain('guardRouteEntitlement');
    expect(source).toContain('planner.stock');
    // Every exported handler must reach the guard before anything else.
    for (const handler of source.matchAll(/export async function (GET|POST|PUT|DELETE)\b/g)) {
      const body = source.slice(source.indexOf(handler[0]));
      const guardAt = body.indexOf('guardRouteEntitlement');
      expect(guardAt, `${handler[1]} in ${path} never reaches the guard`).toBeGreaterThan(-1);
      expect(guardAt).toBeLessThan(body.indexOf('authenticatedRepository') === -1 ? Number.MAX_SAFE_INTEGER : body.indexOf('authenticatedRepository'));
    }
  });

  /*
    No planner route may hold a service-role client. Every read and write travels
    on the reader's own session, which is what makes row level security the thing
    that actually decides who sees a plan.
  */
  it.each(ROUTES)('%s never reaches for the service role', (path) => {
    const source = routeSource(path);
    expect(source).not.toMatch(/SERVICE_ROLE|service_role|createAdminClient/);
  });

  it('the repository never reaches for the service role either', () => {
    const source = routeSource('src/lib/tools/stock-plan-repository.ts');
    expect(source).not.toMatch(/SERVICE_ROLE|service_role|createAdminClient/);
    // Ownership is filtered in the query as well as by RLS: two independent locks.
    expect(source.match(/eq\('user_id', this\.userId\)/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
  });

  /*
    The page must not render the workspace for a locked reader. This tool's
    arithmetic runs in the browser, so a client-side gate would be the only thing
    standing between a Basic reader and the whole feature.
  */
  it('the page decides entitlement before it renders the workspace', () => {
    const source = routeSource('app/tools/stock-planner/page.tsx');
    expect(source).toContain('resolvePageEntitlement');
    expect(source).toContain('hasCapability');
    expect(source.indexOf('hasCapability')).toBeLessThan(source.indexOf('<StockPlannerWorkspace'));
  });
});

/*
  Where the one road from a stock to a plan starts, asserted on the source
  because placement is invisible to every behavioural test: a CTA rendered in the
  wrong place routes perfectly and still reads as navigation.
*/
describe('the road in from Stock Detail', () => {
  const detail = routeSource('src/components/stock/StockDetailClient.tsx');
  const cta = routeSource('src/components/stock/PlanThisStockCta.tsx');

  it('closes the Financials tab, and appears nowhere else on the page', () => {
    expect(detail.match(/<PlanThisStockCta/g) ?? []).toHaveLength(1);

    // Inside the Financials branch, and after the sections it already rendered.
    const financials = detail.slice(
      detail.indexOf("{tab === 'Financials' && ("),
      detail.indexOf("{tab === 'Analysis' && ("),
    );
    expect(financials).toContain('<PlanThisStockCta');
    expect(financials.indexOf('<AnalystTargetSection')).toBeLessThan(financials.indexOf('<PlanThisStockCta'));
    expect(financials.indexOf('<KeyStatisticsSection')).toBeLessThan(financials.indexOf('<PlanThisStockCta'));

    // And not in the header block, where it used to float above the tab bar.
    const aboveTabs = detail.slice(detail.indexOf('<StockPriceHeader'), detail.indexOf('<Tabs tabs={tabs}'));
    expect(aboveTabs).not.toContain('PlanThisStockCta');
  });

  it('carries the symbol and nothing else to the planner', () => {
    expect(cta).toContain('router.push(`/tools/stock-planner?symbol=${encodeURIComponent(symbol)}`)');
    // No price in the URL: the planner resolves its own baseline on arrival, and a
    // second copy passed through here could already be stale when the form renders.
    // Asserted on the code, not the prose that explains why.
    const code = cta.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('baseline');
    expect(code).not.toContain('price');
  });

  it('shows itself only for instruments the planner will actually take', () => {
    // The planner's own scope, not a second classification. Financials is hidden
    // for crypto but NOT for an index, which is why this gate has to be here.
    expect(cta).toContain('plannerAcceptsAsset');
    expect(cta).toContain("(assetType ?? 'unknown')");
    expect(detail).toContain('assetType={instrumentAssetType}');
  });

  it('keeps the entitlement path it already had, rather than linking a locked reader in', () => {
    expect(cta).toContain("can('planner.stock')");
    expect(cta).toContain("requestUpgrade({ capability: 'planner.stock', source: 'stock-detail.plan-cta' })");
  });
});

describe('the tools index', () => {
  it('groups by instrument, with the planner under the stock heading', () => {
    expect(TOOL_CATEGORIES).toEqual(['วิเคราะห์หุ้น', 'วิเคราะห์ Options']);
    const planner = TOOL_CATALOG.find((tool) => tool.id === 'stock-planner')!;
    expect(planner.category).toBe('วิเคราะห์หุ้น');
    expect(planner.description).toBe('กำหนดจุดเข้า · TP · SL และ Risk/Reward');
  });

  /* The options tools keep the entitlements they already had. */
  it('leaves the options tools on the entitlements they already had', () => {
    const byId = Object.fromEntries(TOOL_CATALOG.map((tool) => [tool.id, tool]));
    expect(byId['what-if'].capability).toBe('simulator.what_if');
    expect(byId['monte-carlo'].capability).toBe('simulator.monte_carlo');
    expect(byId['what-if'].category).toBe('วิเคราะห์ Options');
    expect(byId['monte-carlo'].category).toBe('วิเคราะห์ Options');
  });

  it('every category in the catalog is one the index offers', () => {
    for (const tool of TOOL_CATALOG) expect(TOOL_CATEGORIES).toContain(tool.category);
  });
});
