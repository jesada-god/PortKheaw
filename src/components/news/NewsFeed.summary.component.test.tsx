// @vitest-environment jsdom

/**
 * Behaviour contract for the AI card inside the dashboard's market news block,
 * exercised through the real component: the card sits above the feed, names
 * itself as AI-written, cites a real article per bullet — and every ordinary
 * reason there is no summary leaves the articles below completely untouched.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NewsSummary } from '@/src/lib/news/summary-types';
import type { NewsArticle } from '@/src/lib/news/types';
import { NewsFeed } from './NewsFeed';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ARTICLES: NewsArticle[] = Array.from({ length: 5 }, (_, index) => ({
  id: `article-${index}`,
  title: `Fed decision headline ${index}`,
  source: 'Example Wire',
  publishedAt: new Date(Date.UTC(2026, 7, 23, 12 - index)).toISOString(),
  url: `https://publisher.com/story-${index}`,
  imageUrl: null,
  symbols: [],
}));

const FEED_RESPONSE = {
  data: { articles: ARTICLES, nextCursor: null },
  error: null,
  meta: { provider: 'newsapi', timestamp: '2026-08-23T12:30:00.000Z', asOf: '2026-08-23T12:29:00.000Z', status: 'live' },
};

const SUMMARY: NewsSummary = {
  overview: 'ภาพรวมตลาดกำลังโฟกัสการประชุม FOMC',
  points: ARTICLES.slice(0, 3).map((article, index) => ({
    text: `ประเด็นที่ ${index}`,
    sourceIndex: index,
  })),
  sources: ARTICLES.slice(0, 3).map((article) => ({
    title: article.title,
    source: article.source,
    url: article.url,
    publishedAt: article.publishedAt,
  })),
  generatedAt: '2026-08-23T09:00:00.000Z',
};

let fetchMock: ReturnType<typeof vi.fn>;

/** Two endpoints, two answers — the feed and its summary are separate requests. */
function mockFetch(summary: unknown) {
  fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith('/api/news/market-summary')) {
      if (summary === 'reject') throw new Error('offline');
      return new Response(JSON.stringify({ summary, error: null, asOf: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(FEED_RESPONSE), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
}

let container: HTMLDivElement;
let root: Root;

async function mount(element: React.ReactElement) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(element); });
  // Mount, the viewport gate, the two requests, then their payloads.
  for (let flush = 0; flush < 4; flush += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

const card = () => container.querySelector('[data-testid="news-ai-summary"]');
const articleCards = () => [...container.querySelectorAll('a[target="_blank"]')]
  .filter((element) => element.closest('[data-testid="news-ai-summary"]') === null);
const requestedSummary = () => fetchMock.mock.calls
  .some(([url]) => String(url).startsWith('/api/news/market-summary'));

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the market news block', () => {
  it('puts the AI card above the articles and leaves every article in place', async () => {
    mockFetch({ summary: SUMMARY, stale: false });
    await mount(<NewsFeed marketWide />);

    const summaryCard = card();
    expect(summaryCard).not.toBeNull();
    expect(summaryCard?.textContent).toContain('สรุปภาพรวมข่าว');
    expect(summaryCard?.textContent).toContain('AI สรุปจาก 3 ข่าวล่าสุด');
    expect(summaryCard?.textContent).toContain('ภาพรวมตลาดกำลังโฟกัสการประชุม FOMC');
    expect(summaryCard?.textContent).toContain('ไม่ใช่คำแนะนำการลงทุน');

    // Above the list, in document order — not merely present somewhere.
    const position = summaryCard!.compareDocumentPosition(articleCards()[0]!);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // The feed under it is the whole feed: no cited/others split on this surface.
    expect(articleCards()).toHaveLength(ARTICLES.length);
    expect(container.textContent).toContain('Fed decision headline 4');
  });

  it('cites one real article per bullet, reachable from the card', async () => {
    mockFetch({ summary: SUMMARY, stale: false });
    await mount(<NewsFeed marketWide />);

    const citations = [...(card()?.querySelectorAll('sup a') ?? [])];
    expect(citations.map((element) => element.textContent)).toEqual(['[1]', '[2]', '[3]']);
    expect(citations.map((element) => element.getAttribute('href'))).toEqual([
      'https://publisher.com/story-0',
      'https://publisher.com/story-1',
      'https://publisher.com/story-2',
    ]);
  });

  it('shows the feed with no card when there is no summary to show', async () => {
    mockFetch(null);
    await mount(<NewsFeed marketWide />);

    expect(card()).toBeNull();
    expect(container.textContent).not.toContain('AI สรุปจาก');
    expect(articleCards()).toHaveLength(ARTICLES.length);
  });

  it('shows the feed with no card when the summary request itself fails', async () => {
    mockFetch('reject');
    await mount(<NewsFeed marketWide />);

    expect(card()).toBeNull();
    expect(articleCards()).toHaveLength(ARTICLES.length);
  });

  it('asks for a market summary only on the market block, never on a symbol feed', async () => {
    mockFetch({ summary: SUMMARY, stale: false });
    await mount(<NewsFeed symbol="AAA" />);

    expect(requestedSummary()).toBe(false);
    expect(card()).toBeNull();
  });
});
