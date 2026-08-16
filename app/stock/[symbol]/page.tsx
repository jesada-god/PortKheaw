import { notFound } from 'next/navigation';
import { symbolSchema } from '@/src/lib/market-data/validation';
import { getFxRate } from '@/src/lib/market-data/fx/service';
import { createClient } from '@/src/lib/supabase/server';
import { WatchlistRepository } from '@/src/lib/watchlist/repository';
import { StockDetailClient } from '@/src/components/stock/StockDetailClient';
import { loadEntitledMarketSignal } from '@/src/lib/analytics/market-signal/entitled-service';
import { loadEarningsSchedule } from '@/src/lib/analytics/earnings/service';
import { recordBetaFunnelEvent } from '@/src/lib/beta/beta-server';
import { loadStockDetailGatewaySnapshot } from '@/src/lib/stock-detail/gateway-snapshot';
import { marketDataGatewayConfigured } from '@/src/lib/market-data/gateway/service';
import { getInstrumentPresentationMetadata } from '@/src/lib/instruments/presentation';
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
    earningsResult,
  ] = await Promise.allSettled([
    loadStockDetailGatewaySnapshot(symbol),
    getFxRate('USD', 'THB'),
    isWatched(symbol),
    loadEntitledMarketSignal(symbol, entitlement.effectiveAccessTier),
    getInstrumentPresentationMetadata([symbol]),
    /*
     * The same calendar service the Options Signal engine reads, on the same
     * twelve-hour cache — one symbol, resolved beside everything else this page
     * already loads. A refusal or an outage resolves to the service's own typed
     * unavailable state, which the summary card renders as no row at all.
     */
    loadEarningsSchedule(symbol),
  ]);

  if (marketResult.status === 'rejected') {
    throw marketResult.reason;
  }
  const snapshot = marketResult.value;
  const canonicalSymbol = snapshot.instrument.canonicalSymbol;

  /*
   * "Did anybody read about a stock today?" — and deliberately not "which one".
   * The event carries no symbol: the product question is whether this surface is
   * used, and recording what a reader is interested in would answer a question
   * nobody asked with data nobody needs.
   */
  void recordBetaFunnelEvent({ event: 'stock_detail_viewed' }).catch(() => {});

  return (
    <StockDetailClient
      symbol={canonicalSymbol}
      quoteResource={snapshot.quote}
      profileResource={snapshot.profile}
      overviewResource={snapshot.overview}
      instrumentName={snapshot.instrument.name}
      instrumentCurrency={snapshot.instrument.currency}
      instrumentExchange={snapshot.instrument.exchange}
      instrumentLogoUrl={instrumentMetadataResult.status === 'fulfilled'
        ? instrumentMetadataResult.value.get(canonicalSymbol)?.logoUrl
          ?? snapshot.profile.data?.logoUrl
          ?? null
        : null}
      // Same already-resolved metadata as the logo above — no extra request.
      instrumentAssetType={snapshot.instrument.assetType}
      initialHistory={snapshot.history}
      fxQuote={fxResult.status === 'fulfilled' ? fxResult.value.quote : null}
      evaluatedAt={new Date().toISOString()}
      extendedQuote={snapshot.extendedQuote}
      providerConfigured={snapshot.instrument.assetType === 'crypto' || marketDataGatewayConfigured()}
      initialWatched={watchResult.status === 'fulfilled' ? watchResult.value : false}
      technicalIndicatorsEnabled={technicalIndicatorsEnabled()}
      advancedChartTypesEnabled={advancedChartTypesEnabled()}
      extendedIndicatorsEnabled={extendedIndicatorsEnabled()}
      supportResistanceEnabled={supportResistanceEnabled()}
      keyStatisticsEnabled={keyStatisticsEnabled()}
      analystConsensusEnabled={analystConsensusEnabled()}
      marketSignal={signalResult.status === 'fulfilled' ? signalResult.value : null}
      earnings={earningsResult.status === 'fulfilled' ? earningsResult.value : null}
    />
  );
}
