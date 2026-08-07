import { z } from 'zod';
import type { MonteCarloCalculationInput, WhatIfCalculationInput } from './compute-dto';
import type { SimulationWorkspace } from './types';

const finite = z.number().finite();
const date = z.iso.date();

export const optionLegSchema = z.object({
  id: z.string().min(1).max(80),
  kind: z.enum(['call', 'put']),
  side: z.enum(['buy', 'sell']),
  quantity: z.number().finite().int().positive().max(1_000_000),
  strike: finite.positive().max(1_000_000_000),
  expiration: date,
  entryPremium: finite.positive().max(1_000_000_000),
  impliedVolatility: finite.positive().max(10),
  multiplier: finite.positive().max(100_000),
  fees: finite.nonnegative().max(1_000_000_000),
  style: z.enum(['european', 'american']),
  delta: finite.min(-1).max(1).nullable().optional(),
  theta: finite.nullable().optional(),
  deltaSource: z.enum(['provider', 'model', 'manual']).optional(),
  thetaSource: z.enum(['provider', 'model', 'manual']).optional(),
  deltaTimestamp: z.iso.datetime().nullable().optional(),
  thetaTimestamp: z.iso.datetime().nullable().optional(),
  gamma: finite.nullable().optional(),
  vega: finite.nullable().optional(),
  rho: finite.nullable().optional(),
  contractSymbol: z.string().min(1).max(120).nullable().optional(),
  bid: finite.nonnegative().nullable().optional(),
  ask: finite.nonnegative().nullable().optional(),
  midpoint: finite.nonnegative().nullable().optional(),
  mark: finite.nonnegative().nullable().optional(),
  last: finite.nonnegative().nullable().optional(),
  volume: z.number().int().nonnegative().nullable().optional(),
  openInterest: z.number().int().nonnegative().nullable().optional(),
  premiumSource: z.enum(['bid', 'ask', 'mark', 'last', 'manual']).optional(),
  inputMode: z.enum(['provider', 'custom']).optional(),
  contractProvider: z.string().max(120).nullable().optional(),
  contractAsOf: z.iso.datetime().nullable().optional(),
  contractStatus: z.enum(['live', 'delayed', 'cached', 'stale']).optional(),
});

export const scenarioSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().trim().min(1).max(80),
  targetPrice: finite.positive().max(1_000_000_000),
  valuationDate: date,
  volatilityShift: finite.min(-0.99).max(10),
  rate: finite.min(-1).max(2),
  dividendYield: finite.min(-1).max(2),
});

export const monteCarloSettingsSchema = z.object({
  paths: z.union([z.literal(1_000), z.literal(5_000), z.literal(10_000), z.literal(25_000), z.literal(50_000)]),
  seed: z.number().int().min(0).max(4_294_967_295),
  horizonDays: z.number().int().min(1).max(3_650),
  steps: z.number().int().min(1).max(366),
  drift: finite.min(-2).max(2),
  volatility: finite.positive().max(10),
  rate: finite.min(-1).max(2),
  dividendYield: finite.min(-1).max(2),
  driftMode: z.enum(['forecast', 'risk-neutral']).optional(),
});

const calculationOptionLegSchema = z.object({
  kind: z.enum(['call', 'put']),
  side: z.enum(['buy', 'sell']),
  quantity: z.number().finite().int().positive().max(1_000_000),
  strike: finite.positive().max(1_000_000_000),
  expiration: date,
  entryPremium: finite.positive().max(1_000_000_000),
  // Engine unit: decimal volatility. The UI converts percentage points exactly once.
  impliedVolatility: finite.positive().max(10),
  multiplier: finite.positive().max(100_000),
  delta: finite.min(-1).max(1).nullable().optional(),
  theta: finite.nullable().optional(),
});

const calculationScenarioSchema = z.object({
  targetPrice: finite.positive().max(1_000_000_000),
  valuationDate: date,
});

