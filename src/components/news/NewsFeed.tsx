'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Newspaper } from 'lucide-react';
import { Skeleton } from '@/src/components/ui/Skeleton';
import {
  NEWS_MAX_COUNT,
  canExpandNews,
  selectLatestNews,
  visibleNewsCount,
} from '@/src/lib/news/feed';
import type { NewsArticle, NewsPage } from '@/src/lib/news/types';
import { newsErrorMessage, newsViewState } from './news-policy';
import { NewsThumbnail } from './NewsThumbnail';
import { useStore } from '@/src/store/useStore';
import { useAppVisible } from '@/src/hooks/useAppVisible';
import { useOnlineStatus } from '@/src/hooks/useOnlineStatus';
import { formatBangkokDateTime } from '@/src/lib/presentation/datetime';

type ApiError = { code: string; message: string; retryable?: boolean; retryAfterSeconds?: number };
type ApiResponse = { data: NewsPage | null; error: ApiError | null; meta: { timestamp: string; asOf: string | null; status: 'live' | 'cached' | 'stale' | 'unavailable' } };
const pending = new Map<string, Promise<ApiResponse>>(); const pages = new Map<string, { value: ApiResponse; savedAt: number }>();
const CACHE_MS = 5 * 60_000;
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
export function NewsFeed({ symbol }: { symbol?: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  // Articles and the expansion carry the feed they belong to, so switching symbol
  // can never show the previous symbol's news or keep its "expanded" state — both
  // fall back by derivation instead of an effect that would re-render twice.
  const feedKey = symbol ?? 'market';
  const [feed, setFeed] = useState<{ key: string; articles: NewsArticle[] }>({ key: '', articles: [] });
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
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
        setFeed({ key: symbol ?? 'market', articles: selectLatestNews(result.data.articles, NEWS_MAX_COUNT) });
        setTimestamp(result.meta.asOf ?? result.meta.timestamp);
        setError(undefined);
      }
    } catch {
      const currentTime = Date.now(); setNow(currentTime);
      setError({ code: 'NEWS_PROVIDER_UPSTREAM_FAILURE', message: 'News unavailable', retryable: true });
      setRetryAt(currentTime + 30_000);
    } finally { setLoading(false); }
  }, [visible, isOnline, retryAt, symbol]);

  useEffect(() => { if (ready && visible && isOnline) queueMicrotask(() => void fetchPage()); }, [ready, visible, isOnline, fetchPage]);
  useEffect(() => { if (!retryAt || !visible) return; const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [visible, retryAt]);

  const cooldown = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const state = newsViewState(items.length, loading || !ready, error?.code);
  const visibleItems = items.slice(0, visibleNewsCount(items.length, expanded));

  let content: React.ReactNode;
  if (state === 'loading') {
    content = <div className="space-y-3" aria-label="Loading news" aria-busy="true">{[1, 2, 3].map((index) => <NewsCardSkeleton key={index} />)}</div>;
  } else if (state !== 'ready' && state !== 'empty') {
    content = (
      <div className="rounded-xl border border-slate-800 bg-slate-900/30 p-6 text-center">
        <Newspaper className="mx-auto mb-2 text-slate-500" />
        <p className="text-sm text-slate-300">{newsErrorMessage(error?.code ?? '')}</p>
        <button type="button" disabled={cooldown > 0} onClick={() => void fetchPage(true)} className="mt-3 min-h-11 rounded-lg border border-slate-700 px-3 py-2 text-xs text-white disabled:opacity-50">{cooldown ? `ลองใหม่ใน ${cooldown} วินาที` : 'ลองใหม่'}</button>
      </div>
    );
  } else if (state === 'empty') {
    content = <div className="rounded-xl border border-slate-800 p-6 text-center text-sm text-slate-400">ยังไม่มีข่าวในขณะนี้</div>;
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
              {saveData && <span className="mt-1 inline-block text-[10px] text-amber-300">Data Saver</span>}
            </div>
          </a>
        ))}
        {canExpandNews(items.length) && (
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
  return <div ref={root}>{content}</div>;
}
