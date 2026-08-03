/**
 * The two shapes the Options Signal is served in.
 *
 * `summary` is the gauge: which way the evidence points and how strongly. It is
 * what the Pro plan sells. `breakdown` is every number behind that conclusion —
 * the per-factor scores, the reasons, Risk:Reward, the IV and earnings
 * diagnostics and the suggested setup — and it is what the Elite plan sells.
 *
 * They are separated here, in a pure projection, so the route cannot serve one
 * while accidentally serializing the other. A reader without
 * `options.signal.breakdown` receives `breakdown: null` — not an emptied object,
 * not a redacted one, absent.
 */

import type {
  OptionsSignalDiagnostics,
  OptionsSignalReason,
  OptionsSignalResult,
  OptionsSignalType,
  SuggestedOptionsSetup,
  UnderlyingBias,
} from './types';

export interface OptionsSignalSummaryDto {
  symbol: string;
  timeframe: '1D';
  calculatedAt: string;
  latestCandleAt: string | null;
  finalizedCandles: number;
  status: 'available' | 'insufficient-data';
  signalType: OptionsSignalType | null;
  confidenceScore: number;
  underlyingBias: UnderlyingBias | null;
  /**
   * Why no signal could be produced. Present only on `insufficient-data`, where
   * withholding it would leave the reader looking at an unexplained blank.
   */
  reason: string | null;
}

export interface OptionsSignalBreakdownDto {
  reasoning: OptionsSignalReason[];
  suggestedOptionsSetup: SuggestedOptionsSetup;
  diagnostics: OptionsSignalDiagnostics;
}

export interface OptionsSignalDto {
  summary: OptionsSignalSummaryDto;
  /** `null` for a reader whose plan does not include the breakdown. */
  breakdown: OptionsSignalBreakdownDto | null;
}

export function projectOptionsSignal(
  result: OptionsSignalResult,
  options: { includeBreakdown: boolean },
): OptionsSignalDto {
  const summary: OptionsSignalSummaryDto = {
    symbol: result.symbol,
    timeframe: result.timeframe,
    calculatedAt: result.calculatedAt,
    latestCandleAt: result.latestCandleAt,
    finalizedCandles: result.finalizedCandles,
    status: result.status,
    signalType: result.status === 'available' ? result.signalType : null,
    confidenceScore: result.confidenceScore,
    underlyingBias: result.status === 'available' ? result.underlyingBias : null,
    reason: result.status === 'insufficient-data' ? result.reason : null,
  };

  if (!options.includeBreakdown) return { summary, breakdown: null };

  return {
    summary,
    breakdown: {
      reasoning: result.reasoning,
      suggestedOptionsSetup: result.suggestedOptionsSetup,
      diagnostics: result.diagnostics,
    },
  };
}