export const calculationWorkspaceSchema = z.object({
  symbol: z.string().trim().regex(/^(\^[A-Z0-9]+|[A-Z0-9][A-Z0-9.-]{0,19})$/),
  underlyingPrice: finite.positive(),
  valuationDate: date,
  legs: z.array(calculationOptionLegSchema).min(1).max(20),
  scenarios: z.array(calculationScenarioSchema).min(1).max(20),
}).superRefine((workspace, context) => {
  workspace.legs.forEach((leg, index) => {
    if (leg.expiration <= workspace.valuationDate) {
      context.addIssue({ code: 'custom', path: ['legs', index, 'expiration'], message: 'Expiration must be after valuation date' });
    }
  });

  const earliestExpiration = workspace.legs.map((leg) => leg.expiration).sort()[0];
  workspace.scenarios.forEach((scenario, index) => {
    if (scenario.valuationDate <= workspace.valuationDate) {
      context.addIssue({ code: 'custom', path: ['scenarios', index, 'valuationDate'], message: 'Target date must be after valuation date' });
    } else if (earliestExpiration && scenario.valuationDate > earliestExpiration) {
      context.addIssue({ code: 'custom', path: ['scenarios', index, 'valuationDate'], message: 'Target date must not be after expiration' });
    }
  });
});

const calculationLegSchema = z.object({
  id: z.string().min(1).max(80),
  kind: z.enum(['call', 'put']),
  side: z.enum(['buy', 'sell']),
  quantity: z.number().finite().int().positive().max(1_000_000),
  strike: finite.positive().max(1_000_000_000),
  expiration: date,
  entryPremium: finite.positive().max(1_000_000_000),
  // Wire and engine unit: decimal volatility (115.27% is exactly 1.1527 here).
  impliedVolatility: finite.positive().max(10),
  multiplier: finite.positive().max(100_000),
  fees: finite.nonnegative().max(1_000_000_000),
  style: z.enum(['european', 'american']),
}).strict();

const calculationInputScenarioSchema = z.object({
  targetPrice: finite.positive().max(1_000_000_000),
  targetDate: date,
  volatilityShift: finite.min(-0.99).max(10),
  rate: finite.min(-1).max(2),
  dividendYield: finite.min(-1).max(2),
}).strict();

/** The calculation-only portfolio contract shared by both calculation modes. */
export const calculationPortfolioInputSchema = z.object({
  symbol: z.string().trim().regex(/^(\^[A-Z0-9]+|[A-Z0-9][A-Z0-9.-]{0,19})$/),
  spot: finite.positive().max(1_000_000_000),
  valuationDate: date,
  stockQuantity: finite.min(-1_000_000).max(1_000_000),
  cashPosition: finite.min(-1_000_000_000_000).max(1_000_000_000_000),
  legs: z.array(calculationLegSchema).min(1).max(20),
  scenario: calculationInputScenarioSchema,
}).strict().superRefine((input, context) => {
  input.legs.forEach((leg, index) => {
    if (leg.expiration <= input.valuationDate) {
      context.addIssue({ code: 'custom', path: ['legs', index, 'expiration'], message: 'Expiration must be after valuation date' });
    }
  });
  const earliestExpiration = input.legs.map((leg) => leg.expiration).sort()[0];
  /*
    Inclusive at the top: the expiration day itself is a legitimate day to value
    on — the engine returns intrinsic value at T=0 — and only the day *after* it
    is a contract that no longer exists. This is the API's own copy of the rule
    in `calendar-date`, so a hand-rolled POST cannot get past what the field
    refuses.
  */
  if (input.scenario.targetDate <= input.valuationDate) {
    context.addIssue({ code: 'custom', path: ['scenario', 'targetDate'], message: 'Target date must be after valuation date' });
  } else if (earliestExpiration && input.scenario.targetDate > earliestExpiration) {
    context.addIssue({ code: 'custom', path: ['scenario', 'targetDate'], message: 'Target date must not be after expiration' });
  }
});

export const whatIfCalculationInputSchema = calculationPortfolioInputSchema;
export const whatIfCalculationRequestSchema = z.object({ input: whatIfCalculationInputSchema }).strict();

const monteCarloQualityLegSchema = z.object({
  id: z.string().min(1).max(80),
  inputMode: z.enum(['provider', 'custom']).optional(),
  contractProvider: z.string().max(120).nullable().optional(),
  premiumSource: z.enum(['bid', 'ask', 'mark', 'last', 'manual']).optional(),
  bid: finite.nonnegative().nullable().optional(),
  ask: finite.nonnegative().nullable().optional(),
  volume: z.number().int().nonnegative().nullable().optional(),
  openInterest: z.number().int().nonnegative().nullable().optional(),
  contractStatus: z.enum(['live', 'delayed', 'cached', 'stale']).optional(),
}).strict();

