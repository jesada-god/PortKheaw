import { notFound } from 'next/navigation';
import Header from '@/src/components/layout/Header';
import { MarketEventsFeed } from '@/src/components/market-events/MarketEventsFeed';
import { marketEventsCardEnabled } from '@/src/config/features';
import { buildEventFeed, exposureNoteTh } from '@/src/lib/market-events/feed';
import { createClient } from '@/src/lib/supabase/server';
import { PortfolioRepository } from '@/src/lib/portfolio/repository';

/**
 * ปฏิทินเศรษฐกิจ — the feed behind the overview card.
 *
 * ===========================================================================
 * THE FLAG IS CHECKED HERE, AND THE ROUTE DISAPPEARS WHEN IT IS OFF
 * ===========================================================================
 * `notFound()` rather than an empty page: with `MARKET_EVENTS_CARD` unset there
 * is no card linking here, so anybody arriving typed the URL, and the honest
 * answer is that the page does not exist yet. A blank page would suggest the
 * feature exists and is broken.
 *
 * ===========================================================================
 * NO PROVIDER CALL, AND ONE CHEAP DATABASE READ
 * ===========================================================================
 * The calendar is a static file in the bundle, so the feed itself costs
 * nothing. The only thing loaded is the reader's own portfolio rows — to COUNT
 * them, which is the single honest thing this page can say about their exposure
 * to a market-wide release. No quotes are fetched: a count of holdings does not
 * need their prices, and asking for them would put a market-data call behind a
 * page that has no figures on it.
 *
 * A failed read counts zero rather than failing the page. The calendar is the
 * point of the route and it does not depend on knowing who is reading.
 */
export default async function MarketEventsPage() {
  if (!marketEventsCardEnabled()) notFound();

  const now = new Date().toISOString();
  const client = await createClient();
  const user = client ? (await client.auth.getUser()).data.user : null;

  let holdingCount = 0;
  if (client && user) {
    const portfolios = await new PortfolioRepository(client).getAll().catch(() => []);
    /*
     * DISTINCT symbols the reader has ever transacted in, which is the same
     * definition `app/page.tsx` uses to decide which prices to load. Counting
     * transactions instead would say "42 holdings" to somebody who owns six
     * things and has traded them.
     */
    holdingCount = new Set(portfolios
      .flatMap((portfolio) => portfolio.transactions)
      .filter((item) =>
        item.type === 'acquisition'
        || item.type === 'disposal'
        || item.type === 'initial_position')
      .map((item) => item.symbol)
      .filter((value): value is string => Boolean(value))).size;
  }

  const days = buildEventFeed({ now });

  return (
    <div className="min-w-0">
      <Header
        title="ปฏิทินเศรษฐกิจ"
        subtitle="ตัวเลขเศรษฐกิจสหรัฐที่ประกาศตามกำหนด เวลาไทย"
      />
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-8">
        <MarketEventsFeed days={days} exposureNoteTh={exposureNoteTh(holdingCount)} />
        {/*
          Where the dates came from, on the page that shows them. Each one was
          transcribed from the publishing agency's own schedule, and a reader who
          wants to check a row should not have to take that on trust.
        */}
        <p className="px-1 text-[11px] leading-5 text-[var(--text-muted)]" data-testid="market-events-sources">
          ที่มาของกำหนดการ: BLS (CPI, PPI, การจ้างงาน), BEA (GDP, PCE),
          Federal Reserve (FOMC) และ DOL (ยอดขอรับสวัสดิการว่างงาน)
        </p>
      </div>
    </div>
  );
}
