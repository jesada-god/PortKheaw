const LEVEL_LABELS = {
  R1: 'R1 แนวต้านที่ 1',
  R2: 'R2 แนวต้านที่ 2',
  R3: 'R3 แนวต้านที่ 3',
  S1: 'S1 แนวรับที่ 1',
  S2: 'S2 แนวรับที่ 2',
  S3: 'S3 แนวรับที่ 3',
} as const;

/**
 * One presentation name for every classic support/resistance level.
 *
 * Calculation identifiers stay as R1..R3/S1..S3; only user-facing copy passes
 * through this formatter. Unknown identifiers are preserved so a future level
 * can still render truthfully before presentation copy is added for it.
 */
export function formatSupportResistanceLevelLabel(label: string): string {
  return LEVEL_LABELS[label as keyof typeof LEVEL_LABELS] ?? label;
}