const monteCarloQualitySchema = z.object({
  dataStatus: z.enum(['live', 'delayed', 'stale', 'manual', 'unavailable']),
  dataSource: z.string().max(120).nullable(),
  dataTimestamp: z.iso.datetime().nullable(),
  legs: z.array(monteCarloQualityLegSchema).max(20),
}).strict();

export const monteCarloCalculationInputSchema = z.object({
  portfolio: calculationPortfolioInputSchema,
  comparisonPortfolio: calculationPortfolioInputSchema,
  settings: monteCarloSettingsSchema.extend({ driftMode: z.enum(['forecast', 'risk-neutral']) }).strict(),
  quality: monteCarloQualitySchema,
}).strict();

export const monteCarloCalculationRequestSchema = z.object({ input: monteCarloCalculationInputSchema }).strict();

export const simulationWorkspaceSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2_000),
  symbol: z.string().trim().regex(/^(\^[A-Z0-9]+|[A-Z0-9][A-Z0-9.-]{0,19})$/),
  companyName: z.string().trim().min(1).max(200),
  exchange: z.string().max(80).nullable(),
  currency: z.string().trim().min(3).max(8),
  simulationType: z.enum(['what-if', 'monte-carlo']),
  strategyType: z.string().trim().min(1).max(80),
  underlyingPrice: finite.positive().nullable(),
  stockQuantity: finite.min(-1_000_000).max(1_000_000),
  cashPosition: finite.min(-1_000_000_000_000).max(1_000_000_000_000),
  entryDate: date,
  valuationDate: date,
  legs: z.array(optionLegSchema).min(1).max(20),
  scenarios: z.array(scenarioSchema).min(1).max(20),
  monteCarlo: monteCarloSettingsSchema,
  dataSource: z.string().max(120).nullable(),
  dataTimestamp: z.iso.datetime().nullable(),
  dataStatus: z.enum(['live', 'delayed', 'stale', 'manual', 'unavailable']),
  resultSnapshot: z.object({ whatIf: z.unknown().optional(), monteCarlo: z.unknown().optional(), scenarioScore: z.unknown().optional() }).nullable(),
  methodologyVersion: z.literal('options-simulator-v1'),
  updatedAt: z.iso.datetime().optional(),
}).superRefine((workspace, context) => {
  workspace.legs.forEach((leg, index) => {
    if (leg.expiration <= workspace.valuationDate) {
      context.addIssue({ code: 'custom', path: ['legs', index, 'expiration'], message: 'Expiration must be after valuation date' });
    }
  });
  workspace.scenarios.forEach((scenario, index) => {
    if (scenario.valuationDate < workspace.valuationDate) {
      context.addIssue({ code: 'custom', path: ['scenarios', index, 'valuationDate'], message: 'Scenario date cannot precede valuation date' });
    }
  });
});

export type SimulationWorkspaceInput = z.infer<typeof simulationWorkspaceSchema>;

