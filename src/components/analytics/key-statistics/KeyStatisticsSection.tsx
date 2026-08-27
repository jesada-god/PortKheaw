'use client';

import { useCallback, useEffect, useState } from 'react';
import { DataState, reportDataError, type DataStateKind } from '@/src/components/ui/DataState';
import { Skeleton } from '@/src/components/ui/Skeleton';
import { formatMarketDataAsOf } from '@/src/lib/presentation/datetime';
import type { KeyStatisticsResult, MetricResult } from '@/src/lib/analytics/fundamentals/types';

/**
 * Key Statistics — the measurements, and nothing dressed up as a verdict.
 *
 * This section deliberately carries NO status marks. Every other block on the
 * stock page reads as 🟢/🟡/🟠/🔴 because something adjudicated it; nothing
 * adjudicates a P/E. Deciding that 34 is "ค่อนข้างแพง" would be a threshold
 * invented here and printed with a service's credibility behind it, which is the
 * one thing `src/lib/stock-detail/summary.ts` refuses to do for the same reason.
 * So these are figures, labelled, with their provenance one tap away.
 *
 * WHAT THIS REPLACED. The whole component was four very long lines. It drew
 * `bg-[#151B28]` and `border-slate-800` — hardcoded darks that the light theme
 * had to rescue — put a card inside a card inside a details element, and
 * answered a missing figure with the English words "Unavailable" and "Not
 * meaningful" on a Thai page. Its loading state was `h-28 animate-pulse`, a grey
 * rectangle of no particular shape, and a failed fetch printed the raw thrown
 * message inside an amber box.
 */

/**
 * The four figures worth the top of the section, in Thai.
 *
 * The rest are still available below, and they used to be printed under their
 * RAW KEYS — a reader met "dilutedEpsTtm" and "sharesOutstanding" as headings.
 * Every key the service can return is named here; one it returns that is not on
 * this list falls back to the key, which is a bug worth seeing rather than a row
 * worth hiding.
 */
const METRIC_LABEL: Readonly<Record<string, string>> = {
  trailingPe: 'P/E (ย้อนหลัง)',
  forwardPe: 'P/E (คาดการณ์)',
  marketCap: 'มูลค่าตลาด',
  currentVolume: 'ปริมาณซื้อขายวันนี้',
  relativeVolume: 'ปริมาณเทียบค่าเฉลี่ย 20 วัน',
  dilutedEpsTtm: 'กำไรต่อหุ้น (TTM)',
  sharesOutstanding: 'จำนวนหุ้นทั้งหมด',
  dilutedShares: 'จำนวนหุ้นปรับลด (TTM)',
  putCallVolume: 'Put/Call (ปริมาณ)',
  putCallOpenInterest: 'Put/Call (สัญญาคงค้าง)',
  revenue: 'รายได้',
  freeCashFlow: 'กระแสเงินสดอิสระ',
  dividendYield: 'อัตราปันผล',
  beta: 'Beta',
  fiftyTwoWeekHigh: 'สูงสุด 52 สัปดาห์',
  fiftyTwoWeekLow: 'ต่ำสุด 52 สัปดาห์',
  earningsDate: 'วันประกาศงบ',
};

/** The four a reader checks first, in the order they check them. */
const PRIMARY_KEYS = ['trailingPe', 'marketCap', 'currentVolume', 'relativeVolume'] as const;

interface Shown {
  value: string;
  /** Why there is no figure, in Thai. Empty when there is one. */
  absence: string;
  detail: string;
}

/**
 * A metric, as the reader sees it.
 *
 * The two ways a figure can be missing are kept apart, because they are
 * genuinely different answers and the English words that used to stand for them
 * said neither: `unavailable` means nobody supplied the input, and
 * `not-meaningful` means the arithmetic ran and produced something that would
 * mislead — a P/E on negative earnings is the standing example.
 */
function display(metric: MetricResult | undefined): Shown {
  if (!metric) return { value: '', absence: 'ยังไม่ได้รับข้อมูลจากเซิร์ฟเวอร์', detail: '' };
  /*
   * `'value' in metric` rather than a check on `status`. The two halves of
   * `MetricResult` are intersections with a shared metadata type, and TypeScript
   * will not narrow an intersection by its discriminant — testing for the field
   * that only one half has is what actually narrows it.
   */
  if (!('value' in metric)) {
    return {
      value: '',
      absence: metric.status === 'not-meaningful' ? 'คำนวณแล้วไม่สื่อความหมาย' : 'ยังไม่มีข้อมูล',
      detail: metric.reason,
    };
  }
  const suffix = metric.unit === 'x' ? '×' : metric.unit === '%' ? '%' : '';
  return {
    value: `${metric.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}${suffix}`,
    absence: '',
    detail: metric.limitations.join(' '),
  };
}

