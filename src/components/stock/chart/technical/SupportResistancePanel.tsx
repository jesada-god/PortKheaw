'use client';

import { DetailPopover } from '@/src/components/ui/DetailPopover';
import { InfoHint } from '@/src/components/ui/InfoHint';
import type { LevelStatistics } from '@/src/lib/analytics/level-statistics';
import type { VisibleRangeVolumeProfile } from '@/src/lib/analytics/institutional-sr/visible-range-profile';

export interface SupportResistanceRow {
  id: string;
  label: string;
  price: number;
  side: 'support' | 'resistance';
  /** Signed percentage from the accepted price; positive is above. */
  distancePercent: number | null;
  statistics: LevelStatistics | null;
  /** VPVR confirmation for this price, derived from the visible profile. */
  confirmation: 'strong' | 'moderate' | 'weak' | null;
}

export interface SupportResistancePanelProps {
  rows: readonly SupportResistanceRow[];
  acceptedPrice: number | null;
  /** Provenance of the accepted price, shown so the panel never implies real-time. */
  priceLabel: string | null;
  basisLabel: string;
  nearest: { label: string; price: number; distancePercent: number } | null;
  statisticsReason: string | null;
  levelsError: string | null;
  currency: string;
}

function money(value: number, currency: string): string {
  return `${currency}${value.toFixed(2)}`;
}

