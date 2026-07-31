import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => readFileSync(
  new URL(`../../../${relative}`, import.meta.url),
  'utf8',
);

describe('Overview dashboard contracts', () => {
  it('does not issue per-symbol requests from the browser', () => {
    const dashboard = read('src/components/dashboard/DashboardClient.tsx');
    expect(dashboard).toContain('fetch(`/api/market/overview/section?section=${section}`');
    expect(dashboard).not.toContain('/api/market/quote/');
    expect(dashboard).not.toMatch(/fetch\([^)]*symbol/i);
  });

  it('uses bounded server concurrency and the canonical quote/session pipeline', () => {
    const service = read('src/lib/overview/service.ts');
    expect(service).toContain('mapWithConcurrency');
    expect(service).toContain('loadResilientQuote');
    expect(service).toContain('resolveCurrentMarketSession');
    expect(service).toContain('resolveCanonicalMarketSnapshot');
    expect(service).toContain('buildStockPriceHeaderModel');
  });

  it('does not block the Home SSR response on the full Industry universe', () => {
    const page = read('app/page.tsx');
    expect(page).toContain('loadIndustryDashboardSnapshot');
    expect(page).toContain('after(async () =>');
    expect(page).toContain('warmIndustryDashboard');
    expect(page).not.toMatch(/await\s+loadIndustryDashboard\(/);
    expect(page).not.toContain('loadIndustryDashboard(new Date(generatedAt))');
  });

  it('contains no raw provider error, cached, unavailable or Top Movers copy', () => {
    const dashboard = read('src/components/dashboard/DashboardClient.tsx');
    expect(dashboard).not.toMatch(/\bTop Movers\b/);
    expect(dashboard).not.toMatch(/>\s*cached\s*</i);
    expect(dashboard).not.toMatch(/>\s*unavailable\s*</i);
    expect(dashboard).not.toContain('provider error');
  });

  it('keeps mobile market cards scroll-contained and desktop cards in a grid', () => {
    const dashboard = read('src/components/dashboard/DashboardClient.tsx');
    expect(dashboard).toContain('overflow-x-auto');
    expect(dashboard).toContain('snap-mandatory');
    expect(dashboard).toContain('xl:grid-cols-4');
  });

  it('keeps the compact service status readable without truncating its Thai label', () => {
    const dashboard = read('src/components/dashboard/DashboardClient.tsx');
    expect(dashboard).toContain('grid min-h-11 cursor-pointer');
    expect(dashboard).toContain('sm:flex sm:items-center sm:justify-between');
    expect(dashboard).not.toContain(
      'truncate font-medium text-[var(--text-secondary)]">{data.label}',
    );
  });

  it('provides a shareable Industry Detail route', () => {
    expect(read('app/industry/[slug]/page.tsx')).toContain('loadIndustryDetail');
    expect(read('src/components/dashboard/DashboardClient.tsx')).toContain('/industry/');
  });

  it('summarizes every Portfolio ledger through the shared aggregate and option quote pipeline', () => {
    const page = read('app/page.tsx');
    const portfolio = read('src/components/portfolio/PortfolioClient.tsx');
    const overview = read('src/lib/overview/portfolio-summary.ts');
    expect(page).toContain('buildOverviewPortfolio');
    expect(overview).toContain('calculatePortfolio(portfolio.transactions');
    expect(overview).toContain('aggregatePortfolioSummaries(summaries)');
    expect(portfolio).toContain('aggregatePortfolioSummaries(portfolios.map');
    expect(page).toContain('loadPortfolioOptionQuotes');
    expect(overview).toContain('portfolioValuationCoverage');
  });

  it('uses one bounded batch snapshot for market breadth and never blocks Home SSR on it', () => {
    const page = read('app/page.tsx');
    const breadth = read('src/lib/overview/market-breadth.ts');
    expect(page).toContain('loadMarketBreadthSnapshot');
    expect(page).toContain('warmMarketBreadth');
    expect(page).not.toMatch(/await\s+loadMarketBreadth\(/);
    expect(breadth).toContain('/v2/stocks/snapshots');
    expect(breadth).toContain("url.searchParams.set('symbols'");
    expect(breadth).toContain('CONCURRENCY = 3');
    expect(breadth).not.toContain('/v2/stocks/{symbol}');
  });

  it('loads Industry history after SSR and renders only a paginated constituent slice', () => {
    const detail = read('src/components/industry/IndustryDetailClient.tsx');
    expect(detail).toContain('/api/market/industry/');
    expect(detail).toContain('PAGE_SIZE = 20');
    expect(detail).toContain('visibleMembers.map');
    expect(detail).toContain('rollbackWatchlistChange');
  });
});
