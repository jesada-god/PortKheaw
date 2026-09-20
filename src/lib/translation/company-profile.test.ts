import { describe, expect, it, vi } from 'vitest';
import { SharedRequestCache } from '@/src/lib/shared-request-cache';
import {
  CompanyProfileTranslationError,
  CompanyProfileTranslationService,
  maxOutputTokensForSource,
  sanitizeTranslation,
  translateWithGemini,
  validateTranslationOutput,
} from './company-profile';
import type {
  ProfileTranslationRecord,
  ProfileTranslationRepository,
} from './translation-repository';

vi.mock('server-only', () => ({}));

/**
 * The request as it now travels: a symbol and a language, and no prose.
 *
 * The paragraph lives on the server side of the seam, in `SOURCE_TEXT`, which
 * is exactly the separation the endpoint change is about.
 */
const input = {
  symbol: 'RKLB',
  targetLanguage: 'th' as const,
};

const SOURCE_TEXT = 'Rocket Lab provides launch services.';

/** The seam the service reads its text through, defaulting to a real answer. */
function sourceReader(text: string | null = SOURCE_TEXT) {
  return vi.fn(async () => text);
}

/**
 * A `Map` standing in for `market_instrument_profile_translations`, shared
 * between service instances on purpose: the property worth testing is that two
 * instances make ONE model call between them, which a per-instance double
 * could never show.
 */
function sharedTranslationStore() {
  const rows = new Map<string, ProfileTranslationRecord>();
  return {
    rows,
    repository: {
      get: vi.fn(async (symbol: string, language: 'th') => rows.get(`${symbol}:${language}`) ?? null),
      upsert: vi.fn(async (record: ProfileTranslationRecord) => {
        rows.set(`${record.symbol}:${record.targetLanguage}`, record);
      }),
    } satisfies ProfileTranslationRepository,
  };
}

function geminiResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function translate(fetchImpl: typeof fetch) {
  return translateWithGemini({
    apiKey: 'test-key',
    model: 'configured-model',
    // A JOB, not a request: the model is handed the text the server resolved,
    // which is a different type from what a caller may ask for.
    input: { symbol: input.symbol, sourceText: SOURCE_TEXT },
    fetchImpl,
  });
}