function calculationIssueMessage(path: string): string {
  if (path === 'symbol') return 'กรุณาเลือกหุ้นก่อนคำนวณ';
  if (path === 'underlyingPrice') return 'ราคาหุ้นปัจจุบันต้องมากกว่า 0';
  if (path === 'spot') return 'ราคาหุ้นปัจจุบันต้องมากกว่า 0';
  if (/^legs\.\d+\.kind$/.test(path)) return 'ประเภทสัญญาต้องเป็น Call หรือ Put';
  if (/^legs\.\d+\.side$/.test(path)) return 'ฝั่งซื้อ/ขายต้องเป็น Buy หรือ Sell';
  if (/^legs\.\d+\.strike$/.test(path)) return 'ราคาใช้สิทธิต้องมากกว่า 0';
  if (/^legs\.\d+\.entryPremium$/.test(path)) return 'ราคาสัญญาต่อหุ้นต้องมากกว่า 0';
  if (/^legs\.\d+\.impliedVolatility$/.test(path)) return 'ความผันผวนที่ตลาดคาดต้องมากกว่า 0% และไม่เกิน 1,000%';
  if (/^legs\.\d+\.multiplier$/.test(path)) return 'จำนวนหุ้นต่อ 1 สัญญาต้องมากกว่า 0';
  if (/^legs\.\d+\.delta$/.test(path)) return 'Delta ต้องอยู่ระหว่าง -1 ถึง 1';
  if (/^legs\.\d+\.theta$/.test(path)) return 'มูลค่าที่ลดลงต่อวันต้องเป็นตัวเลข และติดลบได้';
  if (/^legs\.\d+\.expiration$/.test(path)) return 'วันหมดอายุต้องอยู่หลังวันที่ใช้คำนวณ';
  if (/^legs\.\d+\.quantity$/.test(path)) return 'จำนวนสัญญาต้องเป็นจำนวนเต็มที่มากกว่า 0';
  if (/^scenarios\.\d+\.targetPrice$/.test(path)) return 'ราคาหุ้นที่อยากลองต้องมากกว่า 0';
  if (/^scenarios\.\d+\.valuationDate$/.test(path)) return 'วันที่ดูผลต้องอยู่หลังวันที่ใช้คำนวณ และต้องไม่เกินวันหมดอายุ';
  if (path === 'scenario.targetDate') return 'วันที่ดูผลต้องอยู่หลังวันที่ใช้คำนวณ และต้องไม่เกินวันหมดอายุ';
  if (path === 'scenario.volatilityShift') return 'ค่า IV ที่ใช้คำนวณต้องเป็นตัวเลขที่ถูกต้อง';
  if (path === 'scenario.rate') return 'อัตราดอกเบี้ยที่ใช้คำนวณต้องเป็นตัวเลขที่ถูกต้อง';
  if (path === 'scenario.dividendYield') return 'อัตราเงินปันผลที่ใช้คำนวณต้องเป็นตัวเลขที่ถูกต้อง';
  if (path === 'monteCarlo.paths') return 'จำนวนรอบจำลองต้องเป็น 1,000, 5,000, 10,000, 25,000 หรือ 50,000';
  if (path === 'monteCarlo.seed') return 'ค่าเริ่มสุ่มต้องเป็นจำนวนเต็มตั้งแต่ 0 ถึง 4,294,967,295';
  if (path === 'monteCarlo.volatility') return 'ค่า IV สำหรับ Monte Carlo ต้องมากกว่า 0% และไม่เกิน 1,000%';
  if (path.startsWith('monteCarlo.')) return 'สมมติฐาน Monte Carlo ช่องนี้ต้องเป็นตัวเลขที่ถูกต้อง';
  if (path === 'legs') return 'ต้องมีสัญญาอย่างน้อย 1 รายการ';
  if (path === 'scenarios') return 'ต้องมีสถานการณ์ที่ทดลองอย่างน้อย 1 รายการ';
  return 'ค่าที่กรอกยังไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง';
}

function calculationIssuePath(path: PropertyKey[]): string {
  const raw = path.map(String).join('.');
  const withoutPortfolio = raw.replace(/^(portfolio|comparisonPortfolio)\./, '');
  const normalized = withoutPortfolio.replace(/^settings\./, 'monteCarlo.');
  if (normalized === 'quality.dataTimestamp') return 'dataTimestamp';
  if (normalized === 'spot') return 'underlyingPrice';
  if (normalized === 'scenario.targetPrice') return 'scenarios.0.targetPrice';
  if (normalized === 'scenario.targetDate') return 'scenarios.0.valuationDate';
  return normalized;
}

function calculationIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = calculationIssuePath(issue.path);
    return `${path || 'simulation'}: ${calculationIssueMessage(path)}`;
  });
}

function calculationCandidate(workspace: SimulationWorkspace): unknown {
  const scenario = workspace.scenarios[0];
  return {
    symbol: workspace.symbol,
    spot: workspace.underlyingPrice,
    valuationDate: workspace.valuationDate,
    stockQuantity: workspace.stockQuantity,
    cashPosition: workspace.cashPosition,
    legs: workspace.legs.map((leg) => ({
      id: leg.id,
      kind: leg.kind,
      side: leg.side,
      quantity: leg.quantity,
      strike: leg.strike,
      expiration: leg.expiration,
      entryPremium: leg.entryPremium,
      impliedVolatility: leg.impliedVolatility,
      multiplier: leg.multiplier,
      fees: leg.fees,
      style: leg.style,
    })),
    scenario: scenario ? {
      targetPrice: scenario.targetPrice,
      targetDate: scenario.valuationDate,
      volatilityShift: scenario.volatilityShift,
      rate: scenario.rate,
      dividendYield: scenario.dividendYield,
    } : undefined,
  };
}

