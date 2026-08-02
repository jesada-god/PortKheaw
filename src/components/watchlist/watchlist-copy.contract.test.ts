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
    expect(dashboard).toContain("href: '/watchlist'");
    expect(dashboard).toContain("retrying.watchlist");
  });
});
