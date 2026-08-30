'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Newspaper } from 'lucide-react';
import { Skeleton } from '@/src/components/ui/Skeleton';
import {
  NEWS_MAX_COUNT,
  canExpandNews,
  selectLatestNews,
  visibleNewsCount,
} from '@/src/lib/news/feed';
import { MARKET_WIDE_NEWS_LIMIT } from '@/src/lib/news/market-wide';
import {
  canExpandScopedNews,
  NEWS_SCOPE_LABEL_TH,
  NEWS_SCOPES,
  selectScopedNews,
  visibleScopedCount,
  type NewsScope,
} from '@/src/lib/news/scope';
import type { NewsSummaryPayload } from '@/src/lib/news/summary-types';
import type { NewsArticle, NewsPage } from '@/src/lib/news/types';
import { newsErrorMessage, newsViewState } from './news-policy';
import { NewsSummaryCard } from './NewsSummaryCard';
import { NewsThumbnail } from './NewsThumbnail';
import { useStore } from '@/src/store/useStore';
import { useAppVisible } from '@/src/hooks/useAppVisible';
import { useOnlineStatus } from '@/src/hooks/useOnlineStatus';
import { formatBangkokDateTime } from '@/src/lib/presentation/datetime';

type ApiError = { code: string; message: string; retryable?: boolean; retryAfterSeconds?: number };
type ApiResponse = { data: NewsPage | null; error: ApiError | null; meta: { timestamp: string; asOf: string | null; status: 'live' | 'cached' | 'stale' | 'unavailable' } };
const pending = new Map<string, Promise<ApiResponse>>(); const pages = new Map<string, { value: ApiResponse; savedAt: number }>();
const CACHE_MS = 5 * 60_000;
const EMPTY_TOPICS: string[] = [];
function load(url: string, force = false) {
  const cached = pages.get(url); if (!force && cached && Date.now() - cached.savedAt < CACHE_MS) return Promise.resolve(cached.value);
  const existing = pending.get(url); if (existing) return existing;
  const request = fetch(url).then(async (response) => (await response.json()) as ApiResponse).then((value) => { if (value.data) pages.set(url, { value, savedAt: Date.now() }); return value; }).catch((error) => { if (cached) return cached.value; throw error; }).finally(() => pending.delete(url)); pending.set(url, request); return request;
}
function useDataSaver() {
  const requested = useStore((state) => state.dataSaver);
  const [networkPreference, setNetworkPreference] = useState(false);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) {
        setNetworkPreference(Boolean(
          (navigator as Navigator & { connection?: { saveData?: boolean } })
            .connection?.saveData,
        ));
      }
    });
    return () => { active = false; };
  }, []);
  return requested || networkPreference;
}

/**
 * The market block's AI card, fetched apart from the feed under it.
 *
 * Two requests rather than one on purpose: the feed is what this component is
 * for and must not wait on — or fail with — a summary that is an addition to it.
 * `/api/news/market-summary` answers `summary: null` for every ordinary reason a
 * card cannot be shown (no Redis, no model key, the first one still generating),
 * and a rejected promise is the same answer, so both simply leave the card out.
 */
function useMarketNewsSummary(enabled: boolean) {
  const [summary, setSummary] = useState<NewsSummaryPayload | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    queueMicrotask(() => {
      void fetch('/api/news/market-summary')
        .then(async (response) => (await response.json()) as { summary: NewsSummaryPayload | null })
        .then((body) => { if (active && body.summary) setSummary(body.summary); })
        .catch(() => {});
    });
    return () => { active = false; };
  }, [enabled]);
  return summary;
}

function NewsCardSkeleton() {
  return (
    <div className="space-y-2 rounded-xl border border-slate-800 bg-[#151B28] p-3">
      <Skeleton className="h-4 w-full rounded" />
      <Skeleton className="h-4 w-4/5 rounded" />
      <Skeleton className="h-3 w-2/5 rounded" />
    </div>
  );
}

