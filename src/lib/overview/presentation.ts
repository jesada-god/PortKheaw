import type { DataFreshness } from '@/src/lib/market-data/types';
import type { OverviewPriceStatus } from './types';

export const OVERVIEW_STATUS_COPY: Record<OverviewPriceStatus, string> = {
  live: 'เรียลไทม์',
  delayed: 'ข้อมูลล่าช้า',
  saved: 'ข้อมูลล่าสุดที่บันทึกไว้',
  closed: 'ราคาปิดทางการ',
  unavailable: 'ข้อมูลยังไม่พร้อม',
};

export function overviewPriceStatus(
  freshness: DataFreshness | null,
  closed: boolean,
): OverviewPriceStatus {
  if (closed && freshness?.status !== 'unavailable') return 'closed';
  switch (freshness?.status) {
    case 'realtime': return 'live';
    case 'delayed':
    case 'end-of-day': return 'delayed';
    case 'cached':
    case 'stale': return 'saved';
    default: return 'unavailable';
  }
}
