/**
 * Pure assembly of the S/R panel rows.
 *
 * Levels arrive from the existing classic-pivot engine; statistics arrive from
 * the Touch/Hold/Break engine measured on the displayed canonical bars. This
 * module only joins them, orders them and computes distances against the one
 * accepted price the header also shows. It invents nothing.
 */

import type { LevelInput, LevelStatistics } from '@/src/lib/analytics/level-statistics';

export interface PivotLevelSet {
  resistance: readonly [number, number, number];
  support: readonly [number, number, number];
}

export interface AssembledRow {
  id: string;
  label: string;
  price: number;
  side: 'support' | 'resistance';
  distancePercent: number | null;
  statistics: LevelStatistics | null;
}

/** R1..R3 and S1..S3 as level inputs for the statistics engine. */
export function toLevelInputs(levels: PivotLevelSet): LevelInput[] {
  return [
    ...levels.resistance.map((price, index) => ({
      id: `R${index + 1}`,
      label: `R${index + 1}`,
      price,
      type: 'resistance' as const,
    })),
    ...levels.support.map((price, index) => ({
      id: `S${index + 1}`,
      label: `S${index + 1}`,
      price,
      type: 'support' as const,
    })),
  ];
}

/** Signed distance from the accepted price; positive means the level is above. */
export function signedDistancePercent(level: number, price: number | null | undefined): number | null {
  if (price == null || !Number.isFinite(price) || price <= 0 || !Number.isFinite(level)) return null;
  return ((level - price) / price) * 100;
}

/**
 * Rows ordered the way the panel reads top-to-bottom: R3, R2, R1, price, S1, S2,
 * S3 — resistance furthest-first, support nearest-first, so both columns run
 * outward from the current price.
 */
export function assembleLevelRows(
  levels: PivotLevelSet,
  statistics: readonly LevelStatistics[],
  acceptedPrice: number | null,
): AssembledRow[] {
  const byId = new Map(statistics.map((item) => [item.id, item]));
  const resistance = levels.resistance
    .map((price, index) => ({
      id: `R${index + 1}`,
      label: `R${index + 1}`,
      price,
      side: 'resistance' as const,
      distancePercent: signedDistancePercent(price, acceptedPrice),
      statistics: byId.get(`R${index + 1}`) ?? null,
    }))
    .reverse();
  const support = levels.support.map((price, index) => ({
    id: `S${index + 1}`,
    label: `S${index + 1}`,
    price,
    side: 'support' as const,
    distancePercent: signedDistancePercent(price, acceptedPrice),
    statistics: byId.get(`S${index + 1}`) ?? null,
  }));
  return [...resistance, ...support];
}

/** The level closest to the accepted price, or `null` when there is no price. */
export function nearestLevel(
  rows: readonly AssembledRow[],
  acceptedPrice: number | null,
): { label: string; price: number; distancePercent: number } | null {
  if (acceptedPrice == null || !Number.isFinite(acceptedPrice)) return null;
  let best: AssembledRow | null = null;
  for (const row of rows) {
    if (row.distancePercent == null) continue;
    if (!best || Math.abs(row.distancePercent) < Math.abs(best.distancePercent as number)) best = row;
  }
  return best && best.distancePercent != null
    ? { label: best.label, price: best.price, distancePercent: best.distancePercent }
    : null;
}
