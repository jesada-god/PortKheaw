export type OptionKind = 'call' | 'put';
export type PositionSide = 'buy' | 'sell';
export type ExerciseStyle = 'european' | 'american';
export type SimulationType = 'what-if' | 'monte-carlo';
export type DataStatus = 'live' | 'delayed' | 'stale' | 'manual' | 'unavailable';
export type GreekDataSource = 'provider' | 'model' | 'manual';
export type ContractInputMode = 'provider' | 'custom';
export type PremiumSource = 'bid' | 'ask' | 'mark' | 'last' | 'manual';

export interface OptionLeg {
  id: string;
  kind: OptionKind;
  side: PositionSide;
  quantity: number;
  strike: number;
  expiration: string;
  entryPremium: number;
  impliedVolatility: number;
  multiplier: number;
  fees: number;
  style: ExerciseStyle;
  delta?: number | null;
  theta?: number | null;
  deltaSource?: GreekDataSource;
  thetaSource?: GreekDataSource;
  deltaTimestamp?: string | null;
  thetaTimestamp?: string | null;
  gamma?: number | null;
  vega?: number | null;
  rho?: number | null;
  contractSymbol?: string | null;
  bid?: number | null;
  ask?: number | null;
  midpoint?: number | null;
  mark?: number | null;
  last?: number | null;
  volume?: number | null;
  openInterest?: number | null;
  premiumSource?: PremiumSource;
  inputMode?: ContractInputMode;
  contractProvider?: string | null;
  contractAsOf?: string | null;
  contractStatus?: 'live' | 'delayed' | 'cached' | 'stale';
}

export interface ScenarioInput {
  id: string;
  name: string;
  targetPrice: number;
  valuationDate: string;
  volatilityShift: number;
  rate: number;
  dividendYield: number;
}

export interface MonteCarloSettings {
  paths: number;
  seed: number;
  horizonDays: number;
  steps: number;
  drift: number;
  volatility: number;
  rate: number;
  dividendYield: number;
  driftMode?: 'forecast' | 'risk-neutral';
}

export interface SimulationWorkspace {
  id?: string;
  name: string;
  description: string;
  symbol: string;
  companyName: string;
  exchange: string | null;
  currency: string;
  simulationType: SimulationType;
  strategyType: string;
  underlyingPrice: number | null;
  stockQuantity: number;
  cashPosition: number;
  entryDate: string;
  valuationDate: string;
  legs: OptionLeg[];
  scenarios: ScenarioInput[];
  monteCarlo: MonteCarloSettings;
  dataSource: string | null;
  dataTimestamp: string | null;
  dataStatus: DataStatus;
  resultSnapshot: { whatIf?: PortfolioValuation; monteCarlo?: MonteCarloResult; scenarioScore?: unknown } | null;
  methodologyVersion: 'options-simulator-v1';
  updatedAt?: string;
}

export interface Greeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
}

export interface LegValuation {
  legId: string;
  value: number;
  profitLoss: number;
  intrinsicValue: number;
  timeValue: number;
  breakEven: number;
  greeks: Greeks;
}

/** Shared result invariants returned by both What-If and Monte Carlo. */
export interface CanonicalStrategyResult {
  /** Cash paid to open the position; zero for net-credit positions. */
  initialDebit: number;
  /** Finite positive capital at risk, or null when loss is unbounded/zero. */
  initialRisk: number | null;
  /** P&L divided by initialRisk; null exactly when initialRisk is unavailable. */
  returnPct: number | null;
  /** Positive loss magnitude, or null for unlimited loss. */
  maxLoss: number | null;
  /** Exact isolated expiration roots, sorted and deduplicated. */
  breakEvenPrices: number[];
}

export interface PortfolioValuation extends CanonicalStrategyResult {
  legs: LegValuation[];
  theoreticalValue: number;
  profitLoss: number;
  netDebitCredit: number;
  greeks: Greeks;
  maxProfit: number | null;
  unlimitedProfit: boolean;
  unlimitedLoss: boolean;
  payoff: Array<{ price: number; profitLoss: number }>;
}

export interface MonteCarloResult extends CanonicalStrategyResult {
  paths: number;
  seed: number;
  probabilityOfProfit: number;
  probabilityItm: number;
  probabilityOtm: number;
  expectedProfitLoss: number;
  medianProfitLoss: number;
  percentiles: Record<'p1' | 'p5' | 'p95' | 'p99', number>;
  confidenceIntervals: { p95: [number, number]; p99: [number, number] };
  expectedDrawdown: number;
  valueAtRisk: { p95: number; p99: number };
  expectedShortfall: { p95: number; p99: number };
  targetPrice?: number;
  probabilityReachingTarget?: number;
  probabilityClosingAboveTarget?: number;
  probabilityClosingBelowTarget?: number;
  histogram: Array<{ lower: number; upper: number; count: number }>;
  samplePaths: number[][];
  pathSetId?: string;
  generatedPaths?: number;
}
