import { z } from 'zod';

const finite = z.number().finite();
const date = z.iso.date();

export const optionLegSchema = z.object({
  id: z.string().min(1).max(80),
  kind: z.enum(['call', 'put']),
  side: z.enum(['buy', 'sell']),
  quantity: z.number().finite().int().positive().max(1_000_000),
  strike: finite.positive().max(1_000_000_000),
  expiration: date,
  entryPremium: finite.nonnegative().max(1_000_000_000),
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
  entryPremium: finite.nonnegative().max(1_000_000_000),
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
      context.addIssue({ code: 'custom', path: ['scenarios', index, 'valuationDate'], message: 'Target date cannot exceed expiration' });
    }
  });
});

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
  resultSnapshot: z.object({ whatIf: z.unknown().optional(), monteCarlo: z.unknown().optional() }).nullable(),
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
  if (path === 'underlyingPrice') return 'Current Stock Price ต้องเป็นตัวเลขที่มากกว่า 0';
  if (/^legs\.\d+\.kind$/.test(path)) return 'Option Type ต้องเป็น Call หรือ Put';
  if (/^legs\.\d+\.side$/.test(path)) return 'Side ต้องเป็น Buy หรือ Sell';
  if (/^legs\.\d+\.strike$/.test(path)) return 'Strike Price ต้องเป็นตัวเลขที่มากกว่า 0';
  if (/^legs\.\d+\.entryPremium$/.test(path)) return 'Premium ต้องเป็นจำนวนเงินที่ไม่ติดลบ';
  if (/^legs\.\d+\.impliedVolatility$/.test(path)) return 'IV ต้องเป็น engine decimal ที่มากกว่า 0 และไม่เกิน 10';
  if (/^legs\.\d+\.multiplier$/.test(path)) return 'Multiplier ต้องเป็นตัวเลขที่มากกว่า 0';
  if (/^legs\.\d+\.delta$/.test(path)) return 'Delta ต้องเป็นตัวเลขระหว่าง -1 ถึง 1';
  if (/^legs\.\d+\.theta$/.test(path)) return 'Theta/day ต้องเป็นตัวเลข finite และอนุญาตค่าติดลบ';
  if (/^legs\.\d+\.expiration$/.test(path)) return 'Expiration ต้องอยู่หลัง Valuation Date';
  if (/^legs\.\d+\.quantity$/.test(path)) return 'Quantity ต้องเป็นจำนวนเต็มที่มากกว่า 0';
  if (/^scenarios\.\d+\.targetPrice$/.test(path)) return 'Target Stock Price ต้องเป็นตัวเลขที่มากกว่า 0';
  if (/^scenarios\.\d+\.valuationDate$/.test(path)) return 'Target Date ต้องอยู่หลัง Valuation Date และไม่เกิน Expiration';
  if (path === 'legs') return 'ต้องมีสัญญาอย่างน้อย 1 รายการ';
  if (path === 'scenarios') return 'ต้องมี What-If scenario อย่างน้อย 1 รายการ';
  return 'ค่าที่กรอกไม่ถูกต้อง';
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
    else if (/^legs\.\d+\.entryPremium$/.test(path)) message = 'Premium ต้องไม่ติดลบ';
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
