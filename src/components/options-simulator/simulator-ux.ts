import { formatThaiDateOnly } from '@/src/lib/presentation/datetime';
import {
  acceptTargetDate,
  addCalendarDays,
  calendarDaysBetween,
  clampTargetDate,
  targetDateBounds,
  targetDateViolation,
  todayCalendarDate,
} from '@/src/lib/options-simulator/calendar-date';

export {
  acceptTargetDate,
  addCalendarDays,
  calendarDaysBetween,
  clampTargetDate,
  targetDateBounds,
  targetDateViolation,
  todayCalendarDate,
};

export const BASIC_PATH_OPTIONS = [1_000, 5_000, 10_000, 25_000, 50_000] as const;

export type BasicPathOption = typeof BASIC_PATH_OPTIONS[number];
export type ResultCurrency = 'USD' | 'THB';
export type ProfitLossState = 'profit' | 'loss' | 'break-even';

export function isBasicPathOption(value: number): value is BasicPathOption {
  return BASIC_PATH_OPTIONS.includes(value as BasicPathOption);
}

function finiteNonnegative(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function premiumFromDigitString(value: string): number | null {
  const digits = value.replace(/\D/g, '');
  if (!digits) return null;
  return finiteNonnegative(Number(digits) / 100);
}

export function parsePremiumPaste(value: string): number | null {
  const normalized = value.trim().replace(/[$,\s]/g, '');
  if (!normalized || normalized.startsWith('-')) return null;
  if (!normalized.includes('.')) return /^\d+$/.test(normalized) ? premiumFromDigitString(normalized) : null;
  if (!/^\d*\.\d{0,2}$/.test(normalized)) return null;
  return finiteNonnegative(Number(normalized));
}

export function premiumDigitsFromValue(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '';
  return String(Math.round(value * 100));
}

export function formatPremiumDigits(value: string): string {
  const parsed = premiumFromDigitString(value);
  return parsed === null ? '' : parsed.toFixed(2);
}

export function engineVolatilityToPercent(value: number): number {
  return Number.isFinite(value) ? value * 100 : 0;
}

export function percentVolatilityToEngine(value: number): number {
  return Number.isFinite(value) ? value / 100 : 0;
}

export function normalizePercentDraft(value: string): string | null {
  const normalized = value.trim().replace(/%$/, '');
  if (!normalized) return '';
  if (!/^\d*(?:\.\d{0,2})?$/.test(normalized)) return null;
  if (normalized.startsWith('.')) return `0${normalized}`;
  return normalized.replace(/^0+(?=\d)/, '');
}

export function parsePercentDraft(value: string): number | null {
  const normalized = normalizePercentDraft(value);
  if (normalized === null || !normalized || normalized === '.') return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface ResolvedLegSensitivity {
  side: 'buy' | 'sell';
  quantity: number;
  multiplier: number;
  delta: number | null;
  theta: number | null;
}

export function aggregatePortfolioSensitivity(legs: ResolvedLegSensitivity[]): { delta: number; theta: number } {
  return legs.reduce((total, leg) => {
    const scale = (leg.side === 'buy' ? 1 : -1) * leg.quantity * leg.multiplier;
    return {
      delta: leg.delta === null ? total.delta : total.delta + leg.delta * scale,
      theta: leg.theta === null ? total.theta : total.theta + leg.theta * scale,
    };
  }, { delta: 0, theta: 0 });
}

/*
  The reader-facing half of the Target Date rule. The rule itself — where the
  window starts and ends — lives in `calendar-date`, so the field, the restore
  path and the server schema cannot drift apart; only the sentence is here.
*/
export function targetDateError(value: string, valuationDate: string, expiration: string, today = ''): string | null {
  switch (targetDateViolation(value, valuationDate, expiration, today)) {
    case 'after-expiration':
      return `วันที่ดูผลต้องไม่เกินวันหมดอายุ ${formatThaiDateOnly(expiration)}`;
    case 'before-minimum':
    case 'malformed':
      return `วันที่ดูผลต้องไม่ก่อน ${formatThaiDateOnly(targetDateBounds(valuationDate, expiration, today).minimum)}`;
    default:
      return null;
  }
}

/*
  Every timestamp the simulator prints goes through here. A bare `toLocaleString()`
  follows whichever locale the runtime happens to have — "8/2/2026, 2:58:54 AM" on
  a US-defaulted server, Thai digits and a Buddhist year in a th-TH browser — so
  the same instant rendered on two machines produced two different strings. The
  locale and calendar are pinned instead; the zone stays the reader's own, because
  an "as of" time is only meaningful in the clock they are looking at.
*/
const TIMESTAMP_LOCALE = 'th-TH-u-ca-gregory';

export function formatTimestamp(value: string | number | Date | null | undefined, fallback = 'ไม่มีข้อมูล'): string {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed.toLocaleString(TIMESTAMP_LOCALE, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function parseFiniteDraft(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function convertUsdForDisplay(valueUsd: number, currency: ResultCurrency, usdThbRate: number | null): number | null {
  if (!Number.isFinite(valueUsd)) return null;
  const normalized = Object.is(valueUsd, -0) ? 0 : valueUsd;
  if (currency === 'USD') return normalized;
  if (usdThbRate === null || !Number.isFinite(usdThbRate) || usdThbRate <= 0) return null;
  const converted = normalized * usdThbRate;
  return Object.is(converted, -0) ? 0 : converted;
}

export function formatResultMoney(valueUsd: number, currency: ResultCurrency, usdThbRate: number | null, showPlus = false): string {
  const converted = convertUsdForDisplay(valueUsd, currency, usdThbRate);
  if (converted === null) return 'ไม่มีข้อมูล';
  const normalized = Object.is(converted, -0) ? 0 : converted;
  const sign = normalized < 0 ? '-' : showPlus && normalized > 0 ? '+' : '';
  const symbol = currency === 'USD' ? '$' : '฿';
  const amount = Math.abs(normalized).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${sign}${symbol}${amount}`;
}

export function formatResultNumber(value: number, fractionDigits = 2): string {
  if (!Number.isFinite(value)) return 'ไม่มีข้อมูล';
  const normalized = Object.is(value, -0) ? 0 : value;
  return normalized.toLocaleString('en-US', { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
}

export function safeProfitLossPercent(amount: number, denominator: number | null): number | null {
  if (!Number.isFinite(amount) || denominator === null || !Number.isFinite(denominator) || denominator <= 0) return null;
  const percentage = amount / denominator * 100;
  return Number.isFinite(percentage) ? percentage : null;
}

export function formatSignedPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'คำนวณ % ไม่ได้';
  const normalized = Object.is(value, -0) ? 0 : value;
  return `${normalized > 0 ? '+' : ''}${normalized.toFixed(2)}%`;
}

export function profitLossState(value: number): ProfitLossState {
  return value > 0 ? 'profit' : value < 0 ? 'loss' : 'break-even';
}

export function profitLossStateLabel(state: ProfitLossState): string {
  return state === 'profit' ? 'กำไร' : state === 'loss' ? 'ขาดทุน' : 'คุ้มทุน';
}

export function profitLossToneClass(state: ProfitLossState): string {
  return state === 'profit' ? 'text-emerald-400' : state === 'loss' ? 'text-red-400' : 'text-slate-300';
}

export function buildProfitLossSummary(
  amountUsd: number,
  denominatorUsd: number | null,
  currency: ResultCurrency,
  usdThbRate: number | null,
): string {
  if (!Number.isFinite(amountUsd)) return 'ไม่มีข้อมูลกำไร/ขาดทุนที่คำนวณได้';
  const state = profitLossState(amountUsd);
  const label = profitLossStateLabel(state);
  const amount = formatResultMoney(Math.abs(amountUsd), currency, usdThbRate);
  const percentage = safeProfitLossPercent(Math.abs(amountUsd), denominatorUsd);
  if (percentage === null) {
    return `${label} ${amount} แต่คำนวณเปอร์เซ็นต์ไม่ได้ เพราะไม่มีฐานเงินที่เสี่ยงเริ่มต้นที่มากกว่า 0`;
  }
  return `${label} ${amount} คิดเป็น ${formatResultNumber(percentage)}% ของเงินที่เสี่ยงเริ่มต้น`;
}

export type ReconciliationStatus = 'matched' | 'mismatch' | 'unavailable';

export interface ResultReconciliationInput {
  currentValue: number | null;
  simulatedValue: number;
  changeFromCurrent: number | null;
  initialCostOrCredit: number;
  projectedProfitLoss: number;
  priceImpact: number | null;
  timeDecayImpact: number | null;
  ivImpact: number | null;
  deltaEstimate: number | null;
}

interface ReconciliationCheck {
  status: ReconciliationStatus;
  residual: number | null;
}

export interface ResultReconciliationAudit {
  valueChange: ReconciliationCheck;
  projectedProfitLoss: ReconciliationCheck;
  impactDecomposition: ReconciliationCheck & { total: number | null };
  deltaEstimate: number | null;
}

function reconciliationTolerance(values: number[]): number {
  return Math.max(1e-9, Math.max(...values.map((value) => Math.abs(value))) * 1e-10);
}

function reconciliationCheck(actual: number | null, expected: number | null): ReconciliationCheck {
  if (actual === null || expected === null || !Number.isFinite(actual) || !Number.isFinite(expected)) {
    return { status: 'unavailable', residual: null };
  }
  const residual = actual - expected;
  const matched = Math.abs(residual) <= reconciliationTolerance([actual, expected]);
  return { status: matched ? 'matched' : 'mismatch', residual: matched ? 0 : residual };
}

export function auditResultReconciliation(input: ResultReconciliationInput): ResultReconciliationAudit {
  const expectedChange = input.currentValue === null ? null : input.simulatedValue - input.currentValue;
  const expectedProfitLoss = input.simulatedValue - input.initialCostOrCredit;
  const impacts = [input.priceImpact, input.timeDecayImpact, input.ivImpact];
  const impactTotal = impacts.every((value): value is number => value !== null && Number.isFinite(value))
    ? impacts.reduce<number>((sum, value) => sum + value, 0)
    : null;

  return {
    valueChange: reconciliationCheck(input.changeFromCurrent, expectedChange),
    projectedProfitLoss: reconciliationCheck(input.projectedProfitLoss, expectedProfitLoss),
    impactDecomposition: {
      ...reconciliationCheck(input.changeFromCurrent, impactTotal),
      total: impactTotal,
    },
    // Delta is returned for display/audit context but intentionally excluded from impactTotal.
    deltaEstimate: input.deltaEstimate !== null && Number.isFinite(input.deltaEstimate) ? input.deltaEstimate : null,
  };
}

export function validationMessageParts(message: string): { path: string | null; reason: string } {
  const separator = message.indexOf(':');
  if (separator < 0) return { path: null, reason: message };
  return {
    path: message.slice(0, separator).trim() || null,
    reason: message.slice(separator + 1).trim(),
  };
}

export function validationFieldLabel(path: string): string {
  const legMatch = /^legs\.(\d+)\.(.+)$/.exec(path);
  if (legMatch) {
    const legNumber = Number(legMatch[1]) + 1;
    // Names a validation error after the label now printed on the field, so the
    // reader looks for the same words the form shows them.
    const labels: Record<string, string> = {
      kind: 'ประเภทสัญญา (Option Type)',
      side: 'ฝั่งซื้อ/ขาย (Side)',
      quantity: 'จำนวนสัญญา (Quantity)',
      strike: 'ราคาใช้สิทธิ (Strike Price)',
      expiration: 'วันหมดอายุ (Expiration)',
      entryPremium: 'ราคาสัญญาต่อหุ้น (Premium)',
      impliedVolatility: 'ความผันผวนที่ตลาดคาด (IV)',
      multiplier: 'จำนวนหุ้นต่อ 1 สัญญา (Contract Multiplier)',
      delta: 'Delta',
      theta: 'มูลค่าที่ลดลงต่อวัน (Theta)',
    };
    return `Leg ${legNumber} ${labels[legMatch[2]] ?? legMatch[2]}`;
  }

  if (/^scenarios\.\d+\.targetPrice$/.test(path)) return 'ราคาหุ้นที่อยากลอง (Target Stock Price)';
  if (/^scenarios\.\d+\.valuationDate$/.test(path)) return 'วันที่ต้องการดูผล (Target Date)';
  if (path === 'symbol') return 'หุ้นหรือ ETF';
  if (path === 'underlyingPrice') return 'ราคาหุ้นปัจจุบัน';
  if (path === 'legs') return 'รายละเอียดสัญญา';
  if (path === 'scenarios') return 'สถานการณ์ที่ทดลอง';
  return path;
}

export function displayValidationMessage(message: string): string {
  const { path, reason } = validationMessageParts(message);
  return path ? `${validationFieldLabel(path)}: ${reason}` : reason;
}

export function validationPathUnit(path: string): string {
  if (/^legs\.\d+\.entryPremium$/.test(path)) return 'USD-per-share';
  if (/^legs\.\d+\.impliedVolatility$/.test(path)) return 'engine-decimal';
  if (/^legs\.\d+\.(delta|theta)$/.test(path)) return 'finite-number';
  if (path === 'valuationDate' || /^legs\.\d+\.expiration$/.test(path) || /^scenarios\.\d+\.valuationDate$/.test(path)) return 'calendar-date';
  return 'input';
}
