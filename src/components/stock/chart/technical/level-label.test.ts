import { describe, expect, it } from 'vitest';
import { formatSupportResistanceLevelLabel } from './level-label';

describe('formatSupportResistanceLevelLabel', () => {
  it('uses one novice-friendly name for every classic level', () => {
    expect(['R1', 'R2', 'R3', 'S1', 'S2', 'S3'].map(formatSupportResistanceLevelLabel)).toEqual([
      'R1 แนวต้านที่ 1',
      'R2 แนวต้านที่ 2',
      'R3 แนวต้านที่ 3',
      'S1 แนวรับที่ 1',
      'S2 แนวรับที่ 2',
      'S3 แนวรับที่ 3',
    ]);
  });

  it('preserves an unknown calculation identifier instead of inventing a name', () => {
    expect(formatSupportResistanceLevelLabel('R4')).toBe('R4');
  });
});
