import { z } from 'zod';

const nullableScalar = z.union([z.string(), z.number()]).nullable().optional();

export const financialModelingPrepProfileSchema = z.object({
  symbol: z.string().optional(),
  companyName: z.string().optional(),
  description: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  currency: z.string().nullable().optional(),
  sector: z.string().nullable().optional(),
  industry: z.string().nullable().optional(),
  website: z.string().nullable().optional(),
  image: z.string().nullable().optional(),
  exchange: z.string().nullable().optional(),
  exchangeShortName: z.string().nullable().optional(),
  marketCap: nullableScalar,
  fullTimeEmployees: nullableScalar,
  fiscalYearEnd: z.string().nullable().optional(),
});

export const financialModelingPrepProfileResponseSchema = z
  .array(financialModelingPrepProfileSchema)
  .min(1);
