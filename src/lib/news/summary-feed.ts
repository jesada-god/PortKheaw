import 'server-only';
import { z } from 'zod';
import type { NewsCacheClient } from './cache-client';
import { createGeminiNewsSummaryCall, summarizeNews } from './summarizer';
import { resolveNewsSummary, type NewsSummaryScope } from './summary-store';
import type { NewsSummaryPayload } from './summary-types';
import { newsArticleSchema, type NewsArticle } from './types';

/**
 * The two halves both summary routes are made of: get the articles cheaply, then
 * turn them into the shared summary — or into `null`, which is a normal answer.
 *
 * A symbol's tab and the dashboard's market block differ only in which feed they
 * load, which keys they cache under, and which house rules the model speaks
 * under. Everything else — the raw-feed window, the "no Redis, no key, no card"
 * rule, swallowing a Redis outage so the articles still ship — is one behaviour
 * and lives here so the two routes cannot drift apart.
 */

/**
 * The raw feed's own cache, separate from the summary's.
 *
 * Without it the summary would save Gemini tokens by spending NewsAPI quota
 * instead: every reader of a feed whose fingerprint already matches still has
 * to fetch the articles to compute that fingerprint. Ten minutes is under the
 * lock's practical regeneration cadence and well inside NewsAPI's free-tier
 * refresh, so a busy feed costs one provider call per ten minutes rather than
 * one per reader.
 */
export const NEWS_RAW_TTL_SECONDS = 600;

export function newsRawKey(symbol: string): string {
  return `news:raw:${symbol.toUpperCase()}`;
}

/** The dashboard's market-wide feed, which belongs to no symbol. */
export const NEWS_MARKET_RAW_KEY = 'news:raw:market';

const rawRecordSchema = z.object({
  articles: z.array(newsArticleSchema),
  asOf: z.iso.datetime(),
});

export type CachedNewsFeed = z.infer<typeof rawRecordSchema>;

export interface LoadNewsFeedOptions {
  key: string;
  cache: NewsCacheClient | null;
  /** Fetches and orders the feed. Called only on a miss. */
  load: () => Promise<CachedNewsFeed>;
}

/** The feed behind a summary, from Redis when it is warm and from the provider otherwise. */
export async function loadNewsFeedForSummary({
  key,
  cache,
  load,
}: LoadNewsFeedOptions): Promise<CachedNewsFeed> {
  if (cache) {
    const parsed = rawRecordSchema.safeParse(await cache.get<unknown>(key));
    if (parsed.success) return parsed.data;
  }
  const record = await load();
  if (cache) await cache.set(key, record, NEWS_RAW_TTL_SECONDS);
  return record;
}

export interface ResolveSummaryPayloadOptions {
  scope: NewsSummaryScope;
  articles: readonly NewsArticle[];
  cache: NewsCacheClient | null;
  geminiApiKey: string | undefined;
  systemInstruction: string;
  now: () => Date;
}

/**
 * The shared summary for these articles, or `null`.
 *
 * `null` is never an error the reader is told about: no Redis, no Gemini key,
 * too few articles, an answer that failed validation, and "another request is
 * generating the first one right now" all land here, and every one of them means
 * the same thing to the page — show the articles, show no card.
 */
export async function resolveNewsSummaryPayload({
  scope,
  articles,
  cache,
  geminiApiKey,
  systemInstruction,
  now,
}: ResolveSummaryPayloadOptions): Promise<NewsSummaryPayload | null> {
  if (!cache || !geminiApiKey) return null;

  const callModel = createGeminiNewsSummaryCall(geminiApiKey, { systemInstruction });
  try {
    const resolved = await resolveNewsSummary({
      scope,
      articles,
      cache,
      generate: (input) => summarizeNews({ articles: input, callModel, now }),
    });
    return resolved ? { summary: resolved.summary, stale: resolved.stale } : null;
  } catch {
    // Redis itself is down. The articles are already in hand and the card is an
    // addition to them, so the reader gets the page rather than an error.
    return null;
  }
}
