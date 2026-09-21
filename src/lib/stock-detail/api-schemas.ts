import { z } from 'zod';
import {
  apiErrorSchema,
  companyProfileSchema,
  historicalPricesSchema,
  quoteSchema,
  responseMetaSchema,
} from '@/src/lib/market-data/types';
import { symbolSchema } from '@/src/lib/market-data/validation';

function marketEnvelopeSchema<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    data: dataSchema.nullable(),
    error: apiErrorSchema.optional(),
    meta: responseMetaSchema,
  });
}

export const quoteEnvelopeSchema = marketEnvelopeSchema(quoteSchema);
export const profileEnvelopeSchema = marketEnvelopeSchema(companyProfileSchema).extend({
  status: z.enum(['fresh', 'cached', 'stale', 'unavailable']),
  providerUsed: z.string().nullable(),
  fallbackUsed: z.boolean(),
  cachedAt: z.iso.datetime().nullable(),
  retryAfterSeconds: z.number().int().nonnegative(),
  reasonCode: z.string().nullable(),
});
export const historyEnvelopeSchema = marketEnvelopeSchema(historicalPricesSchema);

/**
 * What a caller may ask to have translated: a symbol, and a language from a
 * closed set.
 *
 * ===========================================================================
 * `sourceText` IS GONE, AND THAT IS THE POINT
 * ===========================================================================
 * The request used to carry the paragraph to translate. That made the text —
 * and therefore the cache key derived from it — attacker-controlled: change one
 * character, get a new hash, miss every cache that could ever exist, and spend
 * another model call. No amount of caching downstream could bound the bill,
 * because the input space was "any string up to 6,000 characters" rather than
 * "the companies that exist".
 *
 * The server now reads the profile itself for the symbol asked for. The input
 * space is the instrument universe, which is finite and already enumerated in
 * `market_instruments`, so the translation cache can actually hold.
 *
 * `.strict()` is load-bearing here rather than tidy: it makes a client that
 * still sends `sourceText` fail loudly at the boundary instead of having the
 * field silently ignored while both sides believe it matters.
 *
 * `targetLanguage` stays a literal rather than widening to an enum. One value
 * is the tightest allowlist there is, and adding a second is a product change
 * with its own prompt, its own output validation and its own tests — not a
 * schema edit.
 */
export const companyProfileTranslationRequestSchema = z.object({
  symbol: symbolSchema,
  targetLanguage: z.literal('th'),
}).strict();

export const companyProfileTranslationDataSchema = z.object({
  symbol: symbolSchema,
  sourceText: z.string().min(1).max(6_000),
  translatedText: z.string().min(1).max(8_000),
  targetLanguage: z.literal('th'),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const companyProfileTranslationResponseSchema = z.object({
  data: companyProfileTranslationDataSchema.nullable(),
  error: z.object({
    code: z.enum([
      'invalid-request',
      'provider-not-configured',
      'model-unavailable',
      'rate-limited',
      'upstream-unavailable',
      'invalid-provider-response',
    ]),
    message: z.string(),
    retryable: z.boolean(),
    retryAfterSeconds: z.number().int().positive().optional(),
  }).optional(),
  meta: z.object({
    cached: z.boolean(),
    timestamp: z.iso.datetime(),
  }),
});

export type CompanyProfileTranslationRequest = z.infer<typeof companyProfileTranslationRequestSchema>;
export type CompanyProfileTranslationResponse = z.infer<typeof companyProfileTranslationResponseSchema>;
