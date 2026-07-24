import { z } from 'zod';
import { symbolSchema } from '@/src/lib/market-data/validation';
import { METHODOLOGY_VERSION, SECTOR_RULE_VERSION } from './types';

const finite = z.number().finite();
export const dcfAssumptionsSchema = z.object({
  forecastHorizon: z.number().int().min(1).max(10), revenueGrowth: finite.min(-.5).max(1), operatingMargin: finite.min(-1).max(1), taxRate: finite.min(0).max(.6), depreciationPercentRevenue: finite.min(0).max(.5), capexPercentRevenue: finite.min(0).max(1), workingCapitalPercentRevenue: finite.min(-.5).max(.5), wacc: finite.gt(0).max(.5), terminalGrowth: finite.min(-.1).max(.1), dilutionRate: finite.min(-.2).max(.5),
}).refine((value) => value.wacc > value.terminalGrowth, { message: 'WACC must be greater than terminal growth', path: ['wacc'] });

export const fairValueRequestSchema = z.object({ symbol: symbolSchema, scenario: z.enum(['conservative', 'base', 'optimistic', 'user-defined']), assumptions: dcfAssumptionsSchema.optional() }).refine((value) => value.scenario !== 'user-defined' || Boolean(value.assumptions), { message: 'User-defined scenario requires explicit assumptions', path: ['assumptions'] });

export const fairValueFailureKindSchema = z.enum([
  'provider-unavailable',
  'provider-rate-limited',
  'mapping-error',
  'insufficient-periods',
  'missing-field',
  'currency-mismatch',
  'stale-fundamentals',
  'calculation-error',
]);

const modelIdSchema = z.enum([
  'fcff-dcf',
  'fcfe',
  'ddm',
  'relative',
  'asset-based',
  'ev-sales',
  'ev-ebitda',
  'pe',
  'peg',
  'pb',
]);
const analyticsSourceTypeSchema = z.enum([
  'provider-supplied',
  'calculated',
  'estimated',
  'user-provided',
]);
const rangeSchema = z.object({ low: finite.nullable(), high: finite.nullable() });
const excludedModelSchema = z.object({
  model: modelIdSchema,
  reason: z.string(),
});
const unavailableSchema = z.object({
  status: z.literal('unavailable'),
  failureKind: fairValueFailureKindSchema,
  symbol: symbolSchema,
  currency: z.string().nullable(),
  provider: z.string().nullable(),
  reason: z.string().min(1),
  missingFields: z.array(z.string()),
  missingInputs: z.array(z.string()),
  staleInputs: z.array(z.string()),
  asOf: z.string().min(1),
  calculatedAt: z.iso.datetime(),
  methodologyVersion: z.literal(METHODOLOGY_VERSION),
  limitations: z.array(z.string()),
});
const availableSchema = z.object({
  status: z.literal('available'),
  symbol: symbolSchema,
  currency: z.string(),
  marketPrice: z.object({
    value: finite,
    asOf: z.string(),
    source: z.string(),
    sourceType: analyticsSourceTypeSchema,
  }),
  companyClassification: z.object({
    classification: z.array(z.string()),
    evidence: z.array(z.string()),
    eligibleModels: z.array(modelIdSchema),
    excludedModels: z.array(excludedModelSchema),
  }),
  modelResults: z.array(z.object({
    model: modelIdSchema,
    fairValue: finite,
    weight: finite,
    configuredWeight: finite.optional(),
    normalizedWeight: finite.optional(),
    scenarios: z.object({
      conservative: finite,
      base: finite,
      optimistic: finite,
    }).optional(),
    reason: z.string().optional(),
    methodology: z.string(),
    inputs: z.record(z.string(), z.union([z.number(), z.string()])),
    assumptions: z.record(z.string(), z.union([z.number(), z.string()])),
    limitations: z.array(z.string()),
  })),
  excludedModels: z.array(excludedModelSchema),
  fundamentalFairValue: z.object({
    conservative: rangeSchema,
    base: rangeSchema,
    optimistic: rangeSchema,
    centralEstimate: finite.nullable(),
    dispersion: finite.nullable(),
  }),
  baseStatus: z.enum(['available', 'unavailable']),
  technicalContext: z.unknown(),
  fundamentalQuality: z.object({
    score: finite,
    categories: z.array(z.unknown()),
    limitation: z.string(),
  }),
  dataQuality: z.object({
    score: finite,
    completeness: finite,
    freshness: finite,
    periodConsistency: finite,
    currencyConsistency: finite,
  }),
  modelReliability: z.object({
    level: z.enum(['High', 'Moderate', 'Low', 'Unavailable']),
    score: finite.nullable(),
    components: z.record(z.string(), finite),
    explanation: z.string(),
  }),
  dataQualityLabel: z.enum(['High', 'Medium', 'Low']),
  reliabilityReasons: z.array(z.string()),
  missingInputs: z.array(z.string()),
  dataStatus: z.enum(['live', 'delayed', 'cached', 'stale', 'limited']),
  selectedModel: z.union([modelIdSchema, z.literal('blended')]),
  upsideAmount: finite.nullable(),
  upsidePercent: finite.nullable(),
  sector: z.string(),
  industry: z.string(),
  sectorRuleId: z.string(),
  sectorRuleVersion: z.literal(SECTOR_RULE_VERSION),
  inputDetails: z.array(z.object({
    field: z.string(),
    value: z.union([z.number(), z.string()]),
    currency: z.string().nullable(),
    period: z.string(),
    provider: z.string(),
    asOf: z.string(),
    status: z.enum(['available', 'limited', 'stale']),
    origin: z.enum(['provider', 'derived']),
    sourceType: z.enum(['structured-provider', 'gemini-grounded', 'derived']),
    sourceUrl: z.url().optional(),
    evidenceCount: z.number().int().nonnegative().optional(),
    evidence: z.array(z.object({
      url: z.url(),
      publisher: z.string(),
      publishedAt: z.string(),
      evidence: z.string(),
      quality: z.enum(['primary', 'reputable', 'secondary']),
    })).optional(),
  })),
  assumptionDetails: z.array(z.object({
    field: z.string(),
    value: z.union([z.number(), z.string()]),
    source: z.enum(['model-assumption', 'provider', 'historical-derived']),
    ruleVersion: z.literal(SECTOR_RULE_VERSION),
  })),
  displayFx: z.object({
    rate: finite,
    asOf: z.string(),
    provider: z.string(),
    status: z.enum(['live', 'cached', 'stale']),
  }).nullable().optional(),
  inputs: z.record(z.string(), z.unknown()),
  assumptions: z.record(z.string(), z.unknown()),
  researchAudit: z.object({
    geminiUsed: z.boolean(),
    evidenceSourceCount: z.number().int().nonnegative(),
    rejectedReasons: z.array(z.string()),
  }).optional(),
  sources: z.array(z.object({
    name: z.string(),
    asOf: z.string(),
    sourceType: analyticsSourceTypeSchema,
  })),
  latestDataAt: z.string(),
  calculatedAt: z.iso.datetime(),
  methodologyVersion: z.literal(METHODOLOGY_VERSION),
  limitations: z.array(z.string()),
});

/** Runtime contract shared by the API boundary and browser request client. */
export const fairValueResultSchema = z.discriminatedUnion('status', [
  availableSchema,
  unavailableSchema,
]);