export function prepareWhatIfCalculationInput(workspace: SimulationWorkspace):
  | { success: true; data: WhatIfCalculationInput }
  | { success: false; issues: string[] } {
  const result = whatIfCalculationInputSchema.safeParse(calculationCandidate(workspace));
  return result.success ? { success: true, data: result.data } : { success: false, issues: calculationIssues(result.error) };
}

export function whatIfCalculationValidationMessages(input: unknown): string[] {
  const result = whatIfCalculationInputSchema.safeParse(input);
  return result.success ? [] : calculationIssues(result.error);
}

function nullableFinite(value: number | null | undefined): number | null | undefined {
  return value === null || value === undefined || Number.isFinite(value) ? value : null;
}

function qualityCandidate(workspace: SimulationWorkspace) {
  const timestamp = z.iso.datetime().safeParse(workspace.dataTimestamp);
  return {
    dataStatus: workspace.dataStatus,
    dataSource: typeof workspace.dataSource === 'string' ? workspace.dataSource.slice(0, 120) : null,
    dataTimestamp: timestamp.success ? timestamp.data : null,
    legs: workspace.legs.map((leg) => ({
      id: leg.id,
      inputMode: leg.inputMode,
      contractProvider: typeof leg.contractProvider === 'string' ? leg.contractProvider.slice(0, 120) : null,
      premiumSource: leg.premiumSource,
      bid: nullableFinite(leg.bid),
      ask: nullableFinite(leg.ask),
      volume: nullableFinite(leg.volume),
      openInterest: nullableFinite(leg.openInterest),
      contractStatus: leg.contractStatus,
    })),
  };
}

export function prepareMonteCarloCalculationInput(
  portfolio: SimulationWorkspace,
  comparisonPortfolio: SimulationWorkspace,
  settings: SimulationWorkspace['monteCarlo'],
): { success: true; data: MonteCarloCalculationInput } | { success: false; issues: string[] } {
  const result = monteCarloCalculationInputSchema.safeParse({
    portfolio: calculationCandidate(portfolio),
    comparisonPortfolio: calculationCandidate(comparisonPortfolio),
    settings: { ...settings, driftMode: settings.driftMode ?? 'forecast' },
    quality: qualityCandidate(comparisonPortfolio),
  });
  return result.success ? { success: true, data: result.data } : { success: false, issues: calculationIssues(result.error) };
}

export function monteCarloCalculationValidationMessages(input: unknown): string[] {
  const result = monteCarloCalculationInputSchema.safeParse(input);
  return result.success ? [] : calculationIssues(result.error);
}

export function calculationValidationMessages(input: unknown): string[] {
  const result = calculationWorkspaceSchema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((issue) => {
    const path = issue.path.join('.');
    return `${path || 'simulation'}: ${calculationIssueMessage(path)}`;
  });
}

export function validationMessages(input: unknown): string[] {
  const result = simulationWorkspaceSchema.safeParse(input);
  if (result.success) return [];
  return result.error.issues.map((issue) => {
    const path = issue.path.join('.');
    let message = 'กรุณาตรวจสอบช่องที่กรอกไม่ครบ';
    if (path === 'symbol' || path === 'companyName') message = 'กรุณาเลือกหุ้นก่อนคำนวณ';
    else if (/^legs\.\d+\.strike$/.test(path)) message = 'Strike Price ต้องมากกว่า 0';
    else if (/^legs\.\d+\.entryPremium$/.test(path)) message = 'Premium ต้องมากกว่า 0';
    else if (/^legs\.\d+\.impliedVolatility$/.test(path)) message = 'IV ต้องมากกว่า 0';
    else if (/^legs\.\d+\.multiplier$/.test(path)) message = 'Multiplier ต้องมากกว่า 0';
    else if (/^legs\.\d+\.delta$/.test(path)) message = 'Delta ต้องอยู่ระหว่าง -1 ถึง 1';
    else if (/^legs\.\d+\.theta$/.test(path)) message = 'Theta ต้องเป็นตัวเลขที่ถูกต้อง';
    else if (/^legs\.\d+\.expiration$/.test(path)) message = 'วันหมดอายุต้องอยู่หลังวันที่คำนวณ';
    else if (/^legs\.\d+\.quantity$/.test(path)) message = 'จำนวนสัญญาต้องมากกว่า 0';
    else if (path === 'monteCarlo.paths') message = 'Paths ต้องเป็น 1,000, 5,000, 10,000, 25,000 หรือ 50,000';
    return `${path || 'simulation'}: ${message}`;
  });
}
