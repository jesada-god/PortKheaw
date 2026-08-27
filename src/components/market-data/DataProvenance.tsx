import { formatMarketDataAsOf } from '@/src/lib/presentation/datetime';
import { STATUS_PRESENTATION, type StatusLevel } from '@/src/lib/presentation/status';
import type { MarketTimestampKind } from '@/src/lib/market-data/options/contracts';

export type DisplayDataStatus = 'live' | 'delayed' | 'end-of-day' | 'cached' | 'stale' | 'unavailable';

/**
 * How fresh the data is, on the shared five-level scale.
 *
 * Six freshness states used to carry six hand-picked palettes — emerald, sky,
 * slate, violet, amber, red — which meant the product had a violet that
 * appeared nowhere else and meant "cached", and a sky that meant "delayed" here
 * while meaning nothing anywhere else.
 *
 * `end-of-day` is 🟢 and not 🟡, which is the one mapping worth stating: a
 * closing price after the close is not late, it is final. `cached` and
 * `delayed` are both 🟡 — the data is real and behind the clock — and only
 * `stale`, which is data older than it should be, earns 🟠.
 */
const FRESHNESS_STATUS = {
  live: 'good',
  'end-of-day': 'good',
  delayed: 'neutral',
  cached: 'neutral',
  stale: 'weak',
  unavailable: 'unknown',
} as const satisfies Record<DisplayDataStatus, StatusLevel>;

export function DataStatusBadge({ status }: { status: DisplayDataStatus }) {
  const level = FRESHNESS_STATUS[status];
  const tone = STATUS_PRESENTATION[level];
  return (
    <span
      data-status={level}
      className="inline-flex rounded-[var(--radius-mark)] border px-2 py-1 text-[10px] font-semibold uppercase"
      style={{
        borderColor: `var(${tone.line})`,
        background: `var(${tone.soft})`,
        color: `var(${tone.token})`,
      }}
    >
      {status}
    </span>
  );
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
  return <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]" data-testid="data-provenance">
    <DataStatusBadge status={status} />
    <span>{provider ?? 'provider unavailable'}</span>
    {asOf && <span>{timestampKind === 'receipt' ? 'เวลาที่ระบบได้รับข้อมูล ' : ''}{formatMarketDataAsOf(asOf)}</span>}
    {delayedMinutes != null && <span>delay {delayedMinutes}m</span>}
    {reason && (
      <span
        style={status === 'unavailable' || status === 'stale'
          ? { color: `var(${STATUS_PRESENTATION[FRESHNESS_STATUS[status]].token})` }
          : undefined}
      >
        {reason}
      </span>
    )}
  </div>;
}
