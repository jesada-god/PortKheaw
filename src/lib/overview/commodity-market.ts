import { resolveCommoditySession } from '@/src/lib/market-data/commodity-session';
import type { CommodityContract } from '@/src/lib/market-data/commodities';
import { overviewPriceStatus } from './presentation';
import {
  resolveContinuousAcceptedMarketData,
  type ContinuousMarketInput,
} from './continuous-market';
import type { InstrumentMetadata, OverviewPrice } from './types';

/**
 * A commodity card's price.
 *
 * The accepted-price resolution is NOT reimplemented here. Deciding which of a
 * snapshot and a candle series is the more recent trustworthy print, what to
 * compare it against, and which failure to report when neither arrives is the
 * work `resolveContinuousAcceptedMarketData` already does for the 24/7 assets,
 * and it is timestamp-driven rather than session-driven — so it is reused as-is
 * and this module adds only the two things a futures market genuinely differs
 * in: the session it reports, and the status that follows from it.
 *
 * The split matters for correctness, not just for size. `closed` is passed to
 * `overviewPriceStatus`, so when Globex is shut the last print is labelled
 * "ราคาปิดทางการ" — which is what it is, a settlement — instead of decaying
 * through "ล่าช้า" to "บันทึกไว้" as though a live market had gone quiet.
 */
export type CommodityMarketInput = ContinuousMarketInput & {
  contract: CommodityContract;
  now: Date;
};

function unavailable(
  instrument: InstrumentMetadata,
  session: ReturnType<typeof resolveCommoditySession>,
): OverviewPrice {
  return {
    symbol: instrument.symbol,
    instrument,
    price: null,
    currency: instrument.currency,
    change: null,
    changePercent: null,
    session: session.state === 'open' ? 'REGULAR' : 'CLOSED',
    sessionLabel: session.label,
    status: 'unavailable',
    asOf: null,
    source: 'Yahoo Finance Chart',
    unavailableReason: 'ผู้ให้บริการข้อมูลตลาดยังไม่มีราคาสัญญานี้',
    tradingDate: null,
    extended: null,
    freshness: { status: 'unavailable', asOf: null, maxAgeSeconds: null },
    sparkline: [],
  };
}

export async function loadCommodityMarketPrice({
  instrument,
  contract,
  quote,
  candles,
  now,
}: CommodityMarketInput): Promise<OverviewPrice> {
  const resolved = await resolveContinuousAcceptedMarketData({ instrument, quote, candles });
  const session = resolveCommoditySession(now);
  if (!resolved.accepted) return unavailable(instrument, session);

  const closed = session.state === 'closed';
  return {
    symbol: instrument.symbol,
    instrument,
    price: resolved.accepted.price,
    // The contract's own currency wins over a provider echo: these are dollar
    // contracts by definition, and a blank field would read as "unknown unit".
    currency: resolved.currency ?? contract.currency,
    change: resolved.change,
    changePercent: resolved.changePercent,
    /*
     * A futures market that is trading is in its regular session — there is no
     * pre or post around a Globex day, and reusing the existing phase union
     * keeps every consumer of `OverviewPrice` working unchanged.
     */
    session: closed ? 'CLOSED' : 'REGULAR',
    sessionLabel: session.label,
    status: overviewPriceStatus(resolved.freshness, closed),
    asOf: resolved.accepted.exchangeTimestamp,
    source: [resolved.provider, resolved.accepted.source].filter(Boolean).join(' · '),
    unavailableReason: null,
    tradingDate: resolved.accepted.exchangeTimestamp?.slice(0, 10) ?? session.tradingDate,
    // No opening bell means no pre-market print and no after-hours print.
    extended: null,
    freshness: resolved.freshness,
    sparkline: resolved.candles.map((candle) => candle.close),
  };
}
