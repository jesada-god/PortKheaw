'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Newspaper, Sparkles } from 'lucide-react';
import { Skeleton } from '@/src/components/ui/Skeleton';
import { NEWS_PREVIEW_COUNT } from '@/src/lib/news/feed';
import type { NewsArticle } from '@/src/lib/news/types';
import type { NewsSummary } from '@/src/lib/news/summary-types';
import { formatBangkokDateTime } from '@/src/lib/presentation/datetime';
import { useAppVisible } from '@/src/hooks/useAppVisible';
import { useOnlineStatus } from '@/src/hooks/useOnlineStatus';
import { useStore } from '@/src/store/useStore';
import { newsErrorMessage } from './news-policy';
import { NewsThumbnail } from './NewsThumbnail';
import { splitNewsBySummary, sourceLabel } from './news-summary-view';

type ApiError = { code: string; message: string; retryable?: boolean; retryAfterSeconds?: number };
type SummaryResponse = {
  symbol: string | null;
  summary: { summary: NewsSummary; stale: boolean } | null;
  news: NewsArticle[];
  error: ApiError | null;
  asOf?: string;
};

const DISCLAIMER = 'สรุปโดย AI จากพาดหัวและเนื้อหาย่อของข่าวต้นฉบับ อาจคลาดเคลื่อนจากต้นฉบับได้ และไม่ใช่คำแนะนำการลงทุน';
const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400';

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

function ArticleCard({
  article,
  saveData,
  priority,
}: {
  article: NewsArticle;
  saveData: boolean;
  priority: boolean;
}) {
  return (
    <a
      href={article.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`flex gap-3 rounded-xl border border-slate-800 bg-[#151B28] p-3 transition-colors hover:border-slate-700 ${FOCUS_RING}`}
    >
      <NewsThumbnail imageUrl={article.imageUrl} saveData={saveData} priority={priority} />
      <div className="flex min-w-0 flex-1 flex-col justify-between">
        <h4 className="line-clamp-3 text-sm font-semibold leading-snug text-slate-100 sm:line-clamp-2">{article.title}</h4>
        <p className="mt-2 truncate text-xs text-slate-500">{article.source} · {formatBangkokDateTime(article.publishedAt)}</p>
      </div>
    </a>
  );
}

/**
 * The AI card.
 *
 * Its provenance is at the HEADING, not in the small print at the foot: a reader
 * scrolling into the tab meets "สรุปข่าวล่าสุด" and the AI badge in the same
 * glance, so there is no moment where these Thai sentences could be mistaken for
 * something a newsroom wrote. Every bullet carries the [n] of the one article it
 * came from, and the same [n] appears against a real headline and link below —
 * so a claim can always be taken back to its source in one tap.
 */
