import { notFound } from 'next/navigation';
import { symbolSchema } from '@/src/lib/market-data/validation';
import { getFxRate } from '@/src/lib/market-data/fx/service';
import { createClient } from '@/src/lib/supabase/server';
import { WatchlistRepository } from '@/src/lib/watchlist/repository';
import { StockDetailClient } from '@/src/components/stock/StockDetailClient';
import { loadEntitledMarketSignal } from '@/src/lib/analytics/market-signal/entitled-service';
import { loadStockDetailGatewaySnapshot } from '@/src/lib/stock-detail/gateway-snapshot';
import { marketDataGatewayConfigured } from '@/src/lib/market-data/gateway/service';
import { getInstrumentMetadata } from '@/src/lib/instruments/master';
import { resolvePageEntitlement } from '@/src/lib/subscription/page-entitlement';
import {
  advancedChartTypesEnabled,
  analystConsensusEnabled,
  extendedIndicatorsEnabled,
  keyStatisticsEnabled,
  supportResistanceEnabled,
  technicalIndicatorsEnabled,
} from '@/src/config/features';

async function isWatched(symbol: string): Promise<boolean> {
  const client = await createClient();
  if (!client) return false;
  try {
    return (await new WatchlistRepository(client).getDefault())
      .items.some((item) => item.symbol === symbol);
  } catch {
    return false;
  }
}

export default async function StockDetailPage({
  params,
}: {
  params: Promise<{ symbol: string }>;
}) {
  const rawSymbol = decodeURIComponent((await params).symbol);
  const parsed = symbolSchema.safeParse(rawSymbol);
  if (!parsed.success) notFound();
  const symbol = parsed.data;
  const entitlement = await resolvePageEntitlement();

  const [
    marketResult,
    fxResult,
    watchResult,
    signalResult,
    instrumentMetadataResult,
  ] = await Promise.allSettled([
    loadStockDetailGatewaySnapshot(symbol),
    getFxRate('USD', 'THB'),
    isWatched(symbol),
    loadEntitledMarketSignal(symbol, entitlement.tier),
    getInstrumentMetadata([symbol]),
  ]);

  if (marketResult.status === 'rejected') {
    throw marketResult.reason;
  }
  const snapshot = marketResult.value;

  return (
    <StockDetailClient
      symbol={symbol}
      quoteResource={snapshot.quote}
      profileResource={snapshot.profile}
      overviewResource={snapshot.overview}
      instrumentName={snapshot.instrument.name}
      instrumentCurrency={snapshot.instrument.currency}
      instrumentExchange={snapshot.instrument.exchange}
      instrumentLogoUrl={instrumentMetadataResult.status === 'fulfilled'
        ? instrumentMetadataResult.value.get(symbol)?.logoUrl ?? null
        : null}
      initialHistory={snapshot.history}
      fxQuote={fxResult.status === 'fulfilled' ? fxResult.value.quote : null}
      evaluatedAt={new Date().toISOString()}
      extendedQuote={snapshot.extendedQuote}
      providerConfigured={marketDataGatewayConfigured()}
      initialWatched={watchResult.status === 'fulfilled' ? watchResult.value : false}
      technicalIndicatorsEnabled={technicalIndicatorsEnabled()}
      advancedChartTypesEnabled={advancedChartTypesEnabled()}
      extendedIndicatorsEnabled={extendedIndicatorsEnabled()}
      supportResistanceEnabled={supportResistanceEnabled()}
      keyStatisticsEnabled={keyStatisticsEnabled()}
      analystConsensusEnabled={analystConsensusEnabled()}
      marketSignal={signalResult.status === 'fulfilled' ? signalResult.value : null}
    />
  );
}
