import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { InMemoryNewsCache } from './cache-double';
import type { NewsSummary } from './summary-types';
import type { NewsArticle } from './types';
import {
  MARKET_NEWS_SUMMARY_SCOPE,
  NEWS_SUMMARY_LOCK_TTL_SECONDS,
  newsSummaryFingerprint,
  resolveNewsSummary,
  symbolNewsSummaryScope,
} from './summary-store';

/**
 * The dashboard's market summary is the symbol summary's cache behaviour under
 * one deployment-wide key. What is worth pinning here is what the missing symbol
 * changes: everyone shares the one entry, it cannot collide with a symbol's, and
 * "the market feed moved" still means the top three stories and nothing else.
 */

const START = Date.parse('2026-08-23T09:00:00.000Z');

function article(index: number, publishedAt = `2026-08-23T0${index}:00:00.000Z`): NewsArticle {
  return {
    id: `market-${index}`,
    title: `Fed holds rates ${index}`,
    source: 'Example Wire',
    publishedAt,
    url: `https://example.com/market-${index}`,
    imageUrl: null,
    summary: `Body ${index}`,
    symbols: [],
  };
}

const FEED = [article(1), article(2), article(3), article(4)];
const MOVED_FEED = [article(9, '2026-08-23T09:30:00.000Z'), article(1), article(2), article(3)];

function summaryFor(label: string, articles: readonly NewsArticle[]): NewsSummary {
  return {
    overview: `ภาพรวมตลาด ${label}`,
    points: articles.slice(0, 3).map((item, index) => ({ text: `ประเด็น ${item.id}`, sourceIndex: index })),
    sources: articles.slice(0, 3).map((item) => ({
      title: item.title,
      source: item.source,
      url: item.url,
      publishedAt: item.publishedAt,
    })),
    generatedAt: '2026-08-23T09:00:00.000Z',
  };
}

function resolveMarket(
  articles: readonly NewsArticle[],
  cache: InMemoryNewsCache,
  generate: (articles: readonly NewsArticle[]) => Promise<NewsSummary | null>,
) {
  return resolveNewsSummary({ scope: MARKET_NEWS_SUMMARY_SCOPE, articles, cache, generate });
}

describe('the market news summary scope', () => {
  it('is one key for the whole deployment, with no symbol in it', () => {
    expect(MARKET_NEWS_SUMMARY_SCOPE).toEqual({
      key: 'news:summary:market',
      lockKey: 'news:lock:market',
    });
  });

  it('cannot collide with any symbol, including one spelled MARKET', () => {
    expect(symbolNewsSummaryScope('market').key).toBe('news:summary:MARKET');
    expect(MARKET_NEWS_SUMMARY_SCOPE.key).not.toBe(symbolNewsSummaryScope('market').key);
    expect(MARKET_NEWS_SUMMARY_SCOPE.lockKey).not.toBe(symbolNewsSummaryScope('market').lockKey);
  });
});

