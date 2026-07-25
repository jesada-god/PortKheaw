import {
  METHODOLOGY_VERSION,
  type FairValueFailureKind,
  type FairValueUnavailable,
  type InputResolutionAudit,
  type ValuationInput,
  type ValuationDiagnostic,
} from './types';

export function createFairValueUnavailable(input: {
  failureKind: FairValueFailureKind;
  symbol: string;
  currency?: string | null;
  provider?: string | null;
  reason: string;
  missingFields?: string[];
  staleInputs?: string[];
  asOf: string;
  calculatedAt: string;
  limitations: string[];
  diagnostics?: ValuationDiagnostic[];
  inputResolution?: InputResolutionAudit;
  researchAudit?: ValuationInput['researchAudit'];
  peerAudit?: ValuationInput['peerAudit'];
}): FairValueUnavailable {
  const missingFields = [...new Set(input.missingFields ?? [])];
  return {
    status: 'unavailable',
    failureKind: input.failureKind,
    symbol: input.symbol,
    currency: input.currency ?? null,
    provider: input.provider ?? null,
    reason: input.reason,
    missingFields,
    missingInputs: missingFields,
    staleInputs: [...new Set(input.staleInputs ?? [])],
    asOf: input.asOf,
    calculatedAt: input.calculatedAt,
    methodologyVersion: METHODOLOGY_VERSION,
    limitations: input.limitations,
    diagnostics: input.diagnostics ?? [],
    ...(input.inputResolution ? { inputResolution: input.inputResolution } : {}),
    ...(input.researchAudit ? { researchAudit: input.researchAudit } : {}),
    ...(input.peerAudit ? { peerAudit: input.peerAudit } : {}),
  };
}
