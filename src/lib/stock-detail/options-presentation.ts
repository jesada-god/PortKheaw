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

export type OptionsLoadState = 'idle' | 'loading' | 'success' | 'empty' | 'error' | 'locked';

/** Design-system tone: positive = success, neutral = loading, danger = failure. */
export type OptionsStatusTone = 'positive' | 'neutral' | 'danger' | 'muted';

export const OPTIONS_STATUS_LABEL: Record<OptionsLoadState, string> = {
  idle: 'ยังไม่ได้โหลดข้อมูล',
  loading: 'กำลังโหลดข้อมูล…',
  success: 'โหลดข้อมูลสำเร็จ',
  empty: 'ไม่มีข้อมูลออปชัน',
  error: 'โหลดข้อมูลไม่สำเร็จ',
  locked: 'ต้องอัปเกรดแพ็กเกจ',
};

const STATUS_TONE: Record<OptionsLoadState, OptionsStatusTone> = {
  idle: 'muted',
  loading: 'neutral',
  success: 'positive',
  empty: 'muted',
  error: 'danger',
  // A plan boundary is not a fault, so it never wears the failure tone.
  locked: 'muted',
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

function hasUsableChain(chain: OptionsChain): boolean {
  return chain.calls.length > 0
    && chain.puts.length > 0
    && chain.calls.some((contract) => contract.openInterest !== null)
    && chain.puts.some((contract) => contract.openInterest !== null);
}

/** Reasons that mean "this symbol/expiration genuinely has no chain", not "the load failed". */
const EMPTY_REASONS = new Set(['no-expirations', 'expired-expiration']);

/**
 * Derives the user-facing load state.
 *
 * Success means the chain contains both Calls and Puts plus usable Open
 * Interest on both sides. IV/Greeks are enrichment and may remain unavailable.
 */
export function presentOptionsStatus({ expanded, loading, chain, result }: OptionsStatusInput): OptionsStatusPresentation {
  const state = ((): OptionsLoadState => {
    if (!expanded) return 'idle';
    if (loading) return 'loading';
    if (chain) return hasUsableChain(chain) ? 'success' : 'error';
    if (result?.status === 'unavailable') {
      if (result.reason === 'subscription-required') return 'locked';
      return EMPTY_REASONS.has(result.reason) ? 'empty' : 'error';
    }
    // Expanded, nothing resolved yet: the request is queued, not failed.
    return 'loading';
  })();
  return { state, label: OPTIONS_STATUS_LABEL[state], tone: STATUS_TONE[state] };
}

const PROVIDER_LABEL: Record<string, string> = {
  alpaca: 'Alpaca',
  'alpaca-options-data': 'Alpaca Options Data',
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
  'subscription-required': 'ข้อมูลส่วนนี้อยู่ในแพ็กเกจที่สูงขึ้น',
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
  const contracts = chain ? [...chain.calls, ...chain.puts] : [];
  const hasValues = contracts.some((contract) =>
    contract.impliedVolatility != null || contract.delta != null || contract.gamma != null
    || contract.theta != null || contract.vega != null);
  const providerValued = contracts.some((contract) => contract.valuationSource === 'provider')
    // Backward-compatible truth for a validated provider contract produced
    // before valuationSource was introduced.
    || (hasValues && !contracts.some((contract) => contract.valuationSource === 'nexora-derived'));
  const nexoraValued = contracts.some((contract) => contract.valuationSource === 'nexora-derived');
  const marketSources = [...new Set(contracts.flatMap((contract) => contract.marketDataProvider
    ? [`${optionsProviderLabel(contract.marketDataProvider)}${contract.marketDataFeed ? ` (${contract.marketDataFeed})` : ''}`]
    : []))];
  const latestMarketAsOf = contracts
    .map((contract) => contract.asOf)
    .filter((asOf) => Number.isFinite(Date.parse(asOf)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  const latestOiAsOf = contracts
    .map((contract) => contract.oiAsOf)
    .filter((asOf): asOf is string => Boolean(asOf))
    .sort()
    .at(-1);
  const greeks = providerValued && nexoraValued
    ? 'ผู้ให้บริการส่งบางค่า · บางค่าคำนวณโดย PortKheaw'
    : nexoraValued
      ? 'คำนวณโดย PortKheaw จากราคาออปชันจริง'
      : providerValued
        ? 'ผู้ให้บริการส่ง IV/Greeks มาบางส่วน'
        : 'ผู้ให้บริการไม่ได้ส่ง IV/Greeks — แสดงเป็น —';
  return {
    source: [optionsProviderLabel(provider), ...marketSources].join(' · '),
    dataStatus: optionsDataStatusLabel(chain?.status ?? null),
    asOf: latestMarketAsOf ?? chain?.asOf ?? (result?.asOf ?? null),
    openInterest: latestOiAsOf ? `สรุปสิ้นวันทำการ (EOD) · ${latestOiAsOf}` : 'สรุปสิ้นวันทำการ (EOD)',
    greeks,
    failure: result?.status === 'unavailable' && !chain
      ? FAILURE_DETAIL[result.reason] ?? 'แหล่งข้อมูลออปชันใช้งานไม่ได้ชั่วคราว'
      : null,
  };
}
