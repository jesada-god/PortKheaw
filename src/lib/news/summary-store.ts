import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { NewsCacheClient } from './cache-client';
import type { NewsArticle } from './types';
import { newsSummarySchema, type NewsSummary } from './summary-types';

/**
 * A ceiling on how long an unvisited feed's summary occupies Redis — NOT a
 * freshness rule. Nothing in this module compares a stored summary's age to
 * anything: a feed whose top three headlines have not moved in nine days
 * serves the summary it already has and calls no model. Staleness here has one
 * definition, the fingerprint, and time is not part of it.
 */
export const NEWS_SUMMARY_TTL_SECONDS = 7 * 24 * 60 * 60;
/**
 * The lock's lifetime, and with it the regeneration cooldown.
 *
 * It is never deleted on success (see `resolveNewsSummary`), so after one
 * generation the feed cannot start another for this long no matter how many
 * readers arrive — which is what stops a feed whose model output keeps failing
 * validation from calling Gemini once per request.
 */
export const NEWS_SUMMARY_LOCK_TTL_SECONDS = 90;
/** Headlines whose identity decides whether the news actually moved. */
export const NEWS_SUMMARY_FINGERPRINT_ARTICLES = 3;

const storedRecordSchema = z.object({
  fingerprint: z.string().min(1),
  summary: newsSummarySchema,
});

type StoredRecord = z.infer<typeof storedRecordSchema>;

export function newsSummaryKey(symbol: string): string {
  return `news:summary:${symbol.toUpperCase()}`;
}

export function newsSummaryLockKey(symbol: string): string {
  return `news:lock:${symbol.toUpperCase()}`;
}

/**
 * The pair of Redis keys one shared summary lives under.
 *
 * A scope is what this module actually keys on — the symbol is only the most
 * common way to name one. The dashboard's market feed has no symbol at all and
 * still wants the identical "generate once, serve everyone, lock as cooldown"
 * behaviour, so the store takes the keys and stays out of the question of where
 * they came from.
 */
export interface NewsSummaryScope {
  /** Holds the `{ fingerprint, summary }` record. */
  key: string;
  /** Holds the regeneration lock, and with it the cooldown. */
  lockKey: string;
}

export function symbolNewsSummaryScope(symbol: string): NewsSummaryScope {
  return { key: newsSummaryKey(symbol), lockKey: newsSummaryLockKey(symbol) };
}

/**
 * One entry for the whole deployment.
 *
 * There is no symbol in either key because there is no symbol in the feed: the
 * dashboard's market-wide block is the same articles for every reader, so every
 * reader of every account shares this single summary and the first one after the
 * headlines move pays for it.
 */
export const MARKET_NEWS_SUMMARY_SCOPE: NewsSummaryScope = {
  key: 'news:summary:market',
  lockKey: 'news:lock:market',
};

/**
 * Identity of "the news right now", from the top three articles' link and
 * publication time. A republished link and a corrected timestamp both change it;
 * a reordering further down the feed does not, which is the point — the summary
 * describes the top of the feed and should not be regenerated for churn below it.
 */
export function newsSummaryFingerprint(articles: readonly NewsArticle[]): string {
  return createHash('sha1')
    .update(
      articles
        .slice(0, NEWS_SUMMARY_FINGERPRINT_ARTICLES)
        .map((article) => `${article.url}@${article.publishedAt}`)
        .join('|'),
      'utf8',
    )
    .digest('hex');
}

export interface NewsSummaryResolution {
  summary: NewsSummary;
  /** The stored summary is being served while its replacement is generated. */
  stale: boolean;
}

interface NewsSummaryGeneration {
  articles: readonly NewsArticle[];
  cache: NewsCacheClient;
  /** Returns `null` when the model's answer could not be trusted; throws on provider failure. */
  generate: (articles: readonly NewsArticle[]) => Promise<NewsSummary | null>;
}

/**
 * Name the summary either by its symbol or by its keys, never by both — a caller
 * that supplied a `symbol` beside a `scope` would be saying two different things
 * about which entry to read.
 */
export type ResolveNewsSummaryOptions = NewsSummaryGeneration & (
  | { symbol: string; scope?: undefined }
  | { scope: NewsSummaryScope; symbol?: undefined }
);

function scopeOf(options: ResolveNewsSummaryOptions): NewsSummaryScope {
  if (options.scope) return options.scope;
  return symbolNewsSummaryScope(options.symbol);
}

async function readRecord(
  cache: NewsCacheClient,
  key: string,
): Promise<StoredRecord | null> {
  const raw = await cache.get<unknown>(key);
  if (raw === null || raw === undefined) return null;
  // A record written by an older shape of this feature is not an error; it is
  // simply not a summary, and regenerating costs one call instead of throwing.
  const parsed = storedRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * The scope's summary, shared by every reader of that scope.
 *
 * The key holds no user id and the value is the same bytes for everyone, so the
 * first reader after the news moves pays for the model call and every later
 * reader — signed in, signed out, on another continent — is served from Redis.
 *
 * Concurrency is settled by one `SET NX EX`, not by a queue: whoever takes the
 * lock regenerates, and the other nineteen simultaneous readers are handed the
 * previous summary immediately rather than waiting on a call they did not start.
 * A reader who arrives with no previous summary at all gets `null`, because the
 * honest answer while the first summary is still being written is "not yet".
 */
export async function resolveNewsSummary(
  options: ResolveNewsSummaryOptions,
): Promise<NewsSummaryResolution | null> {
  const { articles, cache, generate } = options;
  if (articles.length < NEWS_SUMMARY_FINGERPRINT_ARTICLES) return null;

  const { key, lockKey } = scopeOf(options);
  const fingerprint = newsSummaryFingerprint(articles);
  const stored = await readRecord(cache, key);
  if (stored?.fingerprint === fingerprint) {
    return { summary: stored.summary, stale: false };
  }

  const acquired = await cache.setIfAbsent(lockKey, fingerprint, NEWS_SUMMARY_LOCK_TTL_SECONDS);
  if (!acquired) {
    return stored ? { summary: stored.summary, stale: true } : null;
  }

  let generated: NewsSummary | null;
  try {
    generated = await generate(articles);
  } catch {
    /*
     * The provider failed, so the cooldown would be punishing a reader for an
     * outage: release the lock and let the next request try. The stored summary
     * is left exactly as it was — a failed call is not evidence that yesterday's
     * summary is wrong.
     */
    await cache.del(lockKey);
    return stored ? { summary: stored.summary, stale: true } : null;
  }

  if (!generated) {
    /*
     * The model answered and the answer did not survive validation. Unlike the
     * throw above this IS worth a cooldown: the same articles would produce the
     * same rejected answer, so the lock is left to expire and the previous
     * summary is kept rather than deleted.
     */
    return stored ? { summary: stored.summary, stale: true } : null;
  }

  await cache.set(key, { fingerprint, summary: generated } satisfies StoredRecord, NEWS_SUMMARY_TTL_SECONDS);
  // The lock is deliberately NOT deleted here. It is the cooldown.
  return { summary: generated, stale: false };
}
