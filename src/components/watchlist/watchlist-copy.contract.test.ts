import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const visibleSurfaces = [
  'app/offline/page.tsx',
  'app/search/page.tsx',
  'app/watchlist/actions.ts',
  'app/watchlist/loading.tsx',
  'app/watchlist/page.tsx',
  'src/components/dashboard/DashboardClient.tsx',
  'src/components/industry/IndustryDetailClient.tsx',
  'src/components/layout/FloatingDock.tsx',
  'src/config/navigation.ts',
  'src/components/stock/StockDetailClient.tsx',
  'src/components/ui/OfflineNotice.tsx',
  'src/components/watchlist/WatchlistClient.tsx',
] as const;

const stringLiteralWithEnglishWatchlist = /(['"`])(?!@\/)[^'"`\r\n]*Watchlist[^'"`\r\n]*\1/g;

describe('รายการติดตาม visible-copy contract', () => {
  it('does not expose the English Watchlist label on user-visible surfaces', () => {
    for (const file of visibleSurfaces) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      expect(source.match(stringLiteralWithEnglishWatchlist), file).toBeNull();
    }
  });

  it('keeps Thai navigation, heading, action, state, toast, and accessibility copy', () => {
    const source = visibleSurfaces
      .map((file) => readFileSync(resolve(process.cwd(), file), 'utf8'))
      .join('\n');
    for (const copy of [
      'รายการติดตาม',
      'รายการติดตามยังว่าง',
      'เพิ่มในรายการติดตามแล้ว',
      'ออกจากรายการติดตาม',
      'แก้ไขรายการติดตามไม่ได้ขณะออฟไลน์',
    ]) expect(source).toContain(copy);
  });

  it('preserves the internal route identifier', () => {
    const dashboard = readFileSync(
      resolve(process.cwd(), 'src/components/dashboard/DashboardClient.tsx'),
      'utf8',
    );
    /*
     * The section keeps its OWN link to the route, rather than the route
     * reappearing as an object in some quick-link `actions` array.
     *
     * The route used to appear twice on this page: once in the portfolio card's
     * four-way quick-link row, and once as the "ดูทั้งหมด" link in the watchlist
     * section's own header. Phase 1 condensed the portfolio block to a line and
     * the quick-link row went with it, so the section's own link is the one that
     * survives — which is the better of the two anyway: it sits beside the rows
     * it expands.
     *
     * The assertion was `href="/watchlist"` until the preview card learned to
     * link at a SPECIFIC list, which made the href an expression rather than a
     * literal attribute. What is being guarded is unchanged and is still
     * guarded: the route appears in this file, in a `href`, and not as a
     * `href: '/watchlist'` property. Both forms are checked so the string
     * cannot quietly move back into an actions array.
     */
    // `.` never crosses a line break in a JS regex, so this cannot match across rows.
    expect(dashboard).toMatch(/href=.*\/watchlist/);
    expect(dashboard).not.toContain("href: '/watchlist'");
    expect(dashboard).toContain("retrying.watchlist");
  });
});
