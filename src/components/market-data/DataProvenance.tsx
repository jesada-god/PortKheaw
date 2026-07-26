import { formatMarketDataAsOf } from '@/src/lib/presentation/datetime';
import type { MarketTimestampKind } from '@/src/lib/market-data/options/contracts';

export type DisplayDataStatus = 'live' | 'delayed' | 'end-of-day' | 'cached' | 'stale' | 'unavailable';

const styles: Record<DisplayDataStatus, string> = {
  live: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  delayed: 'border-sky-500/30 bg-sky-500/10 text-sky-200',
  'end-of-day': 'border-slate-500/30 bg-slate-500/10 text-slate-200',
  cached: 'border-violet-500/30 bg-violet-500/10 text-violet-200',
  stale: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
  unavailable: 'border-red-500/30 bg-red-500/10 text-red-200',
};

export function DataStatusBadge({ status }: { status: DisplayDataStatus }) {
  return <span className={`inline-flex rounded-full border px-2 py-1 text-[10px] font-semibold uppercase ${styles[status]}`}>{status}</span>;
}

export function DataProvenance({
  status,
  provider,
  asOf,
  reason,
  delayedMinutes,
  timestampKind,
}: {
  status: DisplayDataStatus;
  provider?: string | null;
  asOf?: string | null;
  reason?: string | null;
  delayedMinutes?: number | null;
  timestampKind?: MarketTimestampKind | null;
}) {
  return <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400" data-testid="data-provenance">
    <DataStatusBadge status={status} />
    <span>{provider ?? 'provider unavailable'}</span>
    {asOf && <span>{timestampKind === 'receipt' ? 'เวลาที่ระบบได้รับข้อมูล ' : ''}{formatMarketDataAsOf(asOf)}</span>}
    {delayedMinutes != null && <span>delay {delayedMinutes}m</span>}
    {reason && <span className={status === 'unavailable' || status === 'stale' ? 'text-amber-300' : undefined}>{reason}</span>}
  </div>;
}
