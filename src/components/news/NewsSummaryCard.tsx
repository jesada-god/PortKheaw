'use client';
import { Sparkles } from 'lucide-react';
import type { NewsSummary } from '@/src/lib/news/summary-types';
import { formatBangkokDateTime } from '@/src/lib/presentation/datetime';
import { sourceLabel } from './news-summary-view';

const DISCLAIMER = 'สรุปโดย AI จากพาดหัวและเนื้อหาย่อของข่าวต้นฉบับ อาจคลาดเคลื่อนจากต้นฉบับได้ และไม่ใช่คำแนะนำการลงทุน';

export const FOCUS_RING = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400';

/**
 * The AI card, wherever it appears — the symbol's News tab and the dashboard's
 * market block render this one component over their own summary.
 *
 * Its provenance is at the HEADING, not in the small print at the foot: a reader
 * scrolling into it meets the title and the AI badge in the same glance, so
 * there is no moment where these Thai sentences could be mistaken for something
 * a newsroom wrote. Every bullet carries the [n] of the one article it came
 * from, and the same [n] appears against a real headline and link in the source
 * list below — so a claim can always be taken back to its source in one tap,
 * whether or not the surface underneath also lists the articles.
 *
 * Only `title` changes between surfaces, because only the subject changes: the
 * badge, the citations, the source list and the disclaimer are the parts that
 * make the card honest and none of them is a per-surface decision.
 */
export function NewsSummaryCard({
  summary,
  stale,
  title = 'สรุปข่าวล่าสุด',
}: {
  summary: NewsSummary;
  stale: boolean;
  title?: string;
}) {
  return (
    <section
      aria-label={`${title}โดย AI`}
      className="rounded-2xl border border-slate-800 bg-[#151B28] p-4 sm:p-5"
      data-testid="news-ai-summary"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="text-base font-semibold text-white">{title}</h3>
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
