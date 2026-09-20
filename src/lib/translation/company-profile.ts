import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { serverEnv } from '@/src/config/env/server';
import { SharedRequestCache } from '@/src/lib/shared-request-cache';
import { recordProviderCall } from '@/src/lib/monitoring/provider-call-meter';
import {
  createProfileTranslationRepository,
  type ProfileTranslationRecord,
  type ProfileTranslationRepository,
} from './translation-repository';
import {
  companyProfileTranslationDataSchema,
  companyProfileTranslationRequestSchema,
  type CompanyProfileTranslationRequest,
} from '@/src/lib/stock-detail/api-schemas';

const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_TIMEOUT_MS = 12_000;
const cache = new SharedRequestCache();

const geminiResponseSchema = z.object({
  candidates: z.array(z.object({
    content: z.object({
      parts: z.array(z.object({ text: z.string().optional() }).passthrough()).optional(),
    }).passthrough().optional(),
  }).passthrough()).optional(),
}).passthrough();

const TRANSLATION_INSTRUCTIONS = [
  'Translate the supplied Company Profile from English into Thai.',
  'Return only the Thai translation.',
  'Use clear, fluent, natural language that general readers can understand.',
  'Avoid difficult technical terms. When a technical term is necessary, use a simple Thai equivalent or explain it briefly within the sentence.',
  'Preserve the complete original meaning. Do not summarize, omit information, or add new information.',
  'Keep the company name, Symbol, product names, service names, and other proper names exactly as written in the source.',
  'Do not use Markdown.',
  'Do not include headings, introductions, notes, explanations, or multiple translation options.',
  'Do not begin with phrases such as "คำแปลคือ", "สามารถแปลได้ดังนี้", "The translation is", "Here is the translation", or anything similar.',
].join('\n');

const EXPLANATION_PREFIX = /^(?:คำแปล(?:ภาษาไทย)?(?:คือ|:|：)|สามารถแปล(?:ได้)?(?:ว่า|ดังนี้)|แปล(?:ได้)?ดังนี้|นี่คือคำแปล|ต่อไปนี้(?:คือ|เป็น)คำแปล|หมายเหตุ\s*[:：]|คำอธิบาย\s*[:：]|the translation(?: is|:)|translation:|here(?:'s| is) the translation|note\s*:|explanation\s*:|sure(?:[,!:]|\s+-))/i;
const MULTIPLE_OPTIONS = /(?:^|\n)\s*(?:ตัวเลือก(?:ที่)?|คำแปล(?:แบบ)?ที่|option)\s*[1-9]\b/giu;

type GeminiFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface GeminiTranslationOptions {
  apiKey: string;
  model: string;
  input: CompanyProfileTranslationJob;
  fetchImpl?: GeminiFetch;
}

export type TranslationErrorCode =
  | 'invalid-request'
  | 'provider-not-configured'
  | 'model-unavailable'
  | 'rate-limited'
  | 'upstream-unavailable'
  | 'invalid-provider-response';

export class CompanyProfileTranslationError extends Error {
  readonly retryable: boolean;
  readonly status: number;

  constructor(
    readonly code: TranslationErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'CompanyProfileTranslationError';
    this.retryable = code === 'rate-limited' || code === 'upstream-unavailable';
    this.status = code === 'invalid-request'
      ? 400
      : code === 'rate-limited'
        ? 429
        : code === 'provider-not-configured' || code === 'model-unavailable'
          ? 503
          : 502;
  }
}

/**
 * What is actually sent to the model: a symbol for context and the paragraph to
 * translate.
 *
 * Separate from `CompanyProfileTranslationRequest` because the two are no
 * longer the same thing. The REQUEST names a company; the JOB carries text the
 * server read for itself. Collapsing them back into one type is what would let
 * caller-supplied prose reach the model again.
 */
export interface CompanyProfileTranslationJob {
  symbol: string;
  sourceText: string;
}

type TranslationOperation = (job: CompanyProfileTranslationJob) => Promise<string>;

/**
 * Where the text to translate comes from.
 *
 * A seam rather than a direct import so the service stays testable without a
 * provider or a database, and so the dependency runs one way: translation knows
 * it needs a description for a symbol, and nothing about how profiles are
 * fetched, cached or fallen back.
 */
export type CompanyProfileSourceReader = (symbol: string) => Promise<string | null>;

function retryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1, Math.ceil((date - Date.now()) / 1000)) : undefined;
}

export function sanitizeTranslation(value: string): string {
  return value
    .replaceAll('\u0000', '')
    .trim()
    .replace(/^```(?:text|plaintext|markdown)?[ \t]*(?:\r?\n)?/i, '')
    .replace(/(?:\r?\n)?[ \t]*```$/i, '')
    .replaceAll('```', '')
    .replace(/<[^>]*>/g, '')
    .trim()
    .slice(0, 8_000);
}

export function maxOutputTokensForSource(sourceText: string): number {
  return Math.min(8_000, Math.max(256, Math.ceil(sourceText.length * 1.5)));
}

