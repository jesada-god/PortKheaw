import { MARKET_STATUS_INPUTS } from '@/src/config/market-status';
import { inputStatusLevel } from '@/src/lib/market-status/presentation';
import {
  OV_MARKET_STATUS_LEVEL,
  OV_MARKET_STATUS_WORD,
  OV_REGIME_WORD,
  type OvIndexKey,
  type OvIndexReading,
  type OvMarketSnapshot,
} from '@/src/lib/market-overview/types';
import { StatusLabel } from '@/src/components/ui/StatusLabel';
import { signedPercent } from '@/src/lib/portfolio/presentation';
import { formatMarketDataAsOf } from '@/src/lib/presentation/datetime';
import type { MarketIndexCard } from '@/src/lib/overview/types';

/**
 * ตลาดวันนี้ — one row, one market.
 *
 * ===========================================================================
 * A BAND, NOT SIX CARDS
 * ===========================================================================
 * `.data-strip` is the product's existing shape for "one object with several
 * facets": a hairline rectangle whose cells are divided by rules rather than by
 * gaps. Six boxed cards in a row would say these are six independent things,
 * and they are not — they are six readings of one market, which is the whole
 * claim the status line underneath makes.
 *
 * Six across at every width. On a handset the strip overflows and
 * `.data-strip-scroll` scrolls it sideways; it does NOT reflow into three rows
 * of two, because a band that becomes a block stops being a band.
 *
 * ===========================================================================
 * THE MARK READS MEANING, NOT DIRECTION
 * ===========================================================================
 * A rising VIX is bad news even though the number went up, so each cell's mark
 * is `inputStatusLevel`, which applies the input's own polarity — the same
 * helper, from the same module, that the Market Status card uses. `OvIndexReading`
 * carries no polarity, so the polarity and the dead band are read from
 * `MARKET_STATUS_INPUTS`, which is the table `indices.ts` builds the readings
 * from in the first place. Nothing is computed here that is not a lookup.
 */

const INPUT_BY_KEY = new Map(MARKET_STATUS_INPUTS.map((input) => [input.key, input]));

/** Index levels, in the product's Thai locale, without inventing precision. */
function formatLevel(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ReadingCell({ reading }: { reading: OvIndexReading }) {
  const input = INPUT_BY_KEY.get(reading.key as OvIndexKey);
  const level = inputStatusLevel(
    reading.changePercent,
    input?.polarity ?? 1,
    input?.flatBandPercent ?? 0,
  );
  return (
    <div className="data-strip__cell min-w-0" data-testid={`market-today-${reading.key}`}>
      <span className="figure-label truncate">{reading.labelTh}</span>
      {/*
        The number is the point, so it is the biggest and heaviest thing in the
        cell. An unreadable input prints an em dash and never a zero — a zero is
        a reading meaning "this did not move".
      */}
      <span className="figure mt-0.5 block truncate text-base font-bold text-[var(--text)]">
        {formatLevel(reading.value)}
      </span>
      <StatusLabel
        level={level}
        label={reading.changePercent === null ? 'ยังไม่มีค่า' : signedPercent(reading.changePercent)}
        className="mt-0.5 text-xs"
      />
    </div>
  );
}

/**
 * The six readings, the word, and why.
 *
 * Absent entirely when the snapshot has not arrived — the section then draws
 * only the assets below it, which is exactly the page as it shipped.
 */
export function MarketTodayStrip({ snapshot }: { snapshot: OvMarketSnapshot }) {
  const readings = Object.values(snapshot.readings);
  const status = snapshot.status;
  return (
    <div className="min-w-0" data-testid="market-today-strip">
      <div className="data-strip-scroll bleed-mobile px-[var(--page-gutter)] sm:px-0">
        <div className="data-strip data-strip--6">
          {readings.map((reading) => <ReadingCell key={reading.key} reading={reading} />)}
        </div>
      </div>
      {/*
        The reading, under the numbers it is a reading of.

        `status === null` means the equity inputs were not all readable, and the
        honest answer is to say so rather than to soften the word — the numbers
        above still print whatever did arrive.
      */}
      <div className="mt-3 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        {status === null ? (
          <StatusLabel level="unknown" label="ยังอ่านภาพรวมตลาดไม่ได้" data-testid="market-today-status" />
        ) : (
          <>
            <StatusLabel
              level={OV_MARKET_STATUS_LEVEL[status]}
              label={OV_MARKET_STATUS_WORD[status]}
              data-testid="market-today-status"
            />
            {snapshot.regime && (
              <span className="text-[var(--text-secondary)]" data-testid="market-today-regime">
                {OV_REGIME_WORD[snapshot.regime]}
              </span>
            )}
          </>
        )}
      </div>
      {/*
        Two or three measurements, and nothing else. Each is an instrument and a
        signed percentage — the reader can disagree with the word above by
        reading the numbers that produced it.
      */}
      {status !== null && snapshot.regimeReasons.length > 0 && (
        <p
          className="mt-1 text-xs leading-5 text-[var(--text-muted)]"
          data-testid="market-today-reasons"
        >
          {snapshot.regimeReasons.slice(0, 3).join(' · ')}
        </p>
      )}
      {snapshot.stale && (
        <p className="mt-1 text-[11px] leading-4 text-[var(--text-muted)]" data-testid="market-today-stale">
          {formatMarketDataAsOf(snapshot.evaluatedAt)} · กำลังอัปเดต
        </p>
      )}
    </div>
  );
}

/**
 * The nine assets, compact.
 *
 * They were nine cards; a card each is what made the market block the tallest
 * thing on the page. The same rows, in the same order, in the same strip shape
 * as the six above — so the section reads as one market with two bands rather
 * than as two sections that happen to be adjacent.
 *
 * NOTHING IS REMOVED. Gold, silver, crude, rare earths and Bitcoin are all
 * still here; they are quieter, not gone.
 */
export function MarketAssetStrip({ items }: { items: readonly MarketIndexCard[] }) {
  if (items.length === 0) return null;
  return (
    <div
      className="data-strip-scroll bleed-mobile mt-3 px-[var(--page-gutter)] sm:px-0"
      data-testid="market-today-assets"
    >
      <div className="data-strip data-strip--flow">
        {items.map((item) => (
          <div key={item.symbol} className="data-strip__cell min-w-0" data-testid={`market-asset-${item.symbol}`}>
            <span className="figure-label truncate">{item.name}</span>
            <span className="figure mt-0.5 block truncate text-sm font-bold text-[var(--text)]">
              {formatLevel(item.price)}
            </span>
            <StatusLabel
              level={
                item.changePercent === null || !Number.isFinite(item.changePercent)
                  ? 'unknown'
                  : item.changePercent > 0 ? 'good' : item.changePercent < 0 ? 'bad' : 'neutral'
              }
              label={item.changePercent === null ? 'ยังไม่มีค่า' : signedPercent(item.changePercent)}
              className="mt-0.5 text-xs"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The skeleton, at the height the strip actually occupies. */
export function MarketTodaySkeleton() {
  return (
    <div className="space-y-3" role="status" aria-label="กำลังโหลดภาพรวมตลาด">
      <div className="h-[86px] animate-pulse rounded-[var(--radius-mark)] bg-[var(--surface-elevated)] motion-reduce:animate-none" />
      <div className="h-5 w-2/3 animate-pulse rounded-[var(--radius-mark)] bg-[var(--surface-elevated)] motion-reduce:animate-none" />
    </div>
  );
}
