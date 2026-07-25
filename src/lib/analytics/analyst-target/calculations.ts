export function positiveFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

export function calculateUpsideDownsidePct(
  targetPrice: unknown,
  currentPrice: unknown,
): number | null {
  const target = positiveFinite(targetPrice);
  const current = positiveFinite(currentPrice);
  return target === null || current === null
    ? null
    : ((target - current) / current) * 100;
}
