import type { FairValueFailureKind } from './types';

export interface FairValueLogEntry {
  event: 'fair_value_evaluation';
  status: 'available' | 'unavailable' | 'disabled';
  symbol?: string;
  provider?: string;
  failureKind?: FairValueFailureKind | 'feature-disabled';
  missingInputCount?: number;
  errorCode?: string;
}

export type FairValueLogger = (entry: FairValueLogEntry) => void;

export type FairValueFieldState =
  | 'provider-hit'
  | 'provider-miss'
  | 'derived'
  | 'research-started'
  | 'research-hit'
  | 'research-rejected'
  | 'research-error'
  | 'merged'
  | 'final-missing';

export interface FairValueFieldLogEntry {
  event: 'fair_value_field_resolution';
  symbol: string;
  field: string;
  state: FairValueFieldState;
  provider?: string;
  reason?: string;
  asOf: string;
}

export interface FairValueRuntimeLogEntry {
  event: 'fair_value_runtime_configuration';
  symbol: string;
  secUserAgentConfigured: boolean;
  geminiConfigured: boolean;
  groundingConfigured: boolean;
  fundamentalsProviderConfigured: boolean;
  valuationProviderConfigured: boolean;
  historyProviderConfigured: boolean;
  lkgReadConfigured: boolean;
  lkgWriteConfigured: boolean;
  valuationLkgReadConfigured?: boolean;
  valuationLkgWriteConfigured?: boolean;
}

export interface FairValueResolutionAuditLogEntry {
  event: 'fair_value_resolution_audit';
  symbol: string;
  field: 'beta' | 'riskFreeRate' | 'equityRiskPremium' | 'targetForwardEstimate';
  stage: 'history' | 'normalization' | 'future-estimate-validation';
  provider?: string;
  available: boolean;
  reason?: string;
  asOf: string;
  targetRows?: number;
  benchmarkRows?: number;
  alignedObservations?: number;
  minimumSamples?: number;
  frequency?: 'daily';
  period?: string | null;
  value?: number | null;
  currency?: string | null;
  schemaPassed?: boolean;
  validFutureEstimatePassed?: boolean;
}

const SAFE_ERROR_CODES = new Set([
  'provider-not-configured',
  'invalid-request',
  'invalid-symbol',
  'not-found',
  'rate-limited',
  'timeout',
  'provider-unauthorized',
  'upstream-unavailable',
  'invalid-provider-response',
  'insufficient-data',
  'internal-error',
]);

const SAFE_ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'AbortError',
  'TimeoutError',
  'MarketDataError',
]);

export function safeFairValueErrorCode(cause: unknown): string {
  if (cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string') {
    if (SAFE_ERROR_CODES.has(cause.code)) return cause.code;
  }
  return cause instanceof Error && SAFE_ERROR_NAMES.has(cause.name)
    ? cause.name
    : 'unknown-error';
}

export const writeFairValueLog: FairValueLogger = (entry) => {
  const serialized = JSON.stringify(entry);
  if (entry.status === 'available') console.info(serialized);
  else console.warn(serialized);
};

/** Safe field-level trace: the contract intentionally has no value or secret fields. */
export function writeFairValueFieldLog(entry: FairValueFieldLogEntry): void {
  const serialized = JSON.stringify(entry);
  if (entry.state === 'research-error' || entry.state === 'final-missing') {
    console.warn(serialized);
  } else {
    console.info(serialized);
  }
}

/** Boolean-only production configuration trace; credentials are never serialized. */
export function writeFairValueRuntimeLog(entry: FairValueRuntimeLogEntry): void {
  console.info(JSON.stringify(entry));
}

/** Sanitized numeric audit for model inputs; no credentials or raw model text are accepted. */
export function writeFairValueResolutionAuditLog(
  entry: FairValueResolutionAuditLogEntry,
): void {
  console.info(JSON.stringify(entry));
}
