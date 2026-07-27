// @vitest-environment jsdom

/**
 * Behaviour contract for the shared news feed, exercised through the real
 * component: 5 cards by default, 10 after "ดูเพิ่มเติม" with no second request,
 * back to 5 after "แสดงน้อยลง", real publisher thumbnails, and no thumbnail frame
 * after an image fails. Every article here is provider-shaped payload — the feed
 * renders exactly what it is given and invents nothing.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NEWS_MAX_COUNT, NEWS_PREVIEW_COUNT } from '@/src/lib/news/feed';
import type { NewsArticle } from '@/src/lib/news/types';
import { NewsFeed } from './NewsFeed';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function buildArticles(count: number): NewsArticle[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `article-${index}`,
    title: `Headline ${index}`,
    source: 'Example Wire',
    // Descending so index 0 is the newest.
    publishedAt: new Date(Date.UTC(2026, 6, 25, 12 - index)).toISOString(),
    url: `https://publisher.com/story-${index}`,
    imageUrl: index % 2 === 0 ? `https://cdn.publisher.com/thumb-${index}.jpg` : null,
    symbols: [],
  }));
}

function newsResponse(articles: NewsArticle[]) {
  return {
    data: { articles, nextCursor: null },
    error: null,
    meta: { provider: 'newsapi', timestamp: '2026-07-25T12:30:00.000Z', asOf: '2026-07-25T12:29:00.000Z', status: 'live' },
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function mockFetch(payload: unknown, status = 200) {
  fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), {
    status,
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
  // The feed mounts, resolves its viewport gate through a microtask and then awaits
  // the request; one more flush lands the payload.
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

const cards = () => [...container.querySelectorAll('a[target="_blank"]')];
const button = (label: string) => [...container.querySelectorAll('button')]
  .find((element) => element.textContent?.includes(label));

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  // Each test uses its own symbol so the module-level response cache cannot serve
  // another test's payload.
  vi.unstubAllGlobals();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('NewsFeed', () => {
  it('shows the five latest articles, then ten on request, without fetching again', async () => {
    mockFetch(newsResponse(buildArticles(NEWS_MAX_COUNT)));
    await mount(<NewsFeed symbol="AAA" />);

    expect(cards()).toHaveLength(NEWS_PREVIEW_COUNT);
    expect(cards()[0]?.textContent).toContain('Headline 0');
    // Newest first: the preview stops before the sixth-newest story.
    expect(container.textContent).not.toContain('Headline 5');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const expand = button('ดูเพิ่มเติม');
    expect(expand).toBeDefined();
    await click(expand!);

    expect(cards()).toHaveLength(NEWS_MAX_COUNT);
    expect(container.textContent).toContain('Headline 9');
    // Expanding is a slice of what is already loaded — never another request.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const collapse = button('แสดงน้อยลง');
    expect(collapse).toBeDefined();
    await click(collapse!);

    expect(cards()).toHaveLength(NEWS_PREVIEW_COUNT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('offers no expansion when the symbol has five or fewer articles', async () => {
    mockFetch(newsResponse(buildArticles(4)));
    await mount(<NewsFeed symbol="BBB" />);

    expect(cards()).toHaveLength(4);
    expect(button('ดูเพิ่มเติม')).toBeUndefined();
  });

  it('links every card to the publisher with hardened external-link attributes', async () => {
    mockFetch(newsResponse(buildArticles(3)));
    await mount(<NewsFeed symbol="CCC" />);

    for (const card of cards()) {
      expect(card.getAttribute('href')).toMatch(/^https:\/\/publisher\.com\/story-\d$/);
      expect(card.getAttribute('rel')).toContain('noopener');
      expect(card.getAttribute('rel')).toContain('noreferrer');
    }
  });

  it('renders a real image, omits image=null, and removes a failed frame without leaving a gap', async () => {
    mockFetch(newsResponse(buildArticles(2)));
    await mount(<NewsFeed symbol="DDD" />);

    const image = container.querySelector('img');
    expect(image?.getAttribute('src')).toBe('https://cdn.publisher.com/thumb-0.jpg');
    expect(image?.getAttribute('referrerpolicy')).toBe('no-referrer');
    // The article without an image has only its full-width content column.
    expect(cards()[1]?.querySelector('img')).toBeNull();
    expect(cards()[1]?.children).toHaveLength(1);
    expect(cards()[1]?.firstElementChild?.classList.contains('flex-1')).toBe(true);

    await act(async () => { image!.dispatchEvent(new Event('error')); });

    expect(cards()[0]?.querySelector('img')).toBeNull();
    expect(cards()[0]?.children).toHaveLength(1);
    expect(cards()[0]?.firstElementChild?.classList.contains('flex-1')).toBe(true);
  });

  it('shows the empty state rather than a card when the symbol has no news', async () => {
    mockFetch(newsResponse([]));
    await mount(<NewsFeed symbol="EEE" />);

    expect(cards()).toHaveLength(0);
    expect(container.textContent).toContain('ยังไม่มีข่าวในขณะนี้');
  });

  it('shows the provider-specific error with a retry action', async () => {
    mockFetch({
      data: null,
      error: { code: 'NEWS_PROVIDER_RATE_LIMITED', message: 'rate limited', retryable: true, retryAfterSeconds: 45 },
      meta: { provider: 'newsapi', timestamp: '2026-07-25T12:30:00.000Z', asOf: null, status: 'unavailable' },
    }, 429);
    await mount(<NewsFeed symbol="FFF" />);

    expect(container.textContent).toContain('จำกัดจำนวนคำขอ');
    expect(button('ลองใหม่')).toBeDefined();
  });
});
