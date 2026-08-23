import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { NewsArticle } from './types';
import {
  NEWS_SUMMARY_CONTENT_CHARS,
  NEWS_SUMMARY_RESPONSE_SCHEMA,
  buildNewsSummaryPrompt,
  dedupeArticlesForSummary,
  parseNewsSummaryResponse,
  summarizeNews,
} from './summarizer';

const GENERATED_AT = '2026-08-23T09:00:00.000Z';

function article(overrides: Partial<NewsArticle> & { id: string; title: string }): NewsArticle {
  return {
    source: 'Example Wire',
    publishedAt: '2026-08-23T08:00:00.000Z',
    url: `https://example.com/${overrides.id}`,
    imageUrl: null,
    summary: 'Body text',
    symbols: ['AAPL'],
    ...overrides,
  };
}

const FEED: NewsArticle[] = [
  article({ id: 'a', title: 'Acme beats on earnings' }),
  article({ id: 'b', title: 'Regulator opens inquiry into Acme' }),
  article({ id: 'c', title: 'Acme names a new chief financial officer' }),
];

function answer(points: Array<{ text: string; source_index: number }>) {
  return JSON.stringify({ overview: 'ตลาดโฟกัสผลประกอบการ', points });
}

describe('dedupeArticlesForSummary', () => {
  it('drops an aggregator repost whose headline only gained a trailing clause', () => {
    const kept = dedupeArticlesForSummary([
      article({ id: 'a', title: 'Acme beats on earnings' }),
      article({ id: 'a2', title: 'Acme beats on earnings, raises full-year outlook' }),
      article({ id: 'b', title: 'Regulator opens inquiry into Acme' }),
    ]);

    expect(kept.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('keeps two genuinely different stories about the same company', () => {
    expect(dedupeArticlesForSummary(FEED).map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('buildNewsSummaryPrompt', () => {
  it('numbers each block from zero and truncates the body', () => {
    const long = article({ id: 'a', title: 'Acme beats on earnings', summary: 'x'.repeat(4_000) });
    const prompt = buildNewsSummaryPrompt([long, FEED[1]]);

    expect(prompt).toContain('[0]\ntitle: Acme beats on earnings');
    expect(prompt).toContain('[1]\ntitle: Regulator opens inquiry into Acme');
    expect(prompt).toContain(`content: ${'x'.repeat(NEWS_SUMMARY_CONTENT_CHARS)}\n`);
    expect(prompt).not.toContain('x'.repeat(NEWS_SUMMARY_CONTENT_CHARS + 1));
  });
});

describe('the response schema handed to the API', () => {
  it('constrains the bullet count at the API, not only in the prompt', () => {
    expect(NEWS_SUMMARY_RESPONSE_SCHEMA.properties?.points.minItems).toBe('3');
    expect(NEWS_SUMMARY_RESPONSE_SCHEMA.properties?.points.maxItems).toBe('4');
    expect(NEWS_SUMMARY_RESPONSE_SCHEMA.properties?.points.items?.required)
      .toEqual(['text', 'source_index']);
  });
});

describe('parseNewsSummaryResponse', () => {
  it('renumbers sources in citation order so the card reads [1][2][3] downwards', () => {
    const summary = parseNewsSummaryResponse(answer([
      { text: 'ประเด็นสอง', source_index: 1 },
      { text: 'ประเด็นศูนย์', source_index: 0 },
      { text: 'ประเด็นสาม', source_index: 2 },
    ]), FEED, GENERATED_AT);

    expect(summary?.points.map((point) => point.sourceIndex)).toEqual([0, 1, 2]);
    expect(summary?.sources.map((source) => source.title)).toEqual([
      'Regulator opens inquiry into Acme',
      'Acme beats on earnings',
      'Acme names a new chief financial officer',
    ]);
  });

  it('drops a bullet that repeats a source and one that cites an article it was not given', () => {
    const summary = parseNewsSummaryResponse(answer([
      { text: 'ประเด็นหนึ่ง', source_index: 0 },
      { text: 'ประเด็นซ้ำ', source_index: 0 },
      { text: 'ประเด็นนอกช่วง', source_index: 7 },
      { text: 'ประเด็นสอง', source_index: 1 },
    ]), FEED, GENERATED_AT);

    expect(summary?.points.map((point) => point.text)).toEqual(['ประเด็นหนึ่ง', 'ประเด็นสอง']);
    expect(summary?.sources).toHaveLength(2);
  });

  it('throws the whole summary away when fewer than two bullets survive', () => {
    expect(parseNewsSummaryResponse(answer([
      { text: 'ประเด็นหนึ่ง', source_index: 0 },
      { text: 'ประเด็นซ้ำ', source_index: 0 },
      { text: 'ประเด็นนอกช่วง', source_index: 9 },
    ]), FEED, GENERATED_AT)).toBeNull();
  });

  it('returns nothing for an empty, non-JSON, or off-schema answer', () => {
    expect(parseNewsSummaryResponse(undefined, FEED, GENERATED_AT)).toBeNull();
    expect(parseNewsSummaryResponse('not json', FEED, GENERATED_AT)).toBeNull();
    expect(parseNewsSummaryResponse('{"overview":"x"}', FEED, GENERATED_AT)).toBeNull();
    expect(parseNewsSummaryResponse(
      JSON.stringify({ overview: '   ', points: [{ text: 'a', source_index: 0 }, { text: 'b', source_index: 1 }] }),
      FEED,
      GENERATED_AT,
    )).toBeNull();
  });
});

describe('summarizeNews', () => {
  const goodAnswer = answer([
    { text: 'ประเด็นหนึ่ง', source_index: 0 },
    { text: 'ประเด็นสอง', source_index: 1 },
    { text: 'ประเด็นสาม', source_index: 2 },
  ]);

  it('summarizes the deduplicated feed', async () => {
    const callModel = vi.fn(async () => goodAnswer);
    const summary = await summarizeNews({
      articles: FEED,
      callModel,
      now: () => new Date(GENERATED_AT),
    });

    expect(callModel).toHaveBeenCalledTimes(1);
    expect(summary?.points).toHaveLength(3);
    expect(summary?.generatedAt).toBe(GENERATED_AT);
  });

  it('retries once with a backoff on 429 and on 5xx', async () => {
    for (const status of [429, 503]) {
      const sleep = vi.fn(async () => {});
      const callModel = vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error('busy'), { status }))
        .mockResolvedValueOnce(goodAnswer);

      const summary = await summarizeNews({
        articles: FEED,
        callModel,
        now: () => new Date(GENERATED_AT),
        sleep,
      });

      expect(callModel).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledWith(500);
      expect(summary).not.toBeNull();
    }
  });

  it('does not retry a 4xx that will fail again, and lets it reach the caller', async () => {
    const callModel = vi.fn().mockRejectedValue(Object.assign(new Error('bad key'), { status: 401 }));

    await expect(summarizeNews({ articles: FEED, callModel })).rejects.toThrow('bad key');
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it('does not call the model at all when the feed cannot support three single-source bullets', async () => {
    const callModel = vi.fn(async () => goodAnswer);

    expect(await summarizeNews({ articles: FEED.slice(0, 2), callModel })).toBeNull();
    expect(callModel).not.toHaveBeenCalled();
  });
});
