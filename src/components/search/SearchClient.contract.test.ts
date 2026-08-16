import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const client = readFileSync(join(process.cwd(), 'src/components/search/SearchClient.tsx'), 'utf8');
const page = readFileSync(join(process.cwd(), 'app/search/page.tsx'), 'utf8');

/**
 * Search is a navigation tool. These assert the two things that makes true: a
 * result goes to the instrument it names, and a row carries only what is needed
 * to recognise it — never the analysis that belongs on Stock Detail.
 */
describe('search result contract', () => {
  it('opens Stock Detail and records the term as a recent search', () => {
    expect(client).toContain("router.push(`/stock/${encodeURIComponent(symbol)}`)");
    expect(client).toContain('addRecentSearch(symbol)');
    expect(client).toContain('onClick={() => openSymbol(result.symbol)}');
  });

  it('shows a logo, symbol, name, asset type and a bounded latest price', () => {
    expect(client).toContain('<InstrumentLogo');
    expect(client).toContain('{result.name}');
    expect(client).toContain('{result.assetType}');
    expect(client).toContain('PRICED_RESULT_LIMIT = 6');
    expect(client).toContain('payload.data.slice(0, PRICED_RESULT_LIMIT)');
  });

  it('keeps fundamentals and charts out of the result row', () => {
    for (const banned of ['P/E', 'peRatio', 'marketCapitalization', 'sector', 'MiniLine', 'sparkline']) {
      expect(client).not.toContain(banned);
    }
  });

  it('marks a symbol that is already followed, from server state rather than a guess', () => {
    expect(page).toContain('WatchlistRepository');
    expect(page).toContain('watchedSymbols={watchedSymbols}');
    expect(client).toContain('watched.has(result.symbol)');
  });

  it('reuses the existing search endpoint rather than a new backend', () => {
    expect(client).toContain('/api/market/search?q=');
    expect(client).toContain('/api/market/quote/');
  });
});
