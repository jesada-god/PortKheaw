import { describe, expect, it, vi } from 'vitest';
import { CompanyProfileTranslationClient } from './company-profile-translation-client';

function response(text: string) {
  return new Response(JSON.stringify({
    data: {
      symbol: 'RKLB',
      sourceText: 'Rocket Lab provides launch services.',
      translatedText: text,
      targetLanguage: 'th',
      sourceHash: 'a'.repeat(64),
    },
    meta: {
      cached: false,
      timestamp: '2026-07-20T00:00:00.000Z',
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(message = 'Translation failed') {
  return new Response(JSON.stringify({
    data: null,
    error: {
      code: 'upstream-unavailable',
      message,
      retryable: true,
    },
    meta: {
      cached: false,
      timestamp: '2026-07-20T00:00:00.000Z',
    },
  }), {
    status: 502,
    headers: { 'Content-Type': 'application/json' },
  });
}

const input = {
  symbol: 'RKLB',
  sourceText: 'Rocket Lab provides launch services.',
  targetLanguage: 'th' as const,
};

describe('Company Profile translation client', () => {
  it('times out and aborts a translation that never settles', async () => {
    let browserSignal!: AbortSignal;
    const fetcher = vi.fn((
      _url: string,
      init: { signal: AbortSignal },
    ) => {
      browserSignal = init.signal;
      return new Promise<Response>(() => undefined);
    });
    const client = new CompanyProfileTranslationClient(fetcher, 5);

    await expect(client.request(input, new AbortController().signal)).rejects.toThrow(
      'Translation request timed out',
    );
    expect(browserSignal.aborted).toBe(true);
  });

  it('reuses the same in-flight request across Strict Mode cleanup and setup', async () => {
    let resolve!: (value: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((done) => {
      resolve = done;
    }));
    const client = new CompanyProfileTranslationClient(fetcher);
    const firstController = new AbortController();
    const first = client.request(input, firstController.signal);
    firstController.abort();
    const second = client.request(input, new AbortController().signal);
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    resolve(response('Rocket Lab ให้บริการด้านการปล่อยจรวด'));
    await expect(second).resolves.toBe('Rocket Lab ให้บริการด้านการปล่อยจรวด');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('caches only a successful translation for the symbol, language, and source hash', async () => {
    const fetcher = vi.fn(async () => response('Rocket Lab ให้บริการปล่อยจรวด'));
    const client = new CompanyProfileTranslationClient(fetcher);

    await expect(client.request(input, new AbortController().signal)).resolves.toContain('Rocket Lab');
    await expect(client.request({ ...input }, new AbortController().signal)).resolves.toContain('Rocket Lab');

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not auto-retry a failure and sends one new request on manual retry', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(errorResponse())
      .mockResolvedValueOnce(response('Rocket Lab ให้บริการปล่อยจรวด'));
    const client = new CompanyProfileTranslationClient(fetcher);

    await expect(client.request(input, new AbortController().signal)).rejects.toThrow(
      'Translation failed',
    );
    expect(fetcher).toHaveBeenCalledTimes(1);

    await expect(client.request(input, new AbortController().signal)).resolves.toContain('Rocket Lab');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('sends only the symbol and language, never the paragraph', () => {
    const fetcher = vi.fn().mockResolvedValue(response('Rocket Lab ให้บริการปล่อยจรวด'));
    const client = new CompanyProfileTranslationClient(fetcher);

    void client.request(input, new AbortController().signal);

    /*
     * The cost fix, asserted at the wire rather than inferred from the type.
     * `sourceText` is still an input to this client — it keys the per-tab
     * cache — so a refactor could reintroduce it into the body without any
     * type error. This is the line that would catch that.
     */
    return vi.waitFor(() => {
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(fetcher.mock.calls[0][1].body))).toEqual({
        symbol: 'RKLB',
        targetLanguage: 'th',
      });
    });
  });

  it('rejects rather than throwing when a stale tab posts the retired contract', async () => {
    /*
     * A tab opened before this deploy still runs the old bundle, which sends
     * `sourceText`. The request schema is `.strict()`, so the server answers
     * 400 `invalid-request` — and the only thing that matters is what that
     * does to the reader.
     *
     * It has to arrive here as a normal rejected promise carrying the server's
     * message, because that is what `CompanyProfileCard` catches to set
     * `translationFailed`, which is what makes `resolvedDescription` fall back
     * to the English paragraph. Anything that escaped as an unhandled throw
     * would take the card — and with it the page — down over a paragraph.
     */
    const staleContractRefusal = new Response(JSON.stringify({
      data: null,
      error: {
        code: 'invalid-request',
        message: 'Invalid translation request',
        retryable: false,
      },
      meta: { cached: false, timestamp: '2026-07-20T00:00:00.000Z' },
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    const client = new CompanyProfileTranslationClient(vi.fn().mockResolvedValue(staleContractRefusal));

    await expect(client.request(input, new AbortController().signal)).rejects.toThrow(
      'Invalid translation request',
    );
  });
});
