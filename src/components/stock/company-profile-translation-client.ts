'use client';

import {
  companyProfileTranslationResponseSchema,
  type CompanyProfileTranslationRequest,
} from '@/src/lib/stock-detail/api-schemas';

type TranslationFetcher = (
  url: string,
  init: {
    method: 'POST';
    headers: { Accept: string; 'Content-Type': string };
    body: string;
    signal: AbortSignal;
  },
) => Promise<Response>;

interface InflightEntry {
  controller: AbortController;
  promise: Promise<string>;
  consumers: Set<symbol>;
}

export const COMPANY_PROFILE_TRANSLATION_TIMEOUT_MS = 12_000;

/**
 * What the card hands this client: the request the server accepts, plus the
 * paragraph currently on screen.
 *
 * The extra field never leaves the browser — see `request` — it exists so the
 * per-tab cache is invalidated when the description the reader is looking at
 * changes.
 */
export interface CompanyProfileTranslationInput extends CompanyProfileTranslationRequest {
  sourceText: string;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class CompanyProfileTranslationClient {
  private readonly inflight = new Map<string, InflightEntry>();
  private readonly completed = new Map<string, string>();

  constructor(
    private readonly fetcher: TranslationFetcher,
    private readonly timeoutMs = COMPANY_PROFILE_TRANSLATION_TIMEOUT_MS,
  ) {}

  /**
   * `sourceText` is a LOCAL input and is deliberately not sent.
   *
   * It is still needed here — the on-screen paragraph is what this cache is
   * keyed by, so that a profile refreshing under the reader invalidates the
   * entry they are looking at. But the server reads the description for itself
   * now, because a body-supplied paragraph made the server's cache key
   * caller-controlled and therefore unbounded. Sending it would be ignored at
   * best: the request schema is `.strict()` and would reject the extra field.
   */
  async request(input: CompanyProfileTranslationInput, signal: AbortSignal): Promise<string> {
    const sourceHash = await sha256(input.sourceText);
    const key = `${input.symbol}:${input.targetLanguage}:${sourceHash}`;
    const payload: CompanyProfileTranslationRequest = {
      symbol: input.symbol,
      targetLanguage: input.targetLanguage,
    };
    if (signal.aborted) throw new DOMException('Request aborted', 'AbortError');

    const completed = this.completed.get(key);
    if (completed) return completed;

    let entry = this.inflight.get(key);
    if (!entry) {
      const controller = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const request = this.fetcher('/api/translate/company-profile', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          reject(new Error('Translation request timed out'));
        }, this.timeoutMs);
      });
      const promise = Promise.race([request, timeout]).then(async (response) => {
        const parsed = companyProfileTranslationResponseSchema.safeParse(await response.json());
        if (!parsed.success) throw new Error('Translation API returned an invalid response');
        if (!response.ok || !parsed.data.data) {
          throw new Error(parsed.data.error?.message ?? 'Translation is unavailable');
        }
        return parsed.data.data.translatedText;
      }).then((text) => {
        this.completed.set(key, text);
        return text;
      }).finally(() => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
        this.inflight.delete(key);
      });
      entry = { controller, promise, consumers: new Set() };
      this.inflight.set(key, entry);
    }

    const activeEntry = entry;
    const consumer = Symbol(key);
    activeEntry.consumers.add(consumer);
    return new Promise((resolve, reject) => {
      let settled = false;
      const release = () => {
        activeEntry.consumers.delete(consumer);
        queueMicrotask(() => {
          if (activeEntry.consumers.size === 0 && this.inflight.get(key) === activeEntry) {
            activeEntry.controller.abort();
          }
        });
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        release();
        reject(new DOMException('Request aborted', 'AbortError'));
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      void activeEntry.promise.then(
        (text) => {
          if (!settled) {
            settled = true;
            signal.removeEventListener('abort', abort);
            release();
            resolve(text);
          }
        },
        (error) => {
          if (!settled) {
            settled = true;
            signal.removeEventListener('abort', abort);
            release();
            reject(error);
          }
        },
      );
    });
  }
}

export const companyProfileTranslationClient = new CompanyProfileTranslationClient(
  (url, init) => fetch(url, init),
);