/**
 * One news feed for every surface: the symbol tab on Stock Detail and the market
 * feed on the dashboard render the same cards with the same 5 → 10 behaviour.
 *
 * A single request per symbol delivers the whole feed (the provider page is
 * {@link NEWS_MAX_COUNT}), so "ดูเพิ่มเติม"/"แสดงน้อยลง" only changes how many of
 * the already-loaded articles are shown — expanding never touches the network.
 */
export function NewsFeed({
  symbol,
  portfolioSymbols = EMPTY_TOPICS,
  watchlistSymbols = EMPTY_TOPICS,
  industryNames = EMPTY_TOPICS,
  marketWide = false,
  withScopeFilter = false,
}: {
  symbol?: string;
  portfolioSymbols?: string[];
  watchlistSymbols?: string[];
  industryNames?: string[];
  marketWide?: boolean;
  /**
   * Show the ทั้งหมด / พอร์ต / Watchlist / ตลาด tabs over this feed.
   *
   * Off everywhere by default, so the symbol tab on Stock Detail and the
   * market feed both render exactly as they did. When it is on, the feed is
   * the PERSONALIZED one — the same request `portfolioSymbols` and
   * `watchlistSymbols` already produce — because those are the parameters that
   * make the tagger attach the reader's own symbols to an article. Filtering a
   * market-wide payload instead would leave the พอร์ต and Watchlist tabs
   * permanently empty, since market-wide stories carry no symbols by design.
   */
  withScopeFilter?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  // Articles and the expansion carry the feed they belong to, so switching symbol
  // can never show the previous symbol's news or keep its "expanded" state — both
  // fall back by derivation instead of an effect that would re-render twice.
  const personalizedKey = [
    portfolioSymbols.join(','),
    watchlistSymbols.join(','),
    industryNames.join(','),
  ].join('|');
  const feedKey = symbol ?? (marketWide ? 'market-wide' : (personalizedKey || 'market'));
  const [feed, setFeed] = useState<{ key: string; articles: NewsArticle[] }>({ key: '', articles: [] });
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  /*
   * The selected tab, carried with the feed it belongs to for the same reason
   * the expansion is: switching feed must not leave the previous feed's tab
   * selected over a list that no longer has anything in it.
   */
  const [scopeFor, setScopeFor] = useState<{ key: string; scope: NewsScope }>({ key: '', scope: 'all' });
  const items = feed.key === feedKey ? feed.articles : [];
  const expanded = expandedFor === feedKey;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError>();
  const [timestamp, setTimestamp] = useState<string>();
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(0);
  const saveData = useDataSaver();
  // Visibility, not focus: a reader who clicks another window while the tab stays
  // on screen must not have the feed silently stop loading.
  const visible = useAppVisible();
  const isOnline = useOnlineStatus();

  useEffect(() => { const node = root.current; if (!node || typeof IntersectionObserver === 'undefined') { queueMicrotask(() => setReady(true)); return; } const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) { setReady(true); observer.disconnect(); } }, { rootMargin: '200px' }); observer.observe(node); return () => observer.disconnect(); }, []);

  const fetchPage = useCallback(async (force = false) => {
    if (!visible || !isOnline || Date.now() < retryAt) return;
    setLoading(true);
    const params = new URLSearchParams();
    if (symbol) params.set('symbol', symbol);
    else if (marketWide) params.set('scope', 'market-wide');
    else {
      if (portfolioSymbols.length) params.set('portfolio', portfolioSymbols.join(','));
      if (watchlistSymbols.length) params.set('watchlist', watchlistSymbols.join(','));
      if (industryNames.length) params.set('industries', industryNames.join(','));
    }
    try {
      const result = await load(`/api/news?${params}`, force);
      if (result.error || !result.data) {
        const nextError = result.error ?? { code: 'NEWS_PROVIDER_UPSTREAM_FAILURE', message: 'News unavailable', retryable: true };
        setError(nextError);
        if (nextError.retryable) { const currentTime = Date.now(); setNow(currentTime); setRetryAt(currentTime + (nextError.retryAfterSeconds ?? 30) * 1000); }
      } else {
        // Newest first, one card per story, at most NEWS_MAX_COUNT — re-applied
        // here so a cached or partially ordered payload cannot reach the reader
        // out of order.
        setFeed({
          key: feedKey,
          articles: selectLatestNews(
            result.data.articles,
            marketWide ? MARKET_WIDE_NEWS_LIMIT : NEWS_MAX_COUNT,
          ),
        });
        setTimestamp(result.meta.asOf ?? result.meta.timestamp);
        setError(undefined);
      }
    } catch {
      const currentTime = Date.now(); setNow(currentTime);
      setError({ code: 'NEWS_PROVIDER_UPSTREAM_FAILURE', message: 'News unavailable', retryable: true });
      setRetryAt(currentTime + 30_000);
    } finally { setLoading(false); }
  }, [
    visible,
    isOnline,
    retryAt,
    symbol,
    feedKey,
    portfolioSymbols,
    watchlistSymbols,
    industryNames,
    marketWide,
  ]);

  useEffect(() => { if (ready && visible && isOnline) queueMicrotask(() => void fetchPage()); }, [ready, visible, isOnline, fetchPage]);
  useEffect(() => { if (!retryAt || !visible) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [visible, retryAt]);

  const cooldown = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const state = newsViewState(items.length, loading || !ready, error?.code);
  const scope = scopeFor.key === feedKey ? scopeFor.scope : 'all';
  const scopeContext = useMemo(
    () => ({ portfolioSymbols, watchlistSymbols }),
    [portfolioSymbols, watchlistSymbols],
  );
  /*
   * The scoped list, or the plain one. `selectScopedNews` re-runs the feed's
   * own de-duplication after filtering, so a story republished by a second
   * outlet cannot take two of the eight rows a tab has.
   */
  const scopedItems = useMemo(
    () => (withScopeFilter
      ? selectScopedNews(items, scope, scopeContext, items.length)
      : items),
    [withScopeFilter, items, scope, scopeContext],
  );
  const visibleItems = withScopeFilter
    ? scopedItems.slice(0, visibleScopedCount(scopedItems.length, expanded))
    : items.slice(0, visibleNewsCount(items.length, expanded));
  const marketSummary = useMarketNewsSummary(marketWide && ready && visible && isOnline);

  let content: React.ReactNode;
  if (state === 'loading') {
    // role="status": a bare <div> is role="generic", which prohibits both
    // aria-label and aria-busy, so axe rejected them and AT read nothing.
    content = <div className="space-y-3" role="status" aria-label="กำลังโหลดข่าว" aria-busy="true">{[1, 2, 3].map((index) => <NewsCardSkeleton key={index} />)}</div>;
  } else if (state !== 'ready' && state !== 'empty') {
    content = (
      <div className="rounded-xl border border-slate-800 bg-slate-900/30 p-6 text-center">
        <Newspaper className="mx-auto mb-2 text-slate-500" />
        <p className="text-sm text-slate-300">{newsErrorMessage(error?.code ?? '')}</p>
        <button type="button" disabled={cooldown > 0} onClick={() => void fetchPage(true)} className="mt-3 min-h-11 rounded-lg border border-slate-700 px-3 py-2 text-xs text-white disabled:opacity-50">{cooldown ? `ลองใหม่ใน ${cooldown} วินาที` : 'ลองใหม่'}</button>
      </div>
    );
  } else if (state === 'empty') {
    content = <div className="rounded-xl border border-slate-800 p-6 text-center text-sm text-slate-400">
      {marketWide ? 'ยังไม่มีข่าวที่ผ่านเกณฑ์ผลกระทบต่อตลาดโดยรวม' : 'ยังไม่มีข่าวในขณะนี้'}
    </div>;
  } else if (withScopeFilter && scopedItems.length === 0) {
    /*
      The feed loaded and this TAB is empty — a different fact from "there is no
      news", and it says so. Without this the reader would see the market-wide
      empty copy under a Watchlist tab and conclude the whole feed had failed.
    */
    content = (
      <div
        className="rounded-xl border border-slate-800 p-6 text-center text-sm text-slate-400"
        data-testid="news-scope-empty"
      >
        {`ยังไม่มีข่าวในหมวด${NEWS_SCOPE_LABEL_TH[scope]}`}
      </div>
    );
  } else {
    content = (
      <div className="space-y-3">
        {timestamp && <p className="text-right text-[10px] text-slate-500">อัปเดต {formatBangkokDateTime(timestamp)}</p>}
        {visibleItems.map((article, index) => (
          <a
            key={article.id}
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex gap-3 rounded-xl border border-slate-800 bg-[#151B28] p-3 transition-colors hover:border-slate-700"
          >
            <NewsThumbnail imageUrl={article.imageUrl} saveData={saveData} priority={index === 0} />
            <div className="flex min-w-0 flex-1 flex-col justify-between">
              <h3 className="line-clamp-3 text-sm font-semibold leading-snug text-slate-100 sm:line-clamp-2">{article.title}</h3>
              <p className="mt-2 truncate text-xs text-slate-500">{article.source} · {formatBangkokDateTime(article.publishedAt)}</p>
              {(article.symbols.length > 0 || (article.industries?.length ?? 0) > 0) && (
                <span className="mt-1 flex flex-wrap gap-1">
                  {[...article.symbols, ...(article.industries ?? [])].slice(0, 3).map((tag) => (
                    <span key={tag} className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300">{tag}</span>
                  ))}
                </span>
              )}
              {saveData && <span className="mt-1 inline-block text-[10px] text-amber-300">Data Saver</span>}
            </div>
          </a>
        ))}
        {(withScopeFilter ? canExpandScopedNews(scopedItems.length) : canExpandNews(items.length)) && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpandedFor(expanded ? null : feedKey)}
            className="flex min-h-11 w-full items-center justify-center gap-1 rounded-xl border border-slate-700 bg-slate-800/50 px-4 py-2 text-sm text-white"
          >
            {expanded ? <>แสดงน้อยลง <ChevronUp size={16} /></> : <>ดูเพิ่มเติม <ChevronDown size={16} /></>}
          </button>
        )}
      </div>
    );
  }
  /*
   * Above the articles, and only beside them: the card summarises this feed, so
   * showing it over a skeleton, an error or an empty block would leave a reader
   * with three Thai bullets and nothing to check them against. The articles
   * themselves are untouched — no cited/others split like the Stock Detail tab,
   * because five stories is already a short enough list to read straight down.
   */
  const card = state === 'ready' && marketSummary
    ? <NewsSummaryCard summary={marketSummary.summary} stale={marketSummary.stale} title="สรุปภาพรวมข่าว" />
    : null;

  /*
   * THE TABS, ABOVE EVERYTHING THE FEED DRAWS.
   *
   * Rendered whenever the filter is on and the feed is not in an error or
   * loading state — including when the SELECTED tab is empty, because the tabs
   * are how a reader gets back out of an empty tab. Hiding them there would
   * trap somebody on a Watchlist filter with no visible way to return to
   * ทั้งหมด.
   *
   * `aria-pressed` rather than a tablist: these filter one list in place, they
   * do not switch between panels, and announcing them as tabs would promise a
   * reader a panel change that never happens.
   */
  const tabs = withScopeFilter && (state === 'ready' || state === 'empty')
    ? (
      <div className="flex flex-wrap gap-2" role="group" aria-label="กรองข่าว" data-testid="news-scope-filter">
        {NEWS_SCOPES.map((option) => {
          const active = option === scope;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={active}
              onClick={() => setScopeFor({ key: feedKey, scope: option })}
              data-testid={`news-scope-${option}`}
              className={[
                'min-h-9 rounded-full border px-3 py-1.5 text-xs transition-colors',
                active
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)] font-semibold text-[var(--accent)]'
                  : 'border-slate-700 text-slate-300 hover:border-slate-600',
              ].join(' ')}
            >
              {NEWS_SCOPE_LABEL_TH[option]}
            </button>
          );
        })}
      </div>
    )
    : null;

  return (
    <div ref={root} className={card || tabs ? 'space-y-4' : undefined}>
      {tabs}
      {card}
      {content}
    </div>
  );
}
