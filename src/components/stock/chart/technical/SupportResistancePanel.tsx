'use client';

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

function statisticsSentence(row: SupportResistanceRow): string {
  const statistics = row.statistics;
  if (!statistics) return 'ยังไม่มีสถิติสำหรับระดับนี้';
  if (statistics.touches === 0) return 'ยังไม่มีประวัติทดสอบระดับนี้';
  const verb = row.side === 'support' ? 'รับอยู่' : 'ต้านอยู่';
  const failure = row.side === 'support' ? 'หลุด' : 'ทะลุ';
  const strength = statistics.strength === 'strong'
    ? (row.side === 'support' ? 'รับแข็งแรง' : 'ต้านแข็งแรง')
    : statistics.strength === 'moderate'
      ? (row.side === 'support' ? 'รับปานกลาง' : 'ต้านปานกลาง')
      : (row.side === 'support' ? 'รับอ่อน' : 'ต้านอ่อน');
  const rate = statistics.holdRate == null ? '—' : `${Math.round(statistics.holdRate)}%`;
  return `${strength} · ชน ${statistics.touches} ครั้ง · ${verb} ${statistics.successfulHolds} ครั้ง (${rate}) · ${failure} ${statistics.breaks}`;
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
        <span className="text-[11px] text-slate-500">อ้างอิง {basisLabel}</span>
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
          className="mb-2 rounded-md border border-amber-400/25 bg-amber-400/10 px-2.5 py-2 text-xs text-amber-200"
        >
          🔔 ใกล้ถึง {nearest.label} ที่ {money(nearest.price, currency)} · ห่าง {Math.abs(nearest.distancePercent).toFixed(2)}%
        </p>
      )}

      <ol className="space-y-1">
        {resistance.map((row) => <LevelRow key={row.id} row={row} currency={currency} />)}
        <li
          data-testid="sr-current-price"
          className="flex items-center justify-between gap-2 rounded-md border border-[#D4FF00]/40 bg-[#D4FF00]/10 px-2.5 py-2"
        >
          <b className="text-xs text-[#D4FF00]">ราคาปัจจุบัน</b>
          <span className="font-mono text-sm font-bold text-[#D4FF00]">
            {acceptedPrice == null ? '—' : money(acceptedPrice, currency)}
          </span>
        </li>
        {support.map((row) => <LevelRow key={row.id} row={row} currency={currency} />)}
      </ol>

      {statisticsReason && (
        <p className="mt-2 text-[11px] text-slate-500" data-testid="sr-statistics-reason">{statisticsReason}</p>
      )}
      {priceLabel && (
        <p className="mt-2 text-[11px] text-slate-500">
          ราคาปัจจุบันใช้แหล่งเดียวกับด้านบนของหน้า: {priceLabel}
        </p>
      )}
      <p className="mt-1 text-[11px] text-slate-600">
        ตัวเลขทั้งหมดวัดจากแท่งเทียนจริงในช่วงที่แสดงอยู่ ไม่ใช่การทำนายราคา และไม่มีการประเมินเวลาที่ราคาจะไปถึงระดับ
      </p>
    </section>
  );
}

function LevelRow({ row, currency }: { row: SupportResistanceRow; currency: string }) {
  const tone = row.side === 'resistance' ? 'text-rose-300' : 'text-emerald-300';
  const lastTouch = lastTouchLabel(row.statistics);
  return (
    <li className="rounded-md bg-slate-950/40 px-2.5 py-2" data-testid={`sr-level-${row.id}`}>
      <div className="flex items-center justify-between gap-2">
        <b className={`text-xs ${tone}`}>{row.label}</b>
        <span className="font-mono text-sm text-slate-100">{money(row.price, currency)}</span>
        <span className={`w-16 text-right font-mono text-[11px] ${row.distancePercent != null && row.distancePercent > 0 ? 'text-rose-300' : 'text-emerald-300'}`}>
          {signedPercent(row.distancePercent)}
        </span>
      </div>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-slate-400">
        <span>{statisticsSentence(row)}</span>
        <InfoHint term="levelTouch" align="start" />
        {row.statistics && row.statistics.touches > 0 && <InfoHint term="holdRate" align="start" />}
      </p>
      <p className="mt-0.5 flex flex-wrap gap-x-3 text-[10px] text-slate-500">
        {lastTouch && <span>ทดสอบล่าสุด {lastTouch}</span>}
        {row.confirmation && <span>VPVR Confirmation: {CONFIRMATION_LABEL[row.confirmation]}</span>}
      </p>
    </li>
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
