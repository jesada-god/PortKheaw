import type { OptionsSrResult } from '@/src/lib/analytics/options-sr';
import type { MarketDataStatus, OptionsChain } from '@/src/lib/market-data/options/contracts';

/**
 * Presentation rules for the Options section below the chart.
 *
 * The primary UI speaks one shared vocabulary — loading / success / failure —
 * and never a provider or transport word. Provider name, delay class, snapshot
 * time and open-interest freshness stay in the provenance detail, so nothing is
 * removed from the provenance chain; it just stops being the headline.
 *
 * Everything here is pure: it maps state the coordinators already produced, and
 * never infers, estimates or fabricates a value.
 */

export type OptionsLoadState = 'idle' | 'loading' | 'success' | 'empty' | 'error';

/** Design-system tone: positive = success, neutral = loading, danger = failure. */
export type OptionsStatusTone = 'positive' | 'neutral' | 'danger' | 'muted';

export const OPTIONS_STATUS_LABEL: Record<OptionsLoadState, string> = {
  idle: 'ยังไม่ได้โหลดข้อมูล',
  loading: 'กำลังโหลดข้อมูล…',
  success: 'โหลดข้อมูลสำเร็จ',
  empty: 'ไม่มีข้อมูลออปชัน',
  error: 'โหลดข้อมูลไม่สำเร็จ',
};

const STATUS_TONE: Record<OptionsLoadState, OptionsStatusTone> = {
  idle: 'muted',
  loading: 'neutral',
  success: 'positive',
  empty: 'muted',
  error: 'danger',
};

/** The single failure sentence shown in the primary UI — never a raw provider error. */
export const OPTIONS_FAILURE_MESSAGE = 'ไม่สามารถโหลดข้อมูลออปชันได้ในขณะนี้';
export const OPTIONS_EMPTY_MESSAGE = 'ไม่พบสัญญาออปชันสำหรับหุ้นนี้';

export interface OptionsStatusInput {
  /** False while the section is collapsed — the state where zero requests are allowed. */
  expanded: boolean;
  loading: boolean;
  chain: OptionsChain | null;
  result: OptionsSrResult | null;
}

export interface OptionsStatusPresentation {
  state: OptionsLoadState;
  label: string;
  tone: OptionsStatusTone;
}

/** Reasons that mean "this symbol/expiration genuinely has no chain", not "the load failed". */
const EMPTY_REASONS = new Set(['no-expirations', 'expired-expiration']);

/**
 * Derives the user-facing load state.
 *
 * A chain that arrived is a success even when the derived levels are
 * unavailable (e.g. the provider returned no open interest): the request did
 * succeed, and the missing levels render as "—" rather than as a failure.
 */
export function presentOptionsStatus({ expanded, loading, chain, result }: OptionsStatusInput): OptionsStatusPresentation {
  const state = ((): OptionsLoadState => {
    if (!expanded) return 'idle';
    if (loading) return 'loading';
    if (chain) return 'success';
    if (result?.status === 'unavailable') return EMPTY_REASONS.has(result.reason) ? 'empty' : 'error';
    // Expanded, nothing resolved yet: the request is queued, not failed.
    return 'loading';
  })();
  return { state, label: OPTIONS_STATUS_LABEL[state], tone: STATUS_TONE[state] };
}

const PROVIDER_LABEL: Record<string, string> = {
  alpaca: 'Alpaca',
  'alpha-vantage': 'Alpha Vantage',
  polygon: 'Polygon',
  finnhub: 'Finnhub',
  'financial-modeling-prep': 'Financial Modeling Prep',
  yahoo: 'Yahoo Finance',
};

/** Human-readable provider name for the provenance detail. */
export function optionsProviderLabel(provider: string | null | undefined): string {
  if (!provider) return 'ไม่ทราบแหล่งข้อมูล';
  return PROVIDER_LABEL[provider] ?? provider;
}

/**
 * Delay class of the snapshot. `live` is deliberately reported as Delayed: no
 * configured options account is entitled to a real-time chain, so claiming one
 * would be untrue.
 */
export function optionsDataStatusLabel(status: MarketDataStatus | null | undefined): string {
  if (status === 'cached') return 'จากแคช (Cached)';
  if (status === 'stale') return 'ข้อมูลเก่า (Stale)';
  return 'ล่าช้า (Delayed)';
}

export interface OptionsProvenanceDetail {
  source: string;
  dataStatus: string;
  /** ISO instant of the snapshot, or null when nothing has loaded. */
  asOf: string | null;
  openInterest: string;
  greeks: string;
  /** Failure explanation, present only when a load actually failed. */
  failure: string | null;
}

const FAILURE_DETAIL: Record<string, string> = {
  'rate-limited': 'แหล่งข้อมูลจำกัดจำนวนการเรียกชั่วคราว ระบบจะเว้นระยะก่อนลองใหม่',
  'entitlement-required': 'บัญชีผู้ให้บริการปัจจุบันยังไม่ได้รับสิทธิ์เข้าถึงข้อมูลออปชัน',
  'chain-unavailable': 'แหล่งข้อมูลไม่ตอบกลับข้อมูลออปชันที่ใช้งานได้',
  'no-expirations': 'ไม่พบวันหมดอายุที่ยังไม่หมดอายุสำหรับหุ้นนี้',
  'expired-expiration': 'วันหมดอายุที่เลือกผ่านไปแล้ว',
  'insufficient-coverage': 'ข้อมูลที่ได้รับครอบคลุมไม่พอสำหรับคำนวณระดับราคา',
  'no-open-interest': 'แหล่งข้อมูลไม่ได้ส่งค่า Open Interest มาด้วย',
  'no-accepted-price': 'ยังไม่มีราคาปัจจุบันที่ยืนยันได้สำหรับคำนวณระยะห่าง',
  stale: 'ข้อมูลชุดล่าสุดเก่าเกินเกณฑ์ที่กำหนด',
};

/**
 * Provenance kept out of the headline but never out of the system: this is the
 * exact content shown behind the ⓘ control.
 */
export function presentOptionsProvenance(
  chain: OptionsChain | null,
  result: OptionsSrResult | null,
): OptionsProvenanceDetail {
  const provider = chain?.provider ?? result?.provider ?? null;
  const hasGreeks = Boolean(chain && [...chain.calls, ...chain.puts].some((contract) =>
    contract.impliedVolatility != null || contract.delta != null || contract.gamma != null
    || contract.theta != null || contract.vega != null));
  return {
    source: optionsProviderLabel(provider),
    dataStatus: optionsDataStatusLabel(chain?.status ?? null),
    asOf: chain?.asOf ?? (result?.asOf ?? null),
    openInterest: 'สรุปสิ้นวันทำการ (EOD)',
    greeks: hasGreeks ? 'ผู้ให้บริการส่ง IV/Greeks มาบางส่วน' : 'ผู้ให้บริการไม่ได้ส่ง IV/Greeks — แสดงเป็น —',
    failure: result?.status === 'unavailable' && !chain
      ? FAILURE_DETAIL[result.reason] ?? 'แหล่งข้อมูลออปชันใช้งานไม่ได้ชั่วคราว'
      : null,
  };
}
