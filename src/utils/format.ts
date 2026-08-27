export const formatPercent = (value: number) => {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
};

export type PriceDisplayMode = 'standard' | 'compact';

export const formatNumber = (
  value: number,
  options: { mode?: PriceDisplayMode; precision?: number } = {},
) => {
  const precision = options.mode === 'compact'
    ? 2
    : Math.min(8, Math.max(0, options.precision ?? 2));
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  }).format(value);
};

/**
 * Presentation-only stock price formatting. `compact` is reserved for headline
 * prices; calculations and chart series retain their original numeric precision.
 */
export const formatPrice = (
  value: number,
  options: { mode?: PriceDisplayMode; precision?: number } = {},
) => formatNumber(value, options);

export const formatCompact = (value: number) => {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(value);
};