describe('Company Profile translation', () => {
  it('sanitizes markup and control bytes from provider output', () => {
    expect(sanitizeTranslation('```text\n<b>บริการ\u0000อวกาศ</b>\n```')).toBe('บริการอวกาศ');
  });

  it('returns a successful Thai translation from all text parts', async () => {
    const fetchImpl = vi.fn(async (
      _request: string | URL | Request,
      _init?: RequestInit,
    ) => geminiResponse({
      candidates: [{
        content: {
          parts: [
            { text: 'Rocket Lab ให้บริการด้าน' },
            { text: 'การปล่อยจรวด' },
          ],
        },
      }],
    }));

    await expect(translate(fetchImpl)).resolves.toBe(
      'Rocket Lab ให้บริการด้านการปล่อยจรวด',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toContain('/configured-model:generateContent');
    const requestBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(requestBody.generationConfig).toEqual({
      temperature: 0,
      maxOutputTokens: maxOutputTokensForSource(SOURCE_TEXT),
    });
    expect(requestBody.systemInstruction.parts[0].text).toContain('Return only the Thai translation.');
  });

  it('maps a provider 404 to model-unavailable', async () => {
    const promise = translate(vi.fn(async () => geminiResponse({}, 404)));

    await expect(promise).rejects.toMatchObject({
      code: 'model-unavailable',
      retryable: false,
      status: 503,
    });
  });

  it('rejects empty candidates safely', async () => {
    await expect(translate(vi.fn(async () => geminiResponse({
      candidates: [],
    })))).rejects.toMatchObject({
      code: 'invalid-provider-response',
    });
  });

  it('removes Markdown code fences from an otherwise valid translation', async () => {
    await expect(translate(vi.fn(async () => geminiResponse({
      candidates: [{
        content: {
          parts: [{ text: '```text\nRocket Lab ให้บริการปล่อยจรวด\n```' }],
        },
      }],
    })))).resolves.toBe('Rocket Lab ให้บริการปล่อยจรวด');
  });

  it('rejects explanatory text instead of accepting it as a translation', () => {
    expect(() => validateTranslationOutput(
      'หมายเหตุ: คำแปลที่เหมาะสมคือ Rocket Lab ให้บริการปล่อยจรวด',
    )).toThrow(CompanyProfileTranslationError);
  });

  it('caches by symbol, target language, and source hash', async () => {
    const operation = vi.fn(async () => 'Rocket Lab ให้บริการด้านการปล่อยจรวด');
    const service = new CompanyProfileTranslationService(operation, new SharedRequestCache(), sourceReader());
    const first = await service.translate(input);
    const second = await service.translate(input);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(first.data.sourceText).toBe(SOURCE_TEXT);
    expect(first.data.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not fabricate a translation when the provider fails', async () => {
    const service = new CompanyProfileTranslationService(
      vi.fn(async () => {
        throw new Error('provider failed');
      }),
      new SharedRequestCache(),
      sourceReader(),
    );
    await expect(service.translate(input)).rejects.toThrow('provider failed');
  });

  it('does not cache failures and retries only on the next explicit call', async () => {
    const operation = vi.fn()
      .mockRejectedValueOnce(new Error('provider failed'))
      .mockResolvedValueOnce('Rocket Lab ให้บริการปล่อยจรวด');
    const service = new CompanyProfileTranslationService(
      operation,
      new SharedRequestCache(),
      sourceReader(),
    );

    await expect(service.translate(input)).rejects.toThrow('provider failed');
    expect(operation).toHaveBeenCalledTimes(1);
    await expect(service.translate(input)).resolves.toMatchObject({
      data: { translatedText: 'Rocket Lab ให้บริการปล่อยจรวด' },
      cached: false,
    });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not call Gemini when the company has no description to translate', async () => {
    const operation = vi.fn(async () => 'unexpected');
    const service = new CompanyProfileTranslationService(
      operation,
      new SharedRequestCache(),
      sourceReader('   '),
    );

    await expect(service.translate(input)).rejects.toBeDefined();
    expect(operation).not.toHaveBeenCalled();
  });

  it('refuses a request that still carries its own source text', async () => {
    const operation = vi.fn(async () => 'unexpected');
    const service = new CompanyProfileTranslationService(
      operation,
      new SharedRequestCache(),
      sourceReader(),
    );

    /*
     * The whole cost argument rests on the server choosing the text. A caller
     * that supplies prose is rejected at the schema rather than having the
     * field quietly ignored, so a client left on the old contract fails loudly
     * instead of silently believing it controls the translation.
     */
    await expect(service.translate({
      symbol: 'RKLB',
      targetLanguage: 'th',
      sourceText: 'attacker supplied paragraph',
    })).rejects.toBeDefined();
    expect(operation).not.toHaveBeenCalled();
  });
});

describe('Company Profile translation shared cache', () => {
  it('calls the model once for two instances translating the same company', async () => {
    const store = sharedTranslationStore();
    const operation = vi.fn(async () => 'Rocket Lab ให้บริการปล่อยจรวด');

    const instanceA = new CompanyProfileTranslationService(operation, new SharedRequestCache(), sourceReader(), store.repository, 'test-model');
    const instanceB = new CompanyProfileTranslationService(operation, new SharedRequestCache(), sourceReader(), store.repository, 'test-model');

    const fromA = await instanceA.translate(input);
    const fromB = await instanceB.translate(input);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(fromA.data.translatedText).toBe('Rocket Lab ให้บริการปล่อยจรวด');
    expect(fromB.data.translatedText).toBe('Rocket Lab ให้บริการปล่อยจรวด');
    expect(fromB.cached).toBe(true);
  });

  it('re-translates only when the description itself changed', async () => {
    const store = sharedTranslationStore();
    const operation = vi.fn()
      .mockResolvedValueOnce('คำแปลเดิม ให้บริการปล่อยจรวด')
      .mockResolvedValueOnce('คำแปลใหม่ ให้บริการดาวเทียม');

    const first = new CompanyProfileTranslationService(operation, new SharedRequestCache(), sourceReader(), store.repository, 'test-model');
    await first.translate(input);
    expect(operation).toHaveBeenCalledTimes(1);

    // Same description, a fresh instance: the stored hash still matches.
    const unchanged = new CompanyProfileTranslationService(operation, new SharedRequestCache(), sourceReader(), store.repository, 'test-model');
    await unchanged.translate(input);
    expect(operation).toHaveBeenCalledTimes(1);

    // The company rewrote its description. The stored hash no longer matches
    // and the row is replaced rather than served.
    const changed = new CompanyProfileTranslationService(
      operation,
      new SharedRequestCache(),
      sourceReader('Rocket Lab now builds satellites.'),
      store.repository,
      'test-model',
    );
    const retranslated = await changed.translate(input);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(retranslated.data.translatedText).toBe('คำแปลใหม่ ให้บริการดาวเทียม');
    expect(store.rows.size).toBe(1);
  });

  it('still translates when the shared store is unreachable', async () => {
    const store = sharedTranslationStore();
    store.repository.get.mockRejectedValue(new Error('Profile translation read failed: 42P01'));
    store.repository.upsert.mockRejectedValue(new Error('Profile translation write failed: 42501'));
    const operation = vi.fn(async () => 'Rocket Lab ให้บริการปล่อยจรวด');
    const service = new CompanyProfileTranslationService(operation, new SharedRequestCache(), sourceReader(), store.repository, 'test-model');

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(service.translate(input)).resolves.toMatchObject({
      data: { translatedText: 'Rocket Lab ให้บริการปล่อยจรวด' },
    });
    vi.restoreAllMocks();
  });
});
