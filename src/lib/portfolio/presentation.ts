import { fixed, fixedMultiply, fixedToNumber } from '../money/fixed';
import type { SupportedCurrency } from '../market-data/fx/types';
import { SENSITIVE_VALUE_MASK } from '../privacy';

export function convertUsd(value: number | string, currency: SupportedCurrency, usdThbRate: string | null): number | null {
  if (currency === 'USD') return fixedToNumber(fixed(value));
  if (!usdThbRate) return null;
  return fixedToNumber(fixedMultiply(fixed(value), fixed(usdThbRate)));
}

export function formatPortfolioMoney(valueUsd: number | string, currency: SupportedCurrency, usdThbRate: string | null, visible = true): string {
  if (!visible) return SENSITIVE_VALUE_MASK;
  const converted = convertUsd(valueUsd, currency, usdThbRate);
  if (converted == null) return '—';
  return new Intl.NumberFormat('th-TH', { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(converted);
}

export function signedMoney(valueUsd: number, currency: SupportedCurrency, usdThbRate: string | null, visible = true): string {
  const formatted = formatPortfolioMoney(Math.abs(valueUsd), currency, usdThbRate, visible);
  if (!visible || formatted === '—' || valueUsd === 0) return formatted;
  return `${valueUsd > 0 ? '+' : '-'}${formatted}`;
}

export function signedPercent(value: number, visible = true): string {
  if (!visible) return SENSITIVE_VALUE_MASK;
  const safe = Number.isFinite(value) ? value : 0;
  return `${safe > 0 ? '+' : ''}${safe.toFixed(2)}%`;
}

export function gainColor(value: number): string {
  return value > 0 ? 'text-emerald-400' : value < 0 ? 'text-red-400' : 'text-slate-300';
}
