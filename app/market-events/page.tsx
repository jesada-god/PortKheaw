import { notFound } from 'next/navigation';
import Header from '@/src/components/layout/Header';
import { MarketEventsFeed } from '@/src/components/market-events/MarketEventsFeed';
import { MonthCalendar } from '@/src/components/market-events/MonthCalendar';
import { marketEventsCardEnabled } from '@/src/config/features';
import { buildEventFeed, exposureNoteTh, splitFeedForPanel } from '@/src/lib/market-events/feed';
import { buildMarketEventsMonthView } from '@/src/lib/market-events/month-view';
import { createClient } from '@/src/lib/supabase/server';
import { PortfolioRepository } from '@/src/lib/portfolio/repository';

/**
 * ปฏิทินเศรษฐกิจ — the month, the day inside it, and everything still coming.
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
 * THE MONTH AND THE DAY ARE READ OFF THE URL, ON THE SERVER
 * ===========================================================================
 * `?m=2026-10&d=2026-10-13` is the whole state of the calendar. The reasoning
 * is in the header of `month-view.ts`; what matters at this level is that both
 * values are UNTRUSTED — they arrive from an address bar, a stale bookmark and
 * a crawler — and that `buildMarketEventsMonthView` turns a bad one into a
 * fallback rather than an exception. Nothing on this page throws over a query
 * string.
 *
 * ===========================================================================
 * THE FEED STAYS, AND IT IS NOT A DUPLICATE OF THE PANEL
 * ===========================================================================
 * The panel under the grid answers "what is on THIS day"; the feed answers
 * "what is still coming", which is a different question and the one a reader
 * arrives with. It also carries the `id={dayKey}` anchors that the overview
 * card's cells have always linked to — `/market-events#2026-10-13` still lands
 * where it always did, and that link was shipped before this page had a grid.
 *
 * ===========================================================================
 * NO PROVIDER CALL, AND ONE CHEAP DATABASE READ
 * ===========================================================================
 * The calendar is a static file in the bundle, so both the grid and the feed
 * cost nothing. The only thing loaded is the reader's own portfolio rows — to
 * COUNT them, which is the single honest thing this page can say about their
 * exposure to a market-wide release. No quotes are fetched: a count of holdings
 * does not need their prices, and asking for them would put a market-data call
 * behind a page that has no figures on it.
 *
 * A failed read counts zero rather than failing the page. The calendar is the
 * point of the route and it does not depend on knowing who is reading.
 */
export default async function MarketEventsPage({
  searchParams,
}: {
  searchParams: Promise<{ m?: string; d?: string }>;
}) {
  if (!marketEventsCardEnabled()) notFound();

  const now = new Date().toISOString();
  const { m, d } = await searchParams;
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

  const month = buildMarketEventsMonthView({ now, monthParam: m, dayParam: d });
  /*
   * THE PANEL AND THE FEED MUST NOT BOTH DRAW THE SAME DAY.
   *
   * The panel under the grid opens on today by default and the feed starts at
   * today, so the page printed "วันนี้ · 4 ก.ย. · NFP" twice in a row and gave
   * a reader no way to tell a repeat from a second release. The day the panel
   * has already expanded comes out of the feed — see `splitFeedForPanel` for
   * why the day is removed rather than the feed being started a day later.
   */
  const { days, hiddenDayKey } = splitFeedForPanel({
    days: buildEventFeed({ now }),
    panelDayKey: month?.selected?.dayKey ?? null,
  });

  return (
    <div className="min-w-0">
      <Header
        title="ปฏิทินเศรษฐกิจ"
        subtitle="ตัวเลขเศรษฐกิจสหรัฐที่ประกาศตามกำหนด เวลาไทย"
      />
      <div className="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-8">
        {/*
          Null only when the server's own clock could not be read as an instant,
          which is not a state worth an error panel — the feed below still
          renders and still answers the reader's question.
        */}
        {month && <MonthCalendar view={month} />}
        <MarketEventsFeed
          days={days}
          hiddenDayKey={hiddenDayKey}
          exposureNoteTh={exposureNoteTh(holdingCount)}
        />
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
