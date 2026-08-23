// @vitest-environment jsdom

/**
 * Behaviour contract for the Stock Detail News tab, exercised through the real
 * component: the AI card is labelled as AI at its own heading, every bullet
 * carries a numbered link to the one article it came from, the articles under it
 * are the cited ones — not the first three — and with no summary the card is
 * absent rather than empty.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NewsArticle } from '@/src/lib/news/types';
import type { NewsSummary } from '@/src/lib/news/summary-types';
import { NewsTab } from './NewsTab';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function buildArticles(count: number): NewsArticle[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `article-${index}`,
    title: `Headline ${index}`,
    source: 'Example Wire',
    publishedAt: new Date(Date.UTC(2026, 7, 23, 12 - index)).toISOString(),
    url: `https://publisher.com/story-${index}`,
    imageUrl: null,
    summary: null,
    symbols: [],
  }));
}

function summaryCiting(articles: readonly NewsArticle[]): NewsSummary {
  return {
    overview: 'ตลาดกำลังโฟกัสผลประกอบการไตรมาสล่าสุด',
    points: articles.map((_, index) => ({ text: `ประเด็นที่ ${index}`, sourceIndex: index })),
    sources: articles.map((item) => ({
      title: item.title,
      source: item.source,
      url: item.url,
      publishedAt: item.publishedAt,
    })),
    generatedAt: '2026-08-23T09:00:00.000Z',
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function mockFetch(payload: unknown) {
  fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
}

let container: HTMLDivElement;
let root: Root;

async function mount(element: React.ReactElement) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(element); });
  // Mount, then the deferred fetch, then the payload.
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

const card = () => container.querySelector('[data-testid="news-ai-summary"]');
const articleCards = () => [...container.querySelectorAll('a[target="_blank"]')]
  .filter((element) => element.closest('[data-testid="news-ai-summary"]') === null);
const button = (label: string) => [...container.querySelectorAll('button')]
  .find((element) => element.textContent?.includes(label));

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('NewsTab', () => {
  it('names the card as AI-written at its heading and cites one article per bullet', async () => {
    const news = buildArticles(6);
    const summary = summaryCiting(news.slice(0, 3));
    mockFetch({ symbol: 'AAA', summary: { summary, stale: false }, news, error: null });

    await mount(<NewsTab symbol="AAA" />);

    const heading = card();
    expect(heading).not.toBeNull();
    expect(heading?.textContent).toContain('สรุปข่าวล่าสุด');
    expect(heading?.textContent).toContain('AI สรุปจาก 3 ข่าวล่าสุด');
    expect(heading?.textContent).toContain('ตลาดกำลังโฟกัสผลประกอบการไตรมาสล่าสุด');
    expect(heading?.textContent).toContain('ไม่ใช่คำแนะนำการลงทุน');

    const citations = [...(heading?.querySelectorAll('sup a') ?? [])];
    expect(citations.map((element) => element.textContent)).toEqual(['[1]', '[2]', '[3]']);
    expect(citations.map((element) => element.getAttribute('href'))).toEqual([
      'https://publisher.com/story-0',
      'https://publisher.com/story-1',
      'https://publisher.com/story-2',
    ]);
  });

  it('lists the cited articles, not the first three, when the feed has moved on', async () => {
    const news = buildArticles(6);
    // Cached summary cites stories 1-3; story 0 arrived after it was generated.
    const summary = summaryCiting(news.slice(1, 4));
    mockFetch({ symbol: 'AAA', summary: { summary, stale: false }, news, error: null });

    await mount(<NewsTab symbol="AAA" />);

    expect(container.textContent).toContain('ข่าวต้นฉบับ');
    const titles = articleCards().map((element) => element.textContent);
    expect(titles).toHaveLength(3);
    expect(titles[0]).toContain('Headline 1');
    expect(titles[2]).toContain('Headline 3');

    // Story 0 and the two below the cited ones sit in the collapsed group.
    const expand = button('ข่าวอื่น ๆ (3)');
    expect(expand).toBeDefined();
    expect(container.textContent).not.toContain('Headline 5');

    await click(expand!);
    expect(articleCards()).toHaveLength(6);
    expect(container.textContent).toContain('Headline 5');
  });

  it('hides the card entirely and shows only the feed when there is no summary', async () => {
    const news = buildArticles(6);
    mockFetch({ symbol: 'AAA', summary: null, news, error: null });

    await mount(<NewsTab symbol="AAA" />);

    expect(card()).toBeNull();
    expect(container.textContent).not.toContain('AI สรุปจาก');
    expect(container.textContent).toContain('ข่าวล่าสุด');
    expect(articleCards()).toHaveLength(5);
  });

  it('reports a news failure with a retry instead of an empty tab', async () => {
    mockFetch({
      symbol: 'AAA',
      summary: null,
      news: [],
      error: { code: 'NEWS_PROVIDER_RATE_LIMITED', message: 'limited', retryable: true },
    });

    await mount(<NewsTab symbol="AAA" />);

    expect(container.textContent).toContain('จำกัดจำนวนคำขอ');
    expect(button('ลองใหม่')).toBeDefined();
  });
});
