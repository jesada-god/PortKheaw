export const MONTE_CARLO_PATH_SERIES = [
  { dataKey: 'lower', label: 'ช่วงล่าง P10', color: '#7dd3fc' },
  { dataKey: 'median', label: 'ค่ากลาง P50', color: '#D4FF00' },
  { dataKey: 'upper', label: 'ช่วงบน P90', color: '#c4b5fd' },
] as const;

export interface PathSummaryPoint {
  step: number;
  lower: number;
  median: number;
  upper: number;
}

function quantile(sorted: readonly number[], probability: number): number {
  const position = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const weight = position - lowerIndex;
  const lower = sorted[lowerIndex];
  const upper = sorted[lowerIndex + 1] ?? lower;
  return lower * (1 - weight) + upper * weight;
}

/** Aggregate every supplied sample path into three fixed percentile series. */
export function buildPathSummaryData(samplePaths: readonly (readonly number[])[]): PathSummaryPoint[] {
  const pointCount = Math.max(0, ...samplePaths.map((path) => path.length));
  return Array.from({ length: pointCount }, (_, step) => {
    const values = samplePaths.flatMap((path) => {
      const value = path[step];
      return value !== undefined && Number.isFinite(value) ? [value] : [];
    }).sort((left, right) => left - right);
    if (!values.length) throw new Error(`Simulation path summary has no finite values at step ${step}`);
    return {
      step,
      lower: quantile(values, 0.10),
      median: quantile(values, 0.50),
      upper: quantile(values, 0.90),
    };
  });
}

export interface PriceMarker {
  id: 'current' | 'target' | `break-even-${number}`;
  value: number;
  label: string;
  color: string;
  description: string;
}

export function buildPriceMarkers(input: {
  currentPrice: number | null;
  targetPrice?: number;
  breakEvenPrices: readonly number[];
  format: (value: number) => string;
}): PriceMarker[] {
  if (!input.breakEvenPrices.every(Number.isFinite)) throw new Error('Chart break-even markers must be finite');
  const markers: PriceMarker[] = [];
  if (input.currentPrice !== null && Number.isFinite(input.currentPrice)) {
    markers.push({ id: 'current', value: input.currentPrice, label: 'ราคาปัจจุบัน', color: '#f59e0b', description: `ราคาปัจจุบัน $${input.format(input.currentPrice)}` });
  }
  if (input.targetPrice !== undefined && Number.isFinite(input.targetPrice)) {
    markers.push({ id: 'target', value: input.targetPrice, label: 'ราคาเป้าหมาย', color: '#22d3ee', description: `ราคาเป้าหมาย $${input.format(input.targetPrice)}` });
  }
  input.breakEvenPrices.forEach((value, index) => {
    markers.push({
      id: `break-even-${index}`,
      value,
      label: input.breakEvenPrices.length === 1 ? 'จุดคุ้มทุน' : `จุดคุ้มทุน ${index + 1}`,
      color: '#a78bfa',
      description: `จุดคุ้มทุน $${input.format(value)}`,
    });
  });
  return markers;
}
