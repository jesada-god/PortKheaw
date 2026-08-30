// @vitest-environment jsdom

/**
 * The scope filter, exercised through the real feed.
 *
 * Everything here mounts the component and clicks the actual buttons: the tabs
 * are a claim about what a reader sees after a click, and a source scan cannot
 * make it. The payloads are provider-shaped — the feed renders what it is given
 * and invents nothing, so the symbols on each article are the tagger's work,
 * not this test's.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NEWS_FILTER_PREVIEW_COUNT } from '@/src/lib/news/scope';
import type { NewsArticle } from '@/src/lib/news/types';
import { NewsFeed } from './NewsFeed';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PORTFOLIO = ['AAPL', 'MSFT'];
const WATCHLIST = ['NVDA'];

function story(
  id: string,
  symbols: string[],
  hoursAgo: number,
): NewsArticle {
  return {
    id,
    title: `Headline ${id}`,
    source: 'Example Wire',
    publishedAt: new Date(Date.UTC(2026, 7, 30, 20 - hoursAgo)).toISOString(),
    url: `https://publisher.com/${id}`,
    imageUrl: null,
    symbols,
  };
}

function newsResponse(articles: NewsArticle[]) {
  return {
    data: { articles, nextCursor: null },
    error: null,
    meta: {
      provider: 'newsapi',
      timestamp: '2026-08-30T12:30:00.000Z',
      asOf: '2026-08-30T12:29:00.000Z',
      status: 'live',
    },
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
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

const cards = () => [...container.querySelectorAll('a[target="_blank"]')];
const headlines = () => cards().map((card) => card.textContent ?? '');
const tab = (scope: string) =>
  container.querySelector<HTMLButtonElement>(`[data-testid="news-scope-${scope}"]`);
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

/** One of each kind, with distinct ages so the ordering is observable. */
const MIXED = [
  story('market-a', [], 1),
  story('held', ['MSFT'], 2),
  story('watched', ['NVDA'], 5),
  story('market-b', [], 6),
  story('foreign', ['TSLA'], 7),
];

async function mountFiltered(articles: NewsArticle[], key: string) {
  mockFetch(newsResponse(articles));
  await mount(
    <NewsFeed
      withScopeFilter
      portfolioSymbols={[...PORTFOLIO, key]}
      watchlistSymbols={WATCHLIST}
    />,
  );
}

describe('the news scope filter', () => {
  it('offers the four scopes in order', async () => {
    await mountFiltered(MIXED, 'K1');
    const labels = [...container.querySelectorAll('button[data-testid^="news-scope-"]')]
      .map((element) => element.textContent);
    expect(labels).toEqual(['ทั้งหมด', 'พอร์ต', 'Watchlist', 'ตลาด']);
  });

  it('starts on ทั้งหมด', async () => {
    await mountFiltered(MIXED, 'K2');
    expect(tab('all')?.getAttribute('aria-pressed')).toBe('true');
    expect(tab('portfolio')?.getAttribute('aria-pressed')).toBe('false');
  });

  /*
   * The watchlist is what the reader is still deciding about, so its stories
   * lead — even though `watched` is older than both market stories. This is the
   * one place the feed's newest-first order is overridden.
   */
  it('puts watchlist stories at the top of the combined tab', async () => {
    await mountFiltered(MIXED, 'K3');
    expect(headlines()[0]).toContain('Headline watched');
  });

  it('shows only held symbols under พอร์ต', async () => {
    await mountFiltered(MIXED, 'K4');
    await click(tab('portfolio')!);
    expect(headlines()).toHaveLength(1);
    expect(headlines()[0]).toContain('Headline held');
  });

  it('shows only watched symbols under Watchlist', async () => {
    await mountFiltered(MIXED, 'K5');
    await click(tab('watchlist')!);
    expect(headlines()).toHaveLength(1);
    expect(headlines()[0]).toContain('Headline watched');
  });

  /*
   * ===========================================================================
   * UNTAGGED IS ตลาด, AND SO IS SOMEBODY ELSE'S SYMBOL
   * ===========================================================================
   * The two market stories carry no symbols and are not guessed into a holding;
   * `foreign` is tagged TSLA, which this reader neither holds nor watches, so
   * from their position it is news about the market. Neither is dropped.
   */
  it('files untagged stories and unrelated symbols under ตลาด', async () => {
    await mountFiltered(MIXED, 'K6');
    await click(tab('market')!);
    const shown = headlines().join(' ');
    expect(shown).toContain('Headline market-a');
    expect(shown).toContain('Headline market-b');
    expect(shown).toContain('Headline foreign');
    expect(shown).not.toContain('Headline held');
    expect(headlines()).toHaveLength(3);
  });

  it('filters without going back to the network', async () => {
    await mountFiltered(MIXED, 'K7');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await click(tab('portfolio')!);
    await click(tab('market')!);
    await click(tab('all')!);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('says a tab is empty instead of implying the whole feed failed', async () => {
    await mountFiltered([story('market-only', [], 1)], 'K8');
    await click(tab('watchlist')!);
    const empty = container.querySelector('[data-testid="news-scope-empty"]');
    expect(empty?.textContent).toContain('ยังไม่มีข่าวในหมวดWatchlist');
    // The tabs stay, or there is no way back out of an empty tab.
    expect(tab('all')).not.toBeNull();
  });

  it('shows eight stories, then the rest on request, without fetching again', async () => {
    const many = Array.from({ length: 12 }, (_, index) => story(`s${index}`, [], index));
    await mountFiltered(many, 'K9');

    expect(cards()).toHaveLength(NEWS_FILTER_PREVIEW_COUNT);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const expand = button('ดูเพิ่มเติม');
    expect(expand).toBeDefined();
    await click(expand!);

    expect(cards().length).toBeGreaterThan(NEWS_FILTER_PREVIEW_COUNT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('offers no ดูเพิ่มเติม when eight is everything', async () => {
    const few = Array.from({ length: 5 }, (_, index) => story(`f${index}`, [], index));
    await mountFiltered(few, 'K10');
    expect(cards()).toHaveLength(5);
    expect(button('ดูเพิ่มเติม')).toBeUndefined();
  });

  /*
   * With the flag off the overview feed is the market-wide one that shipped.
   * No tabs, and the five-card preview it always had.
   */
  it('renders no tabs at all when the filter is not asked for', async () => {
    mockFetch(newsResponse(MIXED));
    await mount(<NewsFeed marketWide />);
    expect(container.querySelector('[data-testid="news-scope-filter"]')).toBeNull();
    expect(cards().length).toBeLessThanOrEqual(5);
  });
});