function signedPercent(value: number | null): string {
  if (value == null) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

const CONFIRMATION_LABEL: Record<'strong' | 'moderate' | 'weak', string> = {
  strong: 'Strong',
  moderate: 'Moderate',
  weak: 'Weak',
};

function compactStatistics(row: SupportResistanceRow): string {
  const statistics = row.statistics;
  if (!statistics) return 'ยังไม่มีสถิติสำหรับระดับนี้';
  if (statistics.touches === 0) return 'ยังไม่มีประวัติทดสอบระดับนี้';
  const verb = row.side === 'support' ? 'รับอยู่' : 'ต้านอยู่';
  const failure = row.side === 'support' ? 'หลุด' : 'ทะลุ';
  const rate = statistics.holdRate == null ? '—' : `${Math.round(statistics.holdRate)}%`;
  return `ชน ${statistics.touches} · ${verb} ${statistics.successfulHolds} (${rate}) · ${failure} ${statistics.breaks}`;
}

function lastTouchLabel(statistics: LevelStatistics | null): string | null {
  if (!statistics?.lastTouchTime) return null;
  return new Date(statistics.lastTouchTime * 1_000).toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * The Support/Resistance panel below the chart.
 *
 * Levels come from the existing classic-pivot engine (`/api/market/chart-levels`,
 * computed from the last completed D1 bar); the touch/hold/break statistics are
 * measured against the canonical OHLCV currently displayed. Nothing on this
 * panel is generated, estimated or predicted — in particular there is no
 * time-to-level estimate, because no verified methodology backs one here. A
 * level with no recorded test says so instead of showing a manufactured rate.
 */
export function SupportResistancePanel({
  rows,
  acceptedPrice,
  priceLabel,
  basisLabel,
  nearest,
  statisticsReason,
  levelsError,
  currency,
}: SupportResistancePanelProps) {
  const resistance = rows.filter((row) => row.side === 'resistance');
  const support = rows.filter((row) => row.side === 'support');

  return (
    <section
      aria-label="แนวรับและแนวต้าน"
      className="border-t border-[#242733] p-3"
      data-testid="support-resistance-panel"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1 text-sm font-bold text-white">
          🎯 แนวรับ–แนวต้าน
          <InfoHint term="support" align="start" />
        </h3>
        <span className="flex items-center gap-1 text-[11px] text-slate-500">
          อ้างอิง {basisLabel}
          <DetailPopover triggerLabel="ดูที่มาของแนวรับ–แนวต้าน" title="ที่มาของแนวรับ–แนวต้าน" testId="sr-provenance-trigger">
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
              <dt className="text-slate-500">อ้างอิงแท่ง</dt><dd className="text-right font-mono text-slate-200">{basisLabel}</dd>
              <dt className="text-slate-500">ที่มาราคาปัจจุบัน</dt><dd className="text-right text-slate-200">{priceLabel ?? '—'}</dd>
            </dl>
            <p className="mt-2 border-t border-slate-800 pt-2 text-[11px] leading-relaxed text-slate-400">
              ระดับมาจากแท่ง {basisLabel} ที่ปิดสมบูรณ์แล้ว ส่วนสถิติ ชน/รับอยู่/หลุด วัดจากแท่งเทียนจริงที่กำลังแสดงอยู่บนกราฟ
            </p>
          </DetailPopover>
        </span>
      </div>

      {levelsError && (
        <p role="status" className="mb-2 rounded-md border border-amber-500/20 bg-amber-400/5 px-2 py-1.5 text-xs text-amber-200">
          {levelsError}
        </p>
      )}

      {nearest && (
        <p
          role="status"
          data-testid="sr-nearest"
          title={nearest.label.startsWith('S') ? 'แนวรับที่ใกล้ราคาปัจจุบันที่สุด' : 'แนวต้านที่ใกล้ราคาปัจจุบันที่สุด'}
          className="mb-1.5 rounded-md border border-amber-400/20 bg-amber-400/[.07] px-2 py-1 text-[11px] text-amber-200"
        >
          🔔 {nearest.label} {money(nearest.price, currency)} · ห่าง {Math.abs(nearest.distancePercent).toFixed(2)}%
        </p>
      )}

      <ol className="space-y-0.5">
        {resistance.map((row) => <LevelRow key={row.id} row={row} currency={currency} basisLabel={basisLabel} />)}
        <li
          data-testid="sr-current-price"
          className="flex items-center justify-between gap-2 rounded-md border border-[#D4FF00]/30 bg-[#D4FF00]/[.07] px-2.5 py-1.5"
        >
          <b className="text-xs font-semibold text-[#D4FF00]">ราคาปัจจุบัน</b>
          <span className="font-mono text-sm font-semibold tabular-nums text-[#D4FF00]">
            {acceptedPrice == null ? '—' : money(acceptedPrice, currency)}
          </span>
        </li>
        {support.map((row) => <LevelRow key={row.id} row={row} currency={currency} basisLabel={basisLabel} />)}
      </ol>

      {statisticsReason && (
        <p className="mt-1.5 text-[11px] text-slate-500" data-testid="sr-statistics-reason">{statisticsReason}</p>
      )}
      <p className="mt-1.5 text-[10px] leading-relaxed text-slate-600">
        ตัวเลขทั้งหมดวัดจากแท่งเทียนจริงในช่วงที่แสดงอยู่ ไม่ใช่การทำนายราคา และไม่มีการประเมินเวลาที่ราคาจะไปถึงระดับ
      </p>
    </section>
  );
}

function LevelRow({ row, currency, basisLabel }: { row: SupportResistanceRow; currency: string; basisLabel: string }) {
  const tone = row.side === 'resistance' ? 'text-rose-300' : 'text-emerald-300';
  const lastTouch = lastTouchLabel(row.statistics);
  return (
    <li className={`relative rounded-md border-l-2 bg-slate-950/35 px-2 py-1 ${row.side === 'resistance' ? 'border-l-rose-400/70' : 'border-l-emerald-400/70'}`} data-testid={`sr-level-${row.id}`}>
      <div className="grid grid-cols-[minmax(1.75rem,auto)_1fr_auto_1.25rem] items-center gap-x-2">
        <b className={`text-xs ${tone}`}>{row.label}</b>
        <span className="whitespace-nowrap font-mono text-sm tabular-nums text-slate-100">{money(row.price, currency)}</span>
        <span className={`whitespace-nowrap text-right font-mono text-[11px] tabular-nums ${row.distancePercent != null && row.distancePercent > 0 ? 'text-rose-300' : 'text-emerald-300'}`}>
          {signedPercent(row.distancePercent)}
        </span>
        <LevelDetails row={row} currency={currency} basisLabel={basisLabel} lastTouch={lastTouch} />
      </div>
      <p className="mt-0.5 truncate text-[11px] text-slate-400" data-testid={`sr-level-${row.id}-summary`}>
        {compactStatistics(row)}
      </p>
      <p className="mt-0.5 flex flex-wrap gap-x-3 text-[10px] text-slate-500">
        {lastTouch && <span>ทดสอบล่าสุด {lastTouch}</span>}
        {row.confirmation && <span>VPVR Confirmation: {CONFIRMATION_LABEL[row.confirmation]}</span>}
      </p>
    </li>
  );
}

function LevelDetails({ row, currency, basisLabel, lastTouch }: {
  row: SupportResistanceRow;
  currency: string;
  basisLabel: string;
  lastTouch: string | null;
}) {
  const title = row.side === 'support' ? 'แนวรับ' : 'แนวต้าน';
  const hold = row.side === 'support' ? 'รับอยู่' : 'ต้านอยู่';
  const failure = row.side === 'support' ? 'หลุด' : 'ทะลุ';
  const statistics = row.statistics;

  return (
    <DetailPopover
      triggerLabel={`ดูรายละเอียด${title} ${row.label}`}
      dialogLabel={`รายละเอียด${title} ${row.label}`}
      title={<span className={row.side === 'support' ? 'text-emerald-300' : 'text-rose-300'}>{title} {row.label} <span className="font-mono tabular-nums">{money(row.price, currency)}</span></span>}
    >
      <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-xs">
        <dt className="text-slate-500">ชนทั้งหมด</dt><dd className="text-right font-mono tabular-nums text-slate-200">{statistics?.touches ?? '—'}</dd>
        <dt className="text-slate-500">{hold}</dt><dd className="text-right font-mono tabular-nums text-slate-200">{statistics?.successfulHolds ?? '—'}</dd>
        <dt className="text-slate-500">{failure}</dt><dd className="text-right font-mono tabular-nums text-slate-200">{statistics?.breaks ?? '—'}</dd>
        <dt className="text-slate-500">อัตรา{hold}</dt><dd className="text-right font-mono tabular-nums text-slate-200">{statistics?.holdRate == null ? '—' : `${Math.round(statistics.holdRate)}%`}</dd>
        <dt className="text-slate-500">ทดสอบล่าสุด</dt><dd className="text-right text-slate-200">{lastTouch ?? '—'}</dd>
        <dt className="text-slate-500">Tolerance</dt><dd className="text-right font-mono tabular-nums text-slate-200">{statistics?.tolerance == null ? '—' : money(statistics.tolerance, currency)}</dd>
        <dt className="text-slate-500">Timeframe</dt><dd className="text-right font-mono text-slate-200">{basisLabel}</dd>
      </dl>
      <div className="mt-2 space-y-1 border-t border-slate-800 pt-2 text-[11px] leading-relaxed text-slate-400">
        <p><b className="text-slate-300">ชน</b> = ราคาเข้ามาทดสอบบริเวณนี้</p>
        <p><b className="text-slate-300">{hold}</b> = แตะแล้วไม่{failure}ตาม confirmation rule</p>
        <p><b className="text-slate-300">{failure}</b> = ปิด{row.side === 'support' ? 'ต่ำ' : 'สูง'}กว่าระดับตาม confirmation rule</p>
      </div>
    </DetailPopover>
  );
}

/**
 * VPVR is a *confirmation layer only*: it grades how much traded volume sits at a
 * level, and can never move, add or remove a level produced by the S/R engine.
 */
export function volumeProfileConfirmation(
  profile: VisibleRangeVolumeProfile | undefined,
  price: number,
): 'strong' | 'moderate' | 'weak' | null {
  if (!profile || profile.status !== 'available') return null;
  const bin = profile.profile.find((item) => price >= item.priceLow && price <= item.priceHigh);
  if (!bin) return null;
  if (bin.normalizedVolume >= 0.7) return 'strong';
  if (bin.normalizedVolume >= 0.35) return 'moderate';
  return 'weak';
}

export default SupportResistancePanel;
