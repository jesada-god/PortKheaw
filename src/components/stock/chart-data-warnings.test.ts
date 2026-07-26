import { describe, expect, it } from 'vitest';
import { presentChartWarnings } from './chart-data-warnings';

describe('presentChartWarnings', () => {
  it('hides raw candle diagnostics behind compact Thai production notices', () => {
    const raw = [
      'Discarded 11 invalid provider candles',
      'Historical data loaded only partially; inspect actualStart and actualEnd',
    ];
    const notices = presentChartWarnings(raw);
    expect(notices.map((item) => item.message)).toEqual([
      'ข้อมูลบางช่วงถูกกรองออก',
      'ข้อมูลย้อนหลังมีเฉพาะช่วงที่ผู้ให้บริการมี',
    ]);
    expect(JSON.stringify(notices)).not.toContain('Discarded');
    expect(JSON.stringify(notices)).not.toContain('actualStart');
    // The source array is retained unchanged for development diagnostics.
    expect(raw[0]).toContain('11 invalid provider candles');
  });

  it('deduplicates notices and sanitizes an unknown provider warning', () => {
    expect(presentChartWarnings(['Discarded 1 invalid provider candles', 'Discarded 2 invalid provider candles']))
      .toHaveLength(1);
    expect(presentChartWarnings(['provider internal reason']).map((item) => item.message))
      .toEqual(['ข้อมูลบางส่วนมีข้อจำกัดจากผู้ให้บริการ']);
  });
});