export function validateTranslationOutput(value: string): string {
  const text = sanitizeTranslation(value);
  if (!text) {
    throw new CompanyProfileTranslationError(
      'invalid-provider-response',
      'Translation provider returned an empty translation',
    );
  }

  const normalizedLead = text
    .slice(0, 160)
    .replace(/^[\s#>*_-]+/, '')
    .replaceAll('**', '')
    .trim();
  const optionMarkers = Array.from(text.matchAll(MULTIPLE_OPTIONS));
  const hasMarkdown = /(?:^|\n)\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+)|\*\*[^*\n]+\*\*|__[^_\n]+__/m.test(text);
  if (
    EXPLANATION_PREFIX.test(normalizedLead)
    || optionMarkers.length > 0
    || hasMarkdown
    || !/[\u0E00-\u0E7F]/u.test(text)
  ) {
    throw new CompanyProfileTranslationError(
      'invalid-provider-response',
      'Translation provider returned commentary instead of a Thai translation',
    );
  }
  return text;
}

export async function translateWithGemini({
  apiKey,
  model,
  input,
  fetchImpl = fetch,
}: GeminiTranslationOptions): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(`${GEMINI_API_BASE_URL}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: TRANSLATION_INSTRUCTIONS,
          }],
        },
        contents: [{
          role: 'user',
          parts: [{
            text: `Symbol: ${input.symbol}\nSource language: English\nTarget language: Thai\n\n<company_description>\n${input.sourceText}\n</company_description>`,
          }],
        }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: maxOutputTokensForSource(input.sourceText),
        },
      }),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch {
    throw new CompanyProfileTranslationError(
      'upstream-unavailable',
      'Translation provider is temporarily unavailable',
    );
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new CompanyProfileTranslationError(
        'model-unavailable',
        'Configured translation model is unavailable',
      );
    }
    if (response.status === 429) {
      throw new CompanyProfileTranslationError(
        'rate-limited',
        'Translation provider rate limit exceeded',
        retryAfterSeconds(response),
      );
    }
    throw new CompanyProfileTranslationError(
      'upstream-unavailable',
      'Translation provider rejected the request',
    );
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json') && !contentType.includes('+json')) {
    throw new CompanyProfileTranslationError(
      'invalid-provider-response',
      'Translation provider returned a non-JSON response',
    );
  }

  let parsed: z.infer<typeof geminiResponseSchema>;
  try {
    parsed = geminiResponseSchema.parse(await response.json());
  } catch {
    throw new CompanyProfileTranslationError(
      'invalid-provider-response',
      'Translation provider returned an invalid response',
    );
  }
  return validateTranslationOutput(
    parsed.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? '')
      .join('') ?? '',
  );
}

/**
 * The hash a stored translation is matched against.
 *
 * It is taken over the DESCRIPTION the server read, not over the whole profile.
 * Both are server-derived, so both satisfy the rule that nothing a caller sent
 * can influence the key — but the whole profile also carries market
 * capitalisation and employee counts, which move constantly and have nothing to
 * do with the paragraph. Hashing those would re-translate the entire market
 * every time a number ticked, which is the bill this cache exists to stop.
 */
export function translationSourceHash(sourceText: string): string {
  return createHash('sha256').update(sourceText, 'utf8').digest('hex');
}

export class CompanyProfileTranslationService {
  constructor(
    private readonly operation: TranslationOperation,
    private readonly requestCache = new SharedRequestCache(),
    /** Reads the paragraph to translate. Required — nothing else may supply it. */
    private readonly readSource: CompanyProfileSourceReader = async () => null,
    /** The shared store. `null` on a deployment with no service-role key. */
    private readonly repository: ProfileTranslationRepository | null = null,
    private readonly model = 'unknown',
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Translate a company's description into Thai, calling the model only when
   * nothing already holds the answer.
   *
   * ==========================================================================
   * THE ORDER, WHICH IS THE COST CONTROL
   * ==========================================================================
   *   1. Read the profile FOR the symbol. The text is never taken from the
   *      request — see `companyProfileTranslationRequestSchema` for why that
   *      one change is what makes every layer below it able to work.
   *   2. Hash what was read.
   *   3. Ask the shared store for a translation carrying that hash. A hit costs
   *      one indexed select and no model call, for every reader on every
   *      instance, for as long as the description does not change.
   *   4. Only then, the model — and the result is written back so the next
   *      reader anywhere gets step 3.
   *
   * The in-process cache wraps all of it as a short memo and a single-flight,
   * so a burst of readers opening the same page costs one store read between
   * them rather than one each.
   */
  async translate(rawInput: unknown) {
    const input = companyProfileTranslationRequestSchema.parse(rawInput);
    const key = `company-profile-translation:${input.symbol}:${input.targetLanguage}`;
    const result = await this.requestCache.resolve(
      key,
      () => this.resolveTranslation(input),
      {
        /*
         * Minutes, not a month. The month-long window here used to be the only
         * cache there was; now the shared table holds the answer durably and
         * this layer only has to collapse concurrent readers. Keeping it long
         * would pin a translation in one instance's memory long after the
         * description — and the stored translation — had been replaced.
         */
        freshMs: 5 * 60_000,
        staleMs: 15 * 60_000,
        errorMs: 0,
      },
    );
    return {
      data: result.value.data,
      cached: result.state !== 'fresh' || result.value.servedFromStore,
    };
  }

  private async resolveTranslation(input: CompanyProfileTranslationRequest) {
    const sourceText = (await this.readSource(input.symbol))?.trim() || null;
    if (!sourceText) {
      /*
       * No description to translate. This is a 400 rather than a model call
       * with an empty prompt: the reader's card shows the English profile (or
       * nothing, if there is no profile), which is the correct outcome and
       * costs nothing.
       */
      throw new CompanyProfileTranslationError(
        'invalid-request',
        'No company description is available to translate',
      );
    }
    const sourceHash = translationSourceHash(sourceText);

    const stored = await this.readStored(input.symbol, input.targetLanguage);
    // A stored row whose hash does not match describes a description that no
    // longer exists. It is a miss, not a hit — this is the line that makes
    // "profile changed, so re-translate" actually true.
    if (stored && stored.sourceHash === sourceHash) {
      recordProviderCall({
        provider: 'gemini',
        operation: 'company-profile-translation',
        source: 'db-snapshot',
        outcome: 'success',
      });
      return {
        servedFromStore: true,
        data: companyProfileTranslationDataSchema.parse({
          symbol: input.symbol,
          targetLanguage: input.targetLanguage,
          sourceText,
          sourceHash,
          translatedText: stored.translatedText,
        }),
      };
    }

    const startedAt = this.now();
    let translatedText: string;
    try {
      translatedText = validateTranslationOutput(
        await this.operation({ symbol: input.symbol, sourceText }),
      );
    } catch (cause) {
      recordProviderCall({
        provider: 'gemini',
        operation: 'company-profile-translation',
        source: 'provider',
        outcome: 'error',
        durationMs: this.now() - startedAt,
      });
      throw cause;
    }
    recordProviderCall({
      provider: 'gemini',
      operation: 'company-profile-translation',
      source: 'provider',
      outcome: 'success',
      durationMs: this.now() - startedAt,
    });

    await this.writeStored({
      symbol: input.symbol,
      targetLanguage: input.targetLanguage,
      sourceHash,
      translatedText,
      provider: 'gemini',
      model: this.model,
      fetchedAt: new Date(this.now()).toISOString(),
    });

    return {
      servedFromStore: false,
      data: companyProfileTranslationDataSchema.parse({
        symbol: input.symbol,
        targetLanguage: input.targetLanguage,
        sourceText,
        sourceHash,
        translatedText,
      }),
    };
  }

  /*
   * Both store calls fail open, for the same reason the profile snapshot's do:
   * a cache that can take the feature down is worse than no cache. A read
   * failure costs one model call; a write failure costs one model call per
   * reader until it is fixed, and is logged loudly enough to be noticed.
   */
  private async readStored(symbol: string, targetLanguage: 'th') {
    if (!this.repository) return null;
    try {
      return await this.repository.get(symbol, targetLanguage);
    } catch (cause) {
      console.warn(JSON.stringify({
        event: 'profile_translation_cache_read_failed',
        symbol,
        message: cause instanceof Error ? cause.message : 'unknown',
      }));
      return null;
    }
  }

  private async writeStored(record: ProfileTranslationRecord): Promise<void> {
    if (!this.repository) return;
    try {
      await this.repository.upsert(record);
    } catch (cause) {
      console.warn(JSON.stringify({
        event: 'profile_translation_cache_write_failed',
        symbol: record.symbol,
        message: cause instanceof Error ? cause.message : 'unknown',
      }));
    }
  }
}

let configuredService: CompanyProfileTranslationService | null = null;
let configuredIdentity: string | undefined;

export function getCompanyProfileTranslationService(): CompanyProfileTranslationService {
  const apiKey = serverEnv.GEMINI_API_KEY;
  const model = serverEnv.GEMINI_MODEL;
  if (!apiKey) {
    throw new CompanyProfileTranslationError(
      'provider-not-configured',
      'Company Profile translation is not configured',
    );
  }
  const identity = `${apiKey}:${model}`;
  if (!configuredService || configuredIdentity !== identity) {
    configuredIdentity = identity;
    configuredService = new CompanyProfileTranslationService(
      (job) => translateWithGemini({ apiKey, model, input: job }),
      cache,
      /*
       * The source of truth for what gets translated, imported lazily.
       *
       * Lazy because the profile service pulls in the provider chain and the
       * Supabase client, and this module is also loaded by code paths that
       * only need `validateTranslationOutput`. A top-level import would make
       * every one of them pay for the whole market-data graph.
       *
       * It goes through `getCompanyProfileService()` rather than the provider
       * directly, so a translation reads the SAME snapshot the profile card
       * does: the description being translated is the description on screen,
       * and a translation costs a database read rather than an FMP call.
       */
      async (symbol) => {
        const { getCompanyProfileService } = await import('@/src/lib/market-data');
        const profile = await getCompanyProfileService().getCompanyProfile(symbol);
        return profile.data.description;
      },
      createProfileTranslationRepository(),
      model,
    );
  }
  return configuredService;
}
