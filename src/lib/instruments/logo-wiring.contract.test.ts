import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Every surface that draws an instrument must read the one resolver.
 *
 * Asserted against the source because that is where the defect lived: each page
 * rendered `InstrumentLogo` correctly and simply had no URL in scope, so it
 * passed `null` — a mistake no rendering test can see, since the component was
 * doing exactly what it was told.
 */
const read = (relative: string) => readFileSync(
  new URL(`../../../${relative}`, import.meta.url),
  'utf8',
);

describe('instrument logo wiring', () => {
  it('resolves Portfolio holdings through the shared resolver and provider', () => {
    const page = read('app/portfolio/page.tsx');
    expect(page).toContain('InstrumentLogoProvider');
    expect(page).toContain('instrument.logoUrl');
    const service = read('src/lib/overview/service.ts');
    // loadPortfolioPrices must go through the presentation resolver, not the
    // bare instrument master, or holdings fall back to monograms.
    expect(service).toMatch(/loadPortfolioPrices[\s\S]{0,400}getInstrumentPresentationMetadata/);
  });

  it('resolves the watchlist and Stock Detail through the same resolver', () => {
    expect(read('app/watchlist/page.tsx')).toContain('getInstrumentPresentationMetadata');
    expect(read('app/stock/[symbol]/page.tsx')).toContain('getInstrumentPresentationMetadata');
  });

  it('carries a persisted logo into search results', () => {
    expect(read('src/lib/instruments/search.ts')).toContain('readPersistedLogos');
    expect(read('app/search/page.tsx')).toContain('result.logoUrl');
    expect(read('src/components/portfolio/SymbolPreview.tsx')).toContain('result.logoUrl');
  });

  it('leaves no page passing a hardcoded null logo', () => {
    for (const file of [
      'src/components/portfolio/PortfolioClient.tsx',
      'app/search/page.tsx',
      'src/components/portfolio/SymbolPreview.tsx',
    ]) {
      expect(read(file)).not.toContain('logoUrl={null}');
    }
  });

  it('resolves a first-seen symbol in the mutation that creates its row', () => {
    const watchlist = read('app/watchlist/actions.ts');
    expect(watchlist).toContain('ensureInstrumentLogo');
    expect(watchlist).toContain('logoUrl: logo.logoUrl');
    const portfolio = read('app/portfolio/actions.ts');
    expect(portfolio).toContain('ensureInstrumentLogo(openingSymbol)');
    // And the clients apply it instead of seeding the row with a null.
    expect(read('src/components/watchlist/WatchlistClient.tsx'))
      .toContain('rememberInstrumentLogo(symbol, result.logoUrl)');
    expect(read('src/components/portfolio/PortfolioClient.tsx'))
      .toContain('rememberInstrumentLogo(');
  });

  it('adds no browser request for what the mutation already answered', () => {
    const client = read('src/components/watchlist/WatchlistClient.tsx');
    // The row's identity comes back with the row; nothing re-fetches it.
    expect(client).not.toContain('requestCompanyProfile');
    expect(client).toContain('result.companyName');
  });

  it('warms search results after the response, never in front of it', () => {
    const route = read('app/api/market/search/route.ts');
    expect(route).toContain('after(');
    expect(route).toContain('ensureInstrumentLogos');
    expect(route).toContain('SEARCH_LOGO_WARM_LIMIT');
  });

  it('never times a logo out — a lazy or cached image is not a failure', () => {
    const component = read('src/components/instruments/InstrumentLogo.tsx');
    expect(component).not.toContain('setTimeout');
    expect(component).toContain('node.naturalWidth === 0');
  });
});