function SummaryCard({ summary, stale }: { summary: NewsSummary; stale: boolean }) {
  return (
    <section
      aria-label="สรุปข่าวล่าสุดโดย AI"
      className="rounded-2xl border border-slate-800 bg-[#151B28] p-4 sm:p-5"
      data-testid="news-ai-summary"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="text-base font-semibold text-white">สรุปข่าวล่าสุด</h3>
        <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-300">
          <Sparkles aria-hidden="true" size={12} />
          AI สรุปจาก {summary.sources.length} ข่าวล่าสุด
        </span>
      </div>

      <p className="mt-3 text-sm leading-6 text-slate-200">{summary.overview}</p>

      <ul className="mt-3 space-y-2">
        {summary.points.map((point) => {
          const source = summary.sources[point.sourceIndex];
          return (
            <li key={`${point.sourceIndex}-${point.text}`} className="flex gap-2 text-sm leading-6 text-slate-300">
              {/* `bg-current` rather than a slate value: the marker is the
                  bullet's own text colour at low opacity, so it follows the
                  light/dark mapping the surrounding text already has. */}
              <span aria-hidden="true" className="mt-[7px] size-1.5 shrink-0 rounded-full bg-current opacity-50" />
              <span className="min-w-0">
                {point.text}
                {source && (
                  <sup className="ms-1">
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`แหล่งที่มา ${point.sourceIndex + 1}: ${source.title}`}
                      className={`rounded-sm px-0.5 text-[11px] font-medium text-sky-300 hover:text-sky-200 ${FOCUS_RING}`}
                    >
                      {sourceLabel(point.sourceIndex)}
                    </a>
                  </sup>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="mt-4 border-t border-slate-800 pt-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">แหล่งที่มา</p>
        <ol className="mt-2 space-y-1.5">
          {summary.sources.map((source, index) => (
            <li key={source.url} className="flex gap-2 text-xs leading-5 text-slate-400">
              <span className="shrink-0 font-mono text-slate-500">{sourceLabel(index)}</span>
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className={`min-w-0 rounded-sm text-slate-300 underline decoration-slate-700 underline-offset-2 hover:text-white ${FOCUS_RING}`}
              >
                <span className="line-clamp-2">{source.title}</span>
                <span className="mt-0.5 block truncate text-slate-500">{source.source} · {formatBangkokDateTime(source.publishedAt)}</span>
              </a>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-[11px] leading-5 text-slate-500">{DISCLAIMER}</p>
        {stale && (
          <p className="mt-1 text-[11px] leading-5 text-slate-500">ข่าวเพิ่งเปลี่ยน — กำลังสรุปรอบใหม่ให้</p>
        )}
      </div>
    </section>
  );
}

function CollapsedSection({
  count,
  expanded,
  onToggle,
  children,
}: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className={`flex min-h-11 w-full items-center justify-center gap-1 rounded-xl border border-slate-700 bg-slate-800/50 px-4 py-2 text-sm text-white ${FOCUS_RING}`}
      >
        ข่าวอื่น ๆ ({count})
        {expanded ? <ChevronUp aria-hidden="true" size={16} /> : <ChevronDown aria-hidden="true" size={16} />}
      </button>
      {expanded && children}
    </div>
  );
}

/**
 * The Stock Detail News tab: one AI summary of the symbol's latest news, then
 * the articles that summary was built from, then the rest.
 *
 * The two halves are split by link rather than by count — see
 * `splitNewsBySummary` — because the summary is shared and cached per symbol and
 * the feed under it keeps moving.
 */
export function NewsTab({ symbol }: { symbol: string }) {
  /*
   * Both the payload and the failure carry the symbol they belong to, and both
   * are read back through it. A reader who taps from AAPL to MSFT while AAPL's
   * request is still open must not see AAPL's articles or AAPL's error message
   * under the MSFT header, and deriving the answer is what guarantees that —
   * an effect that cleared them would render the wrong pair once first.
   */
  const [payload, setPayload] = useState<{ symbol: string; response: SummaryResponse }>();
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<{ symbol: string; error: ApiError }>();
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const saveData = useDataSaver();
  const visible = useAppVisible();
  const isOnline = useOnlineStatus();

  const response = payload?.symbol === symbol ? payload.response : undefined;
  const error = failure?.symbol === symbol ? failure.error : undefined;
  const expanded = expandedFor === symbol;

  const fetchSummary = useCallback(async () => {
    if (!visible || !isOnline) return;
    setLoading(true);
    try {
      const result = await fetch(`/api/news/summary/${encodeURIComponent(symbol)}`);
      const body = await result.json() as SummaryResponse;
      if (body.error) {
        setFailure({ symbol, error: body.error });
      } else {
        setPayload({ symbol, response: body });
        setFailure(undefined);
      }
    } catch {
      setFailure({
        symbol,
        error: { code: 'NEWS_PROVIDER_UPSTREAM_FAILURE', message: 'News unavailable', retryable: true },
      });
    } finally {
      setLoading(false);
    }
  }, [symbol, visible, isOnline]);

  // Deferred rather than called in the effect body: the fetch sets `loading`
  // before it awaits, and doing that synchronously inside an effect is the
  // cascading-render pattern the lint rule rejects.
  useEffect(() => { queueMicrotask(() => void fetchSummary()); }, [fetchSummary]);

  const summary = response?.summary?.summary ?? null;
  const articles = useMemo(() => response?.news ?? [], [response]);
  const { cited, others } = useMemo(
    () => splitNewsBySummary(articles, summary),
    [articles, summary],
  );

  // With no summary the tab is a plain feed again, and the same preview/expand
  // shape carries it: the newest few, then the rest behind one control.
  const leading = summary ? cited : articles.slice(0, NEWS_PREVIEW_COUNT);
  const trailing = summary ? others : articles.slice(NEWS_PREVIEW_COUNT);

  if (loading && !response) {
    return (
      <div className="space-y-4" role="status" aria-label="กำลังโหลดข่าว" aria-busy="true">
        <div className="space-y-3 rounded-2xl border border-slate-800 bg-[#151B28] p-4 sm:p-5">
          <Skeleton className="h-5 w-40 rounded" />
          <Skeleton className="h-4 w-full rounded" />
          <Skeleton className="h-4 w-11/12 rounded" />
          <Skeleton className="h-4 w-3/4 rounded" />
        </div>
        <div className="space-y-3">{[1, 2, 3].map((index) => <NewsCardSkeleton key={index} />)}</div>
      </div>
    );
  }

  if (!articles.length) {
    if (error) {
      return (
        <div className="rounded-xl border border-slate-800 bg-slate-900/30 p-6 text-center">
          <Newspaper aria-hidden="true" className="mx-auto mb-2 text-slate-500" />
          <p className="text-sm text-slate-300">{newsErrorMessage(error.code)}</p>
          <button
            type="button"
            onClick={() => void fetchSummary()}
            className={`mt-3 min-h-11 rounded-lg border border-slate-700 px-3 py-2 text-xs text-white ${FOCUS_RING}`}
          >
            ลองใหม่
          </button>
        </div>
      );
    }
    return (
      <div className="rounded-xl border border-slate-800 p-6 text-center text-sm text-slate-400">
        ยังไม่มีข่าวในขณะนี้
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {summary && <SummaryCard summary={summary} stale={response?.summary?.stale ?? false} />}

      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-slate-300">{summary ? 'ข่าวต้นฉบับ' : 'ข่าวล่าสุด'}</h3>
        {leading.length
          ? leading.map((article, index) => (
            <ArticleCard key={article.id} article={article} saveData={saveData} priority={index === 0} />
          ))
          : <p className="text-xs text-slate-500">ข่าวที่ถูกสรุปไม่อยู่ในรายการล่าสุดแล้ว — เปิดได้จากลิงก์แหล่งที่มาในการ์ดด้านบน</p>}
      </div>

      {trailing.length > 0 && (
        <CollapsedSection
          count={trailing.length}
          expanded={expanded}
          onToggle={() => setExpandedFor(expanded ? null : symbol)}
        >
          <div className="space-y-3">
            {trailing.map((article) => (
              <ArticleCard key={article.id} article={article} saveData={saveData} priority={false} />
            ))}
          </div>
        </CollapsedSection>
      )}

      {response?.asOf && (
        <p className="text-right text-[10px] text-slate-500">อัปเดต {formatBangkokDateTime(response.asOf)}</p>
      )}
    </div>
  );
}