describe('resolveNewsSummary for the market feed', () => {
  it('generates once and serves every later reader the stored copy', async () => {
    const cache = new InMemoryNewsCache(() => START);
    const generate = vi.fn(async () => summaryFor('first', FEED));

    const first = await resolveMarket(FEED, cache, generate);
    const second = await resolveMarket(FEED, cache, generate);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ summary: summaryFor('first', FEED), stale: false });
    expect(second).toEqual({ summary: summaryFor('first', FEED), stale: false });
    expect(cache.has(MARKET_NEWS_SUMMARY_SCOPE.key)).toBe(true);
  });

  it('shares that one entry with a reader who never visited a symbol page', async () => {
    const cache = new InMemoryNewsCache(() => START);
    const generate = vi.fn(async () => summaryFor('first', FEED));

    await resolveMarket(FEED, cache, generate);
    // A second reader, arriving from anywhere: same key, so no second call.
    await resolveMarket(FEED, cache, generate);
    // A symbol summary generated in between writes its own key and leaves the
    // market entry alone — the two features never overwrite each other.
    await resolveNewsSummary({
      symbol: 'AAPL',
      articles: FEED,
      cache,
      generate: async () => summaryFor('symbol', FEED),
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(await resolveMarket(FEED, cache, generate))
      .toEqual({ summary: summaryFor('first', FEED), stale: false });
  });

  it('never regenerates on age alone — the same headlines days later still cost nothing', async () => {
    let clock = START;
    const cache = new InMemoryNewsCache(() => clock);
    const generate = vi.fn(async () => summaryFor('first', FEED));

    await resolveMarket(FEED, cache, generate);
    clock = START + 3 * 24 * 60 * 60_000;
    const later = await resolveMarket(FEED, cache, generate);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(later).toEqual({ summary: summaryFor('first', FEED), stale: false });
    expect(cache.has(MARKET_NEWS_SUMMARY_SCOPE.lockKey)).toBe(false);
  });

  it('regenerates when a new story reaches the top of the market feed', async () => {
    let clock = START;
    const cache = new InMemoryNewsCache(() => clock);
    const generate = vi.fn(async (articles: readonly NewsArticle[]) =>
      summaryFor(articles === FEED ? 'first' : 'second', articles));

    await resolveMarket(FEED, cache, generate);
    clock = START + (NEWS_SUMMARY_LOCK_TTL_SECONDS + 1) * 1000;
    const moved = await resolveMarket(MOVED_FEED, cache, generate);

    expect(generate).toHaveBeenCalledTimes(2);
    expect(moved).toEqual({ summary: summaryFor('second', MOVED_FEED), stale: false });
  });

  it('fingerprints the top three stories of the market feed only', () => {
    const deeperChange = [FEED[0], FEED[1], FEED[2], article(8, '2026-08-23T08:00:00.000Z')];
    expect(newsSummaryFingerprint(deeperChange)).toBe(newsSummaryFingerprint(FEED));
    expect(newsSummaryFingerprint(MOVED_FEED)).not.toBe(newsSummaryFingerprint(FEED));
  });

  it('lets exactly one of twenty simultaneous dashboard readers regenerate', async () => {
    let clock = START;
    const cache = new InMemoryNewsCache(() => clock);
    let release!: () => void;
    const started = new Promise<void>((resolve) => { release = resolve; });
    const generate = vi.fn(async (articles: readonly NewsArticle[]) => {
      if (articles === MOVED_FEED) await started;
      return summaryFor(articles === FEED ? 'first' : 'second', articles);
    });

    await resolveMarket(FEED, cache, generate);
    clock = START + (NEWS_SUMMARY_LOCK_TTL_SECONDS + 1) * 1000;
    generate.mockClear();

    const inflight = Array.from({ length: 20 }, () => resolveMarket(MOVED_FEED, cache, generate));
    release();
    const results = await Promise.all(inflight);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result?.stale === false)).toHaveLength(1);
    expect(results.filter((result) => result?.stale === true)).toHaveLength(19);
  });

  it('shows no card at all while the very first market summary is being written', async () => {
    const cache = new InMemoryNewsCache(() => START);
    let release!: () => void;
    const started = new Promise<void>((resolve) => { release = resolve; });
    const generate = vi.fn(async () => { await started; return summaryFor('first', FEED); });

    const winner = resolveMarket(FEED, cache, generate);
    const loser = await resolveMarket(FEED, cache, generate);
    release();

    expect(loser).toBeNull();
    expect(await winner).toEqual({ summary: summaryFor('first', FEED), stale: false });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous market summary when the model answer fails validation', async () => {
    let clock = START;
    const cache = new InMemoryNewsCache(() => clock);
    await resolveMarket(FEED, cache, async () => summaryFor('first', FEED));

    clock = START + (NEWS_SUMMARY_LOCK_TTL_SECONDS + 1) * 1000;
    const rejected = await resolveMarket(MOVED_FEED, cache, async () => null);

    expect(rejected).toEqual({ summary: summaryFor('first', FEED), stale: true });
    expect(cache.has(MARKET_NEWS_SUMMARY_SCOPE.lockKey)).toBe(true);
  });

  it('drops the lock after a provider failure so an outage is not also a cooldown', async () => {
    const cache = new InMemoryNewsCache(() => START);
    const failed = await resolveMarket(FEED, cache, async () => { throw new Error('gemini down'); });

    expect(failed).toBeNull();
    expect(cache.has(MARKET_NEWS_SUMMARY_SCOPE.lockKey)).toBe(false);
  });

  it('does not summarise a market feed too short to carry three single-source bullets', async () => {
    const cache = new InMemoryNewsCache(() => START);
    const generate = vi.fn(async () => summaryFor('first', FEED));

    expect(await resolveMarket(FEED.slice(0, 2), cache, generate)).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });
});
