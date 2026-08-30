import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  OVERVIEW_ORDER_V1,
  OVERVIEW_ORDER_V2,
} from '@/src/lib/overview/section-order';

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

  /*
    Home answers, in order: what is mine, what am I watching, what is the market
    doing, what is coming up, what is being said. The technical readouts are all
    still on the page — nothing was deleted — but one disclosure below, because
    they answer a question a reader asks occasionally rather than every visit.
  */
  /*
   * The order itself is no longer asserted here, and that is the point of this
   * test now.
   *
   * It used to be a source scan for the position of six JSX tags, which could
   * only ever describe ONE order and had to be rewritten the moment a second
   * one existed behind a flag. The sequence is data now — `section-order.ts` —
   * and it is proved in `section-order.test.ts` across all 128 on/off subsets,
   * which is the thing a scan for tag positions could never check: that the
   * order still holds when a card disappears from the MIDDLE.
   *
   * What is left here is the structural claim the run depends on: the market
   * block leads, and everything after it is rendered from the ordered list
   * rather than from a hand-written sequence that could drift from it.
   */
  it('renders Home sections from the ordered list, with the market block leading', () => {
    const dashboard = read('src/components/dashboard/DashboardClient.tsx');
    const body = dashboard.slice(dashboard.indexOf('<main className="mx-auto w-full max-w-[1440px]'));
    const run = body.indexOf('{sections.map((key) => (');
    expect(run).toBeGreaterThan(-1);
    expect(dashboard).toContain('orderedOverviewSections({');
    /*
      "The market block leads" used to be a claim about where a fixed
      `<section>` sat in this file, because that block was rendered above the
      run and outside it — which also made it the one section the ordering flag
      could not move. It is a key now, so the claim moved to the data: both
      orders open with it, `section-order.test.ts` holds that across every
      subset, and what is left here is the structural half — it reaches the page
      through the map like everything else.
    */
    expect(OVERVIEW_ORDER_V1[0]).toBe('marketToday');
    expect(OVERVIEW_ORDER_V2[0]).toBe('marketToday');
    // Every managed section reaches the page through the map, not beside it.
    for (const marker of [
      'id="market-overview"',
      '<PortfolioSummaryLine',
      '<WatchlistSection',
      '<ChangesSection',
      '<ChangesList',
      '<UpcomingSection',
      '<EventsList',
      '<NewsSection',
      '<MarketStatusCard',
      '<MarketEventsCard',
    ]) {
      expect(dashboard.indexOf(marker), `${marker} must be in sectionNodes`)
        .toBeGreaterThan(-1);
      expect(body.indexOf(marker), `${marker} must not be rendered outside the run`)
        .toBe(-1);
    }
  });

  /*
   * The market leads, and the portfolio is second rather than absent.
   *
   * Everything below the market is read against it: a portfolio down 1.2% on a
   * day the market is down 1.4% is a different fact from the same 1.2% on a
   * green day, and the previous order asked a reader to carry their own number
   * down the page to find out which day they were having.
   *
   * What made that affordable is the second assertion. The portfolio block was
   * a scope selector, four figures, a three-facet strip, the goal card and a
   * four-way link row — it could not follow anything and still leave the
   * watchlist above the fold on a handset. It is a line now, and `/portfolio`
   * is where all of it still lives.
   */
  it('leads with the market and keeps the portfolio to a line above the watchlist', () => {
    const dashboard = read('src/components/dashboard/DashboardClient.tsx');
    expect(dashboard).toContain('<PortfolioSummaryLine');
    expect(dashboard).not.toContain('<PortfolioCard');
    // The detail is not deleted, it is one tap away.
    expect(dashboard).toContain('href="/portfolio"');
  });

  /*
   * "สิ่งที่เปลี่ยนไป" is built from the watchlist rows the page already has,
   * and it renders nothing on a quiet day. Both halves are load-bearing: the
   * first is what keeps it inside Phase 1 (no new request, no new engine), and
   * the second is what stops a section heading standing over
   * "ไม่มีการเปลี่ยนแปลง" every other morning.
   */
  it('derives what changed from data already on the page, and hides itself when nothing did', () => {
    const dashboard = read('src/components/dashboard/DashboardClient.tsx');
    expect(dashboard).toContain('buildOverviewChanges(view.watchlist)');
    const section = dashboard.slice(dashboard.indexOf('function ChangesSection'));
    expect(section.slice(0, 400)).toContain('if (changes.length === 0) return null;');

    const changes = read('src/lib/overview/changes.ts');
    for (const forbidden of ['fetch(', 'useState', 'await ', 'new Date(']) {
      expect(changes, `changes.ts must stay a pure function of the payload`).not.toContain(forbidden);
    }
  });

  it('keeps breadth, the industry ranking and the service status reachable behind one disclosure', () => {
    const dashboard = read('src/components/dashboard/DashboardClient.tsx');
    const disclosure = dashboard.slice(dashboard.indexOf('ข้อมูลเชิงลึกของตลาดและสถานะระบบ'));
    for (const section of ['<ServiceStatus', '<IndustryRanking', '<BreadthSection']) {
      expect(disclosure).toContain(section);
    }
  });

  it('builds the Upcoming feed on the server from sources the page already loaded', () => {
    const page = read('app/page.tsx');
    expect(page).toContain('buildUpcomingFeed');
    expect(page).toContain('loadUpcomingEarnings');
    // The option rows come from the ledger replay, not a second option pipeline.
    expect(page).toContain('portfolioOverview.summary?.optionPositions');
    expect(page).not.toMatch(/loadPortfolioOptionQuotes\([^)]*upcoming/);
  });

  /*
   * ===========================================================================
   * THE REORDERING COSTS NOTHING, AND THE CALENDAR COSTS NOTHING
   * ===========================================================================
   * Sequencing sections must not buy data. Every section in the run was already
   * being rendered from a payload this page already built — `orderedOverviewSections`
   * takes booleans and returns keys, so it cannot reach a provider even in
   * principle.
   *
   * The calendar card is the one addition, and it is a STATIC FILE: the view is
   * built from `market-events-2026.json`, which is imported into the bundle. So
   * `MARKET_EVENTS_CARD` decides pixels only — unlike `MARKET_STATUS_CARD`,
   * which also gates six provider calls, and that difference is the thing this
   * test pins.
   *
   * The `/market-events` route is held to the same rule: it reads the reader's
   * portfolio rows to COUNT them and asks for no quotes, because a count does
   * not need prices.
   */
  it('adds no provider call for the section order or the calendar card', () => {
    /*
     * Comments stripped first. Every one of these files EXPLAINS what it does
     * not do — "a gap reads as a load that never finished" is prose about the
     * bug being prevented, and a scan that could not tell it from a call would
     * forbid documenting the guarantee. Same distinction `no-banned-copy` draws.
     */
    const code = (relative: string) => read(relative)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*/g, '');

    const order = code('src/lib/overview/section-order.ts');
    for (const forbidden of ['fetch(', 'await ', 'load', 'provider']) {
      expect(order, 'the ordering module must stay a pure function of booleans')
        .not.toContain(forbidden);
    }

    const cardView = code('src/lib/market-events/card-view.ts');
    expect(cardView).not.toContain('fetch(');
    expect(cardView).not.toContain('await ');

    const calendar = code('src/lib/market-events/calendar.ts');
    expect(calendar).toContain("import calendarFile from '@/src/data/market-events-2026.json'");
    expect(calendar).not.toContain('fetch(');

    const page = read('app/page.tsx');
    expect(page).toContain('buildMarketEventsCardView({ now: generatedAt })');
    // Built inline, not awaited — there is nothing to wait for.
    expect(page).not.toMatch(/await\s+buildMarketEventsCardView/);

    const route = code('app/market-events/page.tsx');
    expect(route).not.toMatch(/loadOverviewPrice|loadMarketIndices|loadWatchlistPrices|getQuote/);
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