function MetricRow({ metricKey, metric }: { metricKey: string; metric: MetricResult | undefined }) {
  const shown = display(metric);
  const label = METRIC_LABEL[metricKey] ?? metricKey;
  return (
    <div className="min-w-0">
      <p className="figure-label break-words">{label}</p>
      {shown.value
        ? <p className="figure mt-1 break-all font-mono text-sm text-[var(--text)]">{shown.value}</p>
        : <p className="mt-1 break-words text-sm text-[var(--text-muted)]">{shown.absence}</p>}
      {metric?.asOf && (
        <p className="mt-0.5 break-words text-[10px] text-[var(--text-muted)]">
          {formatMarketDataAsOf(metric.asOf, { dateOnly: metric.freshness.status === 'end-of-day' })}
        </p>
      )}
    </div>
  );
}

export function KeyStatisticsSection({ symbol }: { symbol: string }) {
  const [data, setData] = useState<KeyStatisticsResult | null>(null);
  const [state, setState] = useState<DataStateKind>('loading');

  const load = useCallback((signal?: AbortSignal) => {
    setState('loading');
    void fetch(`/api/analytics/key-statistics/${encodeURIComponent(symbol)}`, { signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`key-statistics responded ${response.status}`);
        return response.json();
      })
      .then((body) => {
        if (signal?.aborted) return;
        setData(body.data ?? null);
        setState(body.data ? 'ready' : 'empty');
      })
      .catch((cause) => {
        if (signal?.aborted || (cause instanceof Error && cause.name === 'AbortError')) return;
        /*
         * The status line and the endpoint go to the console. This panel used to
         * print the thrown message — including "ฟีเจอร์ถูกปิด" for a 404, which
         * told a reader about a server flag they cannot do anything about.
         */
        reportDataError('key-statistics', cause);
        setState('error');
      });
  }, [symbol]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const secondary = data
    ? Object.entries(data.metrics).filter(([key]) => !PRIMARY_KEYS.includes(key as typeof PRIMARY_KEYS[number]))
    : [];

  return (
    <section aria-label="Key Statistics" className="min-w-0">
      <h2 className="section-eyebrow">ตัวเลขสำคัญ</h2>
      <DataState
        state={state}
        onRetry={() => load()}
        emptyMessage="ยังไม่มีตัวเลขสำคัญของหุ้นตัวนี้"
        skeleton={
          <div className="mt-3 grid grid-cols-2 gap-4 lg:grid-cols-4">
            {PRIMARY_KEYS.map((key) => (
              <div key={key} className="space-y-1.5">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-5 w-16" />
              </div>
            ))}
          </div>
        }
      >
        {data && (
          <>
            {/*
              One container, not three. The figures used to be four bordered
              cards inside a bordered section, with a bordered details element
              under them holding more bordered boxes — four levels of frame for
              content that is a list of numbers.
            */}
            <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-5 lg:grid-cols-4">
              {PRIMARY_KEYS.map((key) => (
                <MetricRow key={key} metricKey={key} metric={data.metrics[key]} />
              ))}
            </div>

            {secondary.length > 0 && (
              <details className="mt-4 min-w-0">
                <summary className="flex min-h-11 cursor-pointer list-none items-center text-sm text-[var(--text-secondary)]">
                  ดูตัวเลขทั้งหมด
                </summary>
                <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-5 border-t border-[var(--hairline)] pt-4 sm:grid-cols-3 lg:grid-cols-4">
                  {secondary.map(([key, metric]) => (
                    <MetricRow key={key} metricKey={key} metric={metric} />
                  ))}
                </div>
              </details>
            )}

            {/*
              Where the numbers came from, said once for the section rather than
              once per figure. The old card repeated the provider, the freshness
              and the methodology inside every metric's own disclosure.
            */}
            <p className="mt-4 break-words text-xs leading-5 text-[var(--text-muted)]">
              ที่มา {data.source} · {formatMarketDataAsOf(data.latestDataAt ?? data.asOf)}
            </p>
          </>
        )}
      </DataState>
    </section>
  );
}
