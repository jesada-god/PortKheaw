export type ChartWarningKind = 'filtered' | 'partial' | 'cached' | 'limited';

export interface ChartWarningNotice {
  kind: ChartWarningKind;
  message: string;
}
const NOTICE: Record<ChartWarningKind, string> = {
  filtered: 'ข้อมูลบางช่วงถูกกรองออก',
  partial: 'ข้อมูลย้อนหลังมีเฉพาะช่วงที่ผู้ให้บริการมี',
  cached: 'กำลังแสดงข้อมูลที่บันทึกไว้ล่าสุด',
  limited: 'ข้อมูลบางส่วนมีข้อจำกัดจากผู้ให้บริการ',
};

/**
 * Turns provider/developer diagnostics into short production-safe notices.
 * Raw strings stay available to the development diagnostics panel, but never
 * become yellow English debug text in the production UI.
 */
export function presentChartWarnings(warnings: readonly string[]): ChartWarningNotice[] {
  const kinds = new Set<ChartWarningKind>();
  for (const warning of warnings) {
    if (/discarded\s+\d+\s+invalid provider candles/i.test(warning)) kinds.add('filtered');
    else if (/historical data loaded only partially|actualStart|actualEnd/i.test(warning)) kinds.add('partial');
    else if (/serving (?:server-)?cached|serving stale/i.test(warning)) kinds.add('cached');
    else kinds.add('limited');
  }
  return [...kinds].map((kind) => ({ kind, message: NOTICE[kind] }));
}
