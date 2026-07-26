import { z } from 'zod';

export const technicalParametersSchema = z.object({
  priceField: z.enum(['open', 'high', 'low', 'close']).default('close'),
  smaPeriod: z.number().int().min(2).max(250).default(20),
  emaPeriod: z.number().int().min(2).max(250).default(20),
  rsiPeriod: z.number().int().min(2).max(100).default(14),
  macdFastPeriod: z.number().int().min(2).max(100).default(12),
  macdSlowPeriod: z.number().int().min(3).max(250).default(26),
  macdSignalPeriod: z.number().int().min(2).max(100).default(9),
  bollingerPeriod: z.number().int().min(2).max(250).default(20),
  bollingerStdDev: z.number().finite().min(0.1).max(10).default(2),
  keltnerPeriod: z.number().int().min(2).max(250).default(20),
  keltnerAtrPeriod: z.number().int().min(2).max(100).default(14),
  keltnerAtrMultiplier: z.number().finite().min(0.1).max(10).default(1.5),
  atrPeriod: z.number().int().min(2).max(100).default(14),
  averageVolumePeriod: z.number().int().min(2).max(250).default(20),
  stochasticPeriod: z.number().int().min(2).max(100).default(14),
  stochasticSmoothK: z.number().int().min(1).max(20).default(3),
  stochasticSmoothD: z.number().int().min(1).max(20).default(3),
  adxPeriod: z.number().int().min(2).max(100).default(14),
  rocPeriod: z.number().int().min(1).max(100).default(12),
  ichimokuConversionPeriod: z.number().int().min(2).max(100).default(9),
  ichimokuBasePeriod: z.number().int().min(2).max(150).default(26),
  ichimokuSpanPeriod: z.number().int().min(2).max(250).default(52),
  ichimokuDisplacement: z.number().int().min(1).max(100).default(26),
}).refine((value) => value.macdFastPeriod < value.macdSlowPeriod, {
  message: 'MACD fast period must be less than slow period',
  path: ['macdFastPeriod'],
});

export const DEFAULT_TECHNICAL_PARAMETERS = technicalParametersSchema.parse({});
