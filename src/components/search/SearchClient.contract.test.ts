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

  /*
   * The defect this replaces: the panel rendered `payload.error.message`, so a
   * failing search printed the API's own sentence — an endpoint, a status line,
   * occasionally a provider slug — into the results list.
   *
   * The message is still READ, because it is the most useful thing to put in the
   * console, but the only place it goes is `reportDataError`.
   */
  it('never renders what the API said went wrong', () => {
    expect(client).toContain("reportDataError('search', cause)");
    expect(client).not.toMatch(/setError\(|\{error\}|error\.message\}/);
    // The one read of the provider's text feeds an Error the catch block logs.
    expect(client).toContain("throw new Error(payload.error?.message ?? 'search failed')");
  });

  it('has all four data states and holds them in one field', () => {
    expect(client).toContain('<DataState');
    for (const state of ["setState('loading')", "setState('error')", "'empty' : 'ready'"]) {
      expect(client).toContain(state);
    }
    // A `loading` boolean beside an `error` string could hold two answers at
    // once, and the abort path used to produce exactly that combination.
    expect(client).not.toContain('setLoading(');
  });

  it('draws the loading state at the shape of the rows it will become', () => {
    expect(client).toContain('skeleton={<ResultsSkeleton />}');
    /*
     * Comments stripped first: the block above `ResultsSkeleton` quotes the
     * sentence it replaced, and a source-reading test that could not tell code
     * from the note explaining it would forbid documenting the change.
     */
    const code = client.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('กำลังค้นหา');
  });

  /*
   * The panel was the last surface carrying the pre-token palette by hand —
   * `#151B28`, `#D4FF00` and a dozen `slate-*` classes — which is why it did not
   * follow a theme change and read as a different product in light mode.
   */
  it('carries no literal colour', () => {
    expect(client).not.toMatch(/#[0-9A-Fa-f]{6}/);
    expect(client).not.toMatch(/\b(slate|emerald|amber|sky|zinc|gray)-\d{3}\b/);
  });

  it('says delisted in the reader’s language', () => {
    expect(client).toContain('เลิกซื้อขายแล้ว');
    expect(client).not.toContain('DELISTED');
  });
});
