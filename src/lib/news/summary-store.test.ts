import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { InMemoryNewsCache } from './cache-double';
import type { NewsSummary } from './summary-types';
import type { NewsArticle } from './types';
import {
  NEWS_SUMMARY_LOCK_TTL_SECONDS,
  newsSummaryFingerprint,
  newsSummaryKey,
  newsSummaryLockKey,
  resolveNewsSummary,
} from './summary-store';

const START = Date.parse('2026-08-23T09:00:00.000Z');

function article(index: number, publishedAt = `2026-08-23T0${index}:00:00.000Z`): NewsArticle {
  return {
    id: `article-${index}`,
    title: `Headline ${index}`,
    source: 'Example Wire',
    publishedAt,
    url: `https://example.com/story-${index}`,
    imageUrl: null,
    summary: `Body ${index}`,
    symbols: ['AAPL'],
  };
}

const FEED = [article(1), article(2), article(3), article(4)];
const MOVED_FEED = [article(9, '2026-08-23T09:30:00.000Z'), article(1), article(2), article(3)];

function summaryFor(label: string, articles: readonly NewsArticle[]): NewsSummary {
  return {
    overview: `ภาพรวม ${label}`,
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

describe('resolveNewsSummary', () => {
  it('generates once for a set of articles and serves the stored copy after that', async () => {
    const cache = new InMemoryNewsCache(() => START);
    const generate = vi.fn(async () => summaryFor('first', FEED));

    const first = await resolveNewsSummary({ symbol: 'AAPL', articles: FEED, cache, generate });
    const second = await resolveNewsSummary({ symbol: 'AAPL', articles: FEED, cache, generate });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ summary: summaryFor('first', FEED), stale: false });
    expect(second).toEqual({ summary: summaryFor('first', FEED), stale: false });
  });

  it('never regenerates on age alone — the same headlines days later still cost nothing', async () => {
    let clock = START;
    const cache = new InMemoryNewsCache(() => clock);
    const generate = vi.fn(async () => summaryFor('first', FEED));

    await resolveNewsSummary({ symbol: 'AAPL', articles: FEED, cache, generate });

    // Well past the 90s cooldown and past any plausible "feels stale" window,
    // but still inside the 7-day janitorial TTL.
    clock = START + 3 * 24 * 60 * 60_000;
    const later = await resolveNewsSummary({ symbol: 'AAPL', articles: FEED, cache, generate });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(later).toEqual({ summary: summaryFor('first', FEED), stale: false });
    // The lock expired long ago; the summary is what kept the model out of it.
    expect(cache.has(newsSummaryLockKey('AAPL'))).toBe(false);
  });

  it('regenerates when a new article reaches the top of the feed', async () => {
    let clock = START;
    const cache = new InMemoryNewsCache(() => clock);
    const generate = vi.fn(async (articles: readonly NewsArticle[]) =>
      summaryFor(articles === FEED ? 'first' : 'second', articles));

    await resolveNewsSummary({ symbol: 'AAPL', articles: FEED, cache, generate });

    // Past the cooldown, so the lock is not what admits the second call.
    clock = START + (NEWS_SUMMARY_LOCK_TTL_SECONDS + 1) * 1000;
    const moved = await resolveNewsSummary({ symbol: 'AAPL', articles: MOVED_FEED, cache, generate });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(moved).toEqual({ summary: summaryFor('second', MOVED_FEED), stale: false });
    expect(newsSummaryFingerprint(MOVED_FEED)).not.toBe(newsSummaryFingerprint(FEED));
  });

  it('lets exactly one of twenty simultaneous readers regenerate and serves the rest the stored copy', async () => {
    let clock = START;
    const cache = new InMemoryNewsCache(() => clock);
    let release!: () => void;
    const started = new Promise<void>((resolve) => { release = resolve; });
    const generate = vi.fn(async (articles: readonly NewsArticle[]) => {
      if (articles === MOVED_FEED) await started;
      return summaryFor(articles === FEED ? 'first' : 'second', articles);
    });

    await resolveNewsSummary({ symbol: 'AAPL', articles: FEED, cache, generate });
    clock = START + (NEWS_SUMMARY_LOCK_TTL_SECONDS + 1) * 1000;
    generate.mockClear();

    const inflight = Array.from({ length: 20 }, () =>
      resolveNewsSummary({ symbol: 'AAPL', articles: MOVED_FEED, cache, generate }));
    release();
    const results = await Promise.all(inflight);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result?.stale === false)).toHaveLength(1);
    expect(results.filter((result) => result?.stale === true)).toHaveLength(19);
    for (const result of results.filter((entry) => entry?.stale)) {
      expect(result?.summary).toEqual(summaryFor('first', FEED));
    }
  });

  it('returns nothing rather than waiting when the first summary of a symbol is still being written', async () => {
    const cache = new InMemoryNewsCache(() => START);
    let release!: () => void;
    const started = new Promise<void>((resolve) => { release = resolve; });
    const generate = vi.fn(async () => { await started; return summaryFor('first', FEED); });

    const winner = resolveNewsSummary({ symbol: 'AAPL', articles: FEED, cache, generate });
    const loser = await resolveNewsSummary({ symbol: 'AAPL', articles: FEED, cache, generate });
    release();

    expect(loser).toBeNull();
    expect(await winner).toEqual({ summary: summaryFor('first', FEED), stale: false });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('keeps the lock as a cooldown after a success and drops it after a provider failure', async () => {
    const cache = new InMemoryNewsCache(() => START);
    await resolveNewsSummary({
      symbol: 'AAPL',
      articles: FEED,
      cache,
      generate: async () => summaryFor('first', FEED),
    });
    expect(cache.has(newsSummaryLockKey('AAPL'))).toBe(true);

    const failing = new InMemoryNewsCache(() => START);
    const failed = await resolveNewsSummary({
      symbol: 'AAPL',
      articles: FEED,
      cache: failing,
      generate: async () => { throw new Error('gemini down'); },
    });
    expect(failed).toBeNull();
    expect(failing.has(newsSummaryLockKey('AAPL'))).toBe(false);
  });

  it('keeps the previous summary when the model answer fails validation', async () => {
    let clock = START;
    const cache = new InMemoryNewsCache(() => clock);
    await resolveNewsSummary({
      symbol: 'AAPL',
      articles: FEED,
      cache,
      generate: async () => summaryFor('first', FEED),
    });

    clock = START + (NEWS_SUMMARY_LOCK_TTL_SECONDS + 1) * 1000;
    const rejected = await resolveNewsSummary({
      symbol: 'AAPL',
      articles: MOVED_FEED,
      cache,
      generate: async () => null,
    });

    expect(rejected).toEqual({ summary: summaryFor('first', FEED), stale: true });
    // Not deleted, and the cooldown is holding so the same rejected answer is
    // not paid for again on the next request.
    expect(await cache.get(newsSummaryKey('AAPL'))).not.toBeNull();
    expect(cache.has(newsSummaryLockKey('AAPL'))).toBe(true);
  });

  it('keys on the symbol alone, so two readers of one symbol share one entry', () => {
    expect(newsSummaryKey('aapl')).toBe('news:summary:AAPL');
    expect(newsSummaryLockKey('aapl')).toBe('news:lock:AAPL');
  });

  it('fingerprints the top three links and publication times only', () => {
    const deeperChange = [FEED[0], FEED[1], FEED[2], article(8, '2026-08-23T08:00:00.000Z')];
    expect(newsSummaryFingerprint(deeperChange)).toBe(newsSummaryFingerprint(FEED));

    const corrected = [article(1, '2026-08-23T01:05:00.000Z'), FEED[1], FEED[2], FEED[3]];
    expect(newsSummaryFingerprint(corrected)).not.toBe(newsSummaryFingerprint(FEED));
  });
});
