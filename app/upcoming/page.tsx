import { redirect } from 'next/navigation';
import Header from '@/src/components/layout/Header';
import { UpcomingSection } from '@/src/components/upcoming/UpcomingSection';
import { AlertsRepository } from '@/src/lib/alerts/repository';
import { calculateOptionLedger } from '@/src/lib/portfolio/options/calculations';
import { PortfolioRepository } from '@/src/lib/portfolio/repository';
import { WatchlistRepository } from '@/src/lib/watchlist/repository';
import { loadPortfolioPrices } from '@/src/lib/overview/service';
import { createClient } from '@/src/lib/supabase/server';
import { buildUpcomingFeed, type UpcomingAlertInput } from '@/src/lib/upcoming/build';
import { loadUpcomingEarnings, upcomingEarningsSymbols } from '@/src/lib/upcoming/service';

/**
 * The whole list behind the Home card.
 *
 * Same builder, same sources, no limit — the card and this page can never
 * disagree about what is coming up or in what order, because only one of them
 * decides. Nothing new is stored or scheduled here; it is a read.
 */
export default async function UpcomingPage() {
  const client = await createClient();
  if (!client) return null;
  const user = (await client.auth.getUser()).data.user;
  if (!user) redirect('/auth/sign-in?next=/upcoming');

  const [portfolios, watchlist, alerts] = await Promise.all([
    new PortfolioRepository(client).getAll().catch(() => []),
    new WatchlistRepository(client).getDefault().then((record) => record.items.map((item) => item.symbol)).catch(() => []),
    new AlertsRepository(client, user.id).list().catch(() => []),
  ]);

  /*
   * Contract status and days-to-expiry come out of the ledger replay itself, so
   * this needs no option quotes at all — the expiry rows cost one pure
   * calculation over transactions already read.
   */
  const positions = portfolios.flatMap((portfolio) => calculateOptionLedger(portfolio.transactions).positions);
  const heldSymbols = [...new Set(portfolios.flatMap((portfolio) => portfolio.transactions)
    .filter((item) => item.type === 'acquisition' || item.type === 'disposal' || item.type === 'initial_position')
    .map((item) => item.symbol)
    .filter((value): value is string => Boolean(value)))];

  // Only the symbols an alert actually names need a price here.
  const alertSymbols = [...new Set(alerts.filter((alert) => alert.enabled).map((alert) => alert.symbol))];
  const [prices, earnings] = await Promise.all([
    alertSymbols.length > 0 ? loadPortfolioPrices(alertSymbols).catch(() => new Map()) : Promise.resolve(new Map()),
    loadUpcomingEarnings(upcomingEarningsSymbols(heldSymbols, watchlist), { deadlineMs: 4_000 }),
  ]);
  const alertInputs: UpcomingAlertInput[] = alerts.map((alert) => ({
    id: alert.id,
    symbol: alert.symbol,
    condition: alert.condition,
    targetValue: alert.targetValue,
    enabled: alert.enabled,
    price: prices.get(alert.symbol)?.display.price ?? null,
    changePercent: prices.get(alert.symbol)?.display.changePercent ?? null,
  }));

  const feed = buildUpcomingFeed({ earnings, positions, alerts: alertInputs });

  return <div className="min-w-0">
    <Header title="สิ่งที่ควรรู้" subtitle="วันประกาศผลประกอบการ วันหมดอายุสัญญา และการแจ้งเตือนที่ใกล้ถึง" />
    <main className="mx-auto w-full max-w-3xl space-y-4 p-3 sm:p-4 md:p-6">
      <UpcomingSection feed={feed} variant="full" />
      <p className="text-xs leading-6 text-[var(--text-muted)]">
        แสดงเฉพาะเหตุการณ์ที่มีข้อมูลยืนยันได้จริงจากปฏิทินผลประกอบการ สัญญาออปชันในพอร์ต และการแจ้งเตือนที่คุณตั้งไว้
        รายการที่ยังไม่มีข้อมูลจะไม่ถูกแสดง และไม่มีการคาดเดาวันที่
      </p>
    </main>
  </div>;
}
