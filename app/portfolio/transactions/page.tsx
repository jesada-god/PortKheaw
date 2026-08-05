import Header from '@/src/components/layout/Header';
import { TransactionHistoryClient } from '@/src/components/portfolio/TransactionHistoryClient';
import { createClient } from '@/src/lib/supabase/server';
import { PortfolioRepository } from '@/src/lib/portfolio/repository';
import { getFxRate } from '@/src/lib/market-data/fx/service';
import { resolvePageEntitlement } from '@/src/lib/subscription/page-entitlement';

/*
 * The statement route. It loads no market prices at all: a history of what was
 * recorded needs the ledger and nothing else, which keeps this page fast and
 * keeps the portfolio's live valuation the sole business of `/portfolio`.
 */
export default async function PortfolioTransactionsPage({ searchParams }: {
  searchParams: Promise<{ portfolio?: string }>;
}) {
  const client = await createClient();
  if (!client) return null;
  const repository = new PortfolioRepository(client);
  const [portfolios, timezone, entitlement, fx, params] = await Promise.all([
    repository.getAll(),
    repository.getTimeZone(),
    resolvePageEntitlement(),
    (async () => {
      try { return await getFxRate('USD', 'THB'); }
      catch { return { quote: null, unavailable: true }; }
    })(),
    searchParams,
  ]);

  const requested = params.portfolio;
  const initialPortfolioId = requested && portfolios.some((item) => item.id === requested)
    ? requested
    : 'all';

  return <div className="min-w-0">
    <Header title="ประวัติเงินเข้า–ออก" subtitle="ทุกรายการอ่านจาก Transaction Ledger เดิม ไม่มีตารางประวัติแยกต่างหาก" />
    <TransactionHistoryClient
      portfolios={portfolios}
      initialPortfolioId={initialPortfolioId}
      fx={fx}
      timezone={timezone}
      effectiveTier={entitlement.effectiveAccessTier}
    />
  </div>;
}
