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
  LiquidityGrade,
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
  /**
   * THE published direction score, and the reason this field is in the SUMMARY
   * rather than in the breakdown: the card shows it to every entitled reader,
   * the modal shows the same number to an Elite one, and a card that had to
   * derive its own number is exactly how the two came to disagree.
   *
   * One scale only. There is no bipolar twin of this field anywhere.
   */
  directionScore0to100: number | null;
  /** The conversion written out, so the modal can show its arithmetic. */
  scoreFormula: string | null;
  confidenceScore: number;
  underlyingBias: UnderlyingBias | null;
  /** Oldest source timestamp behind the signal. The one time the card may show. */
  asOf: string | null;
  /** True when the sources span more than the configured window. */
  staleMix: boolean;
  /** Chain tradeability badge. Never part of the direction. */
  liquidityGrade: LiquidityGrade | null;
  configVersion: string;
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
    directionScore0to100: result.status === 'available' ? result.diagnostics.directionScore0to100 : null,
    scoreFormula: result.status === 'available' ? result.diagnostics.scoreFormula : null,
    confidenceScore: result.confidenceScore,
    underlyingBias: result.status === 'available' ? result.underlyingBias : null,
    asOf: result.asOf,
    staleMix: result.staleMix,
    liquidityGrade: result.liquidityGrade,
    configVersion: result.configVersion,
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
