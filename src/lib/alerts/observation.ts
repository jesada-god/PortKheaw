import type { OverviewPrice } from '@/src/lib/overview/types';

export interface TargetObservation {
  price: number;
  changePercent: number;
  observedAt: string;
  session: 'regular' | 'pre-market' | 'after-hours';
  source: string;
}

export function targetObservation(price: OverviewPrice): TargetObservation | null {
  if (
    price.price === null
    || !Number.isFinite(price.price)
    || price.price <= 0
    || !price.asOf
    || price.status === 'unavailable'
    || price.freshness?.status === 'stale'
    || price.freshness?.status === 'unavailable'
  ) return null;
  const session = price.session === 'REGULAR'
    ? 'regular'
    : price.session === 'PRE'
      ? 'pre-market'
      : price.session === 'POST'
        ? 'after-hours'
        : null;
  if (!session) return null;
  return {
    price: price.price,
    changePercent: price.changePercent ?? 0,
    observedAt: price.asOf,
    session,
    source: price.source ?? 'canonical-market-snapshot',
  };
}
