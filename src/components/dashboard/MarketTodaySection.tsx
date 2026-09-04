import Link from 'next/link';
import { MARKET_STATUS_INPUTS } from '@/src/config/market-status';
import { inputStatusLevel } from '@/src/lib/market-status/presentation';
import {
  OV_MARKET_STATUS_LEVEL,
  OV_MARKET_STATUS_WORD,
  OV_REGIME_LEVEL,
  OV_REGIME_WORD,
  type OvIndexKey,
  type OvIndexReading,
  type OvMarketSnapshot,
} from '@/src/lib/market-overview/types';
import { InstrumentLogo } from '@/src/components/instruments/InstrumentLogo';
import { StatusLabel } from '@/src/components/ui/StatusLabel';
import type { StatusLevel } from '@/src/lib/presentation/status';
import { cn } from '@/src/utils/cn';
import { stockDetailHref } from '@/src/lib/instruments/routes';
import { proxyDisclosureTh } from '@/src/lib/overview/market-assets';
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

/**
 * ONE CELL, TAPPABLE WHEN THERE IS SOMEWHERE TO GO.
 *
 * The nine cards this section replaced were each a single anchor to the
 * instrument's own page, and the strip that replaced them was nine `<div>`s —
 * a reader who tapped a price got nothing. This puts the anchor back ON THE
 * CELL rather than around a card: same class, same padding, same height, so the
 * band stays a band. The hairlines are `box-shadow` on the cell and are
 * unaffected by what element draws them.
 *
 * `href === null` renders a plain `<div>`, and that is a deliberate state, not
 * a fallback. A cell that looks tappable and opens a page with no price on it
 * is worse than one that does not invite the tap — see `MarketTodayStrip`,
 * where the six instruments have no detail page today.
 */
function StripCell({
  href,
  ariaLabel,
  testId,
  children,
}: {
  href: string | null;
  ariaLabel?: string;
  testId: string;
  children: React.ReactNode;
}) {
  if (href === null) {
    return <div className="data-strip__cell min-w-0" data-testid={testId}>{children}</div>;
  }
  return (
    <Link
      href={href}
      aria-label={ariaLabel}
      data-testid={testId}
      /*
        Enter is native to a link; Space is not — it scrolls the page. Readers
        who arrive by keyboard try both, so Space is claimed and turned into the
        same navigation. Carried over from the card this cell replaced, where it
        was there for the same reason.
      */
      onKeyDown={(event) => {
        if (event.key !== ' ' && event.key !== 'Spacebar') return;
        event.preventDefault();
        event.currentTarget.click();
      }}
      /*
        The hover tint and the focus ring are the whole of the affordance. No
        border, no elevation, no scale — any of those would rebuild the card
        this band exists to be lighter than.
      */
      className="data-strip__cell block min-w-0 transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)] active:bg-[var(--surface-selected)]"
    >
      {children}
    </Link>
  );
}

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
    /*
      NO DESTINATION, SO NO INVITATION.

      A live probe of `loadStockDetailGatewaySnapshot` against all six symbols —
      `^GSPC`, `^NDX`, `^DJI`, `^VIX`, `^TNX`, `DX-Y.NYB` — returns a page with
      no price on it: "Symbol is not present in market_instruments", which lists
      US-listed securities and holds none of these. The route does not 404, it
      renders empty, which is the worse of the two failures because the reader
      has already spent the tap. When those rows exist, this becomes an href.
    */
    <StripCell href={null} testId={`market-today-${reading.key}`}>
      <span className="figure-label truncate">{reading.labelTh}</span>
      {/*
        WHEN THE NUMBER IS NOT THE THING THE LABEL NAMES, THE CELL SAYS SO.

        Null for all six today, because all six quote the instrument they name —
        so this renders nothing and costs the cell no height. It is here for the
        day a provider forces a stand-in back: `proxyLabelTh` is the only place
        the product can admit one, and a field that no screen reads is a comment
        pretending to be a contract. The reading carried it end to end and the
        cell dropped it, which is how "หุ้นสหรัฐฯ 500 ตัวใหญ่" came to sit over a
        fund's share price with nothing saying which was which.

        Smaller and quieter than the percentage below it. A disclosure that
        competed with the number would be answering a question the reader has
        not asked yet.
      */}
      {reading.proxyLabelTh && (
        <span
          className="mt-0.5 block truncate text-[10px] leading-4 text-[var(--text-muted)]"
          data-testid={`market-today-proxy-${reading.key}`}
        >
          {reading.proxyLabelTh}
        </span>
      )}
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
    </StripCell>
  );
}

/**
 * ONE READING, AS A PANEL.
 *
 * The eyebrow names the question, the value answers it, and the panel's own
 * edge is what says the two belong together — which is the whole reason this
 * is a box rather than the `StatusRow` line it replaced: two rows in a stack
 * read as two lines of one paragraph, and a reader who skims them takes the
 * second as a qualifier on the first.
 *
 * `--surface-elevated` and `--border` are the same pair `.inset` uses in
 * `foundation.css`, so the panels sit inside the section at the tint every
 * other sub-region of a section already has, in both appearances. NEVER a tint
 * by level: the value's own colour is the only place the reading is stated, and
 * a panel that painted itself would say it a second time and louder.
 */
function ReadingPanel({
  eyebrow,
  testId,
  className,
  children,
}: {
  eyebrow: string;
  testId: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        'min-w-0 rounded-[var(--radius-panel)] border border-[var(--border)] bg-[var(--surface-elevated)] p-3',
        className,
      )}
    >
      {/*
        Small, spaced and muted, because it is the QUESTION and not the answer.
        `uppercase` does nothing to the Thai half and everything to the English
        one, which is the point of carrying both: the gloss is what a reader
        scanning for "Direction" or "Momentum" actually lands on.
      */}
      <span className="block truncate text-[10px] font-semibold uppercase leading-4 tracking-[0.08em] text-[var(--text-muted)]">
        {eyebrow}
      </span>
      {children}
    </div>
  );
}

/**
 * The word the panel is for, at the size that makes it the answer.
 *
 * `StatusLabel` and not a coloured `<span>`: the mark, the five-level colour
 * token and the `data-status` attribute all come from the one component the
 * rest of the product reads statuses through, so this panel cannot drift from
 * the strip above it or from the stock page. Only the SIZE is set here.
 */
function ReadingValue({ level, label }: { level: StatusLevel; label?: string }) {
  return (
    <StatusLabel
      level={level}
      label={label}
      className="mt-1 text-base leading-6 [&>span]:font-bold"
    />
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
  /*
    The money panel exists when there is either a regime or a reason to
    print — the same predicate the row it replaced used, unchanged. When it
    does not, the direction panel takes both columns rather than leaving a
    half-width gap that reads as a second panel still loading.
  */
  const showMoney = snapshot.regime !== null || snapshot.regimeReasons.length > 0;
  return (
    <div className="min-w-0" data-testid="market-today-strip">
      <div className="data-strip-scroll bleed-mobile px-[var(--page-gutter)] sm:px-0">
        <div className="data-strip data-strip--6">
          {readings.map((reading) => <ReadingCell key={reading.key} reading={reading} />)}
        </div>
      </div>
      {/*
        TWO READINGS, EACH SAYING WHAT IT MEASURES — NOW AS TWO PANELS.

        These were one line: a status word with a coloured mark, and the regime
        beside it as bare secondary text. That put two answers to two different
        questions under one dot — and the dot belonged to the first. "🔴 ตลาด
        ไปทางลบ  กลาง ๆ" reads as a single sentence contradicting itself, when
        it is really "the six instruments point down" followed by "the three
        that price risk are not alarmed", which is a coherent and useful day.

        Naming them as two `StatusRow`s fixed the ambiguity but left them
        reading as two lines of one paragraph. Two panels side by side say it in
        the layout as well as in the words: equal width, equal weight, one
        question each. The eyebrow carries the Thai name and its English gloss,
        so the subject is stated before the word that answers it.

        THE COLOUR IS STILL `StatusLabel`'S AND NOTHING ELSE'S. The panel is
        `--surface-elevated` in both appearances and never tints itself by
        level: a card that painted itself green would be the wall of coloured
        boxes the status vocabulary exists to replace, and it would state the
        reading twice.

        `status === null` means the equity inputs were not all readable, and the
        honest answer is to say so rather than to soften the word — the numbers
        above still print whatever did arrive. It spans both columns, because a
        half-width panel beside an empty track reads as a panel that failed to
        load rather than as the only reading there is.
      */}
      <div className="mt-3 grid grid-cols-2 gap-3.5">
        {status === null ? (
          <ReadingPanel
            eyebrow="ทิศทาง · Market Direction"
            testId="market-today-status"
            className="col-span-2"
          >
            <ReadingValue level="unknown" label="ยังอ่านภาพรวมตลาดไม่ได้" />
          </ReadingPanel>
        ) : (
          <>
            <ReadingPanel
              eyebrow="ทิศทาง · Market Direction"
              testId="market-today-status"
              className={showMoney ? undefined : 'col-span-2'}
            >
              <ReadingValue
                level={OV_MARKET_STATUS_LEVEL[status]}
                label={OV_MARKET_STATUS_WORD[status]}
              />
            </ReadingPanel>
            {showMoney && (
              <ReadingPanel eyebrow="เงินรอบตลาด · Market Momentum" testId="market-today-regime">
                {/*
                  A WITHHELD REGIME IS STILL A PANEL, BECAUSE THE REASONS ARE.

                  VIX or the ten-year unreadable means no regime — but the lines
                  saying which one is missing are exactly what a reader needs,
                  and before this they printed with no header at all, which is
                  the orphaning this change exists to end. `unknown` and its own
                  fallback word, so nothing new is invented to say it.
                */}
                <ReadingValue
                  level={snapshot.regime === null ? 'unknown' : OV_REGIME_LEVEL[snapshot.regime]}
                  label={snapshot.regime === null ? undefined : OV_REGIME_WORD[snapshot.regime]}
                />
                {/*
                  INSIDE THE PANEL IT EXPLAINS, AND ONLY THAT PANEL.

                  Every line `ovRegime` produces is about VIX, the ten-year and
                  the dollar. It used to sit under the status word instead, where
                  it read as the reason for a verdict it has never described —
                  and on a flat day it said "ทั้งสามตัว" beneath six printed
                  figures. The panel's own edge states the subordination now, so
                  the indent that used to imply it is gone.

                  Two or three measurements and nothing else: each is an
                  instrument and a signed percentage, so a reader can disagree
                  with the word above by reading the numbers that produced it.
                */}
                {snapshot.regimeReasons.length > 0 && (
                  <p
                    className="mt-1.5 text-xs leading-5 text-[var(--text-muted)]"
                    data-testid="market-today-reasons"
                  >
                    {snapshot.regimeReasons.slice(0, 3).join(' · ')}
                  </p>
                )}
              </ReadingPanel>
            )}
          </>
        )}
      </div>
      {snapshot.stale && (
        <p className="mt-1 text-[11px] leading-4 text-[var(--text-muted)]" data-testid="market-today-stale">
          {formatMarketDataAsOf(snapshot.evaluatedAt)} · กำลังอัปเดต
        </p>
      )}
    </div>
  );
}

/**
 * THE DAY, AS A LINE, IN SIXTEEN PIXELS.
 *
 * Not `MiniLine`. That one is forty pixels tall and belongs to a 238px card
 * where it is a feature of the card; forty pixels in a cell of this band is a
 * forty percent tax on the height the band exists to save, and the band would
 * stop being a band. This draws the same closes at the height a cell can pay
 * for, with no axis, no grid, no label and no baseline — the shape of the day
 * and nothing else.
 *
 * `preserveAspectRatio="none"` because the box is six to one and the viewBox is
 * not; letting it letterbox would leave the line floating in the middle of
 * dead space. `vectorEffect="non-scaling-stroke"` is what keeps the stroke
 * 1.5px after that stretch instead of a smeared wedge.
 *
 * THE COLOUR IS THE READING, NOT DECORATION. It is the same three-way the
 * signed percentage directly above takes — up, down, or neither — so the line
 * and the number can never disagree. That also makes the line redundant to a
 * screen reader, which is why it is `aria-hidden`: the percentage above it has
 * already said the fact, and "กราฟราคาระหว่างวัน" would only add a second
 * announcement of the same thing.
 *
 * Fewer than two points is no line at all rather than a dot or a flat rule — a
 * horizontal stroke across a cell reads as "did not move", which is a claim
 * about the market and not an absence of data.
 */
function CellSparkline({ values, changePercent, symbol }: {
  values: readonly number[];
  changePercent: number | null;
  symbol: string;
}) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * 100;
    const y = 15 - ((value - min) / span) * 14;
    return `${x},${y}`;
  }).join(' ');
  const stroke = changePercent === null || !Number.isFinite(changePercent)
    ? 'var(--text-muted)'
    : changePercent > 0 ? 'var(--positive)' : changePercent < 0 ? 'var(--negative)' : 'var(--text-muted)';
  return (
    <svg
      viewBox="0 0 100 16"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
      className="mt-1 block h-4 w-full"
      data-testid={`market-asset-spark-${symbol}`}
    >
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * The assets the band above has not already stated, compact.
 *
 * They were nine cards; a card each is what made the market block the tallest
 * thing on the page. The same rows, in the same order, in the same strip shape
 * as the six above — so the section reads as one market with two bands rather
 * than as two sections that happen to be adjacent.
 *
 * WHAT IS REMOVED IS ONLY WHAT IS SAID TWICE. Three of the catalogue's rows are
 * SPY, QQQ and DIA — the funds tracking the three indices the band above quotes
 * directly — so drawing them here printed the S&P as 7,631 and again as 761.78,
 * ten pixels apart. The caller filters them by meaning rather than by symbol;
 * see `assetsOutsideMarketStatus`. Gold, silver, crude, Russell, rare earths and
 * Bitcoin are all still here, quieter and not gone, and with the flag off the
 * section still draws all nine as cards.
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
          <StripCell
            key={item.symbol}
            href={stockDetailHref(item.symbol)}
            ariaLabel={`เปิดรายละเอียด ${item.name} (${item.symbol})`}
            testId={`market-asset-${item.symbol}`}
          >
            {/*
              The mark sits IN the label's line, not above it.

              A row of its own would cost the cell another sixteen pixels for
              something that is an identifier rather than a fact — and the name
              beside it is what the mark identifies, so separating them makes
              the reader join two rows to answer one question. `shrink-0` on the
              logo and `truncate` on the name mean the mark is never what gets
              cut: a nameless logo is unreadable, a shortened name is not.
            */}
            <span className="figure-label flex min-w-0 items-center gap-1.5">
              <InstrumentLogo
                symbol={item.symbol}
                companyName={item.instrument.companyName}
                logoUrl={item.instrument.logoUrl}
                size={16}
                appearance="plain"
              />
              <span className="truncate" data-testid={`market-asset-${item.symbol}-name`}>
                {item.name}
              </span>
            </span>
            {/*
              The same disclosure the nine cards used to carry in their subtitle
              and this strip lost when it replaced them. "ทองคำ" over a number is
              a front-month COMEX contract, and "แร่หายาก" is a fund holding
              miners; a reader comparing either figure against a price quoted
              anywhere else needs to know that before they conclude one of them
              is wrong. `proxyDisclosureTh` is the single predicate both bands
              ask, so Bitcoin — which IS the asset — stays unqualified here for
              the same reason the six above do.
            */}
            {proxyDisclosureTh(item.proxyLabel) && (
              <span
                className="mt-0.5 block truncate text-[10px] leading-4 text-[var(--text-muted)]"
                data-testid={`market-asset-proxy-${item.symbol}`}
              >
                {proxyDisclosureTh(item.proxyLabel)}
              </span>
            )}
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
            {/*
              Last, under the number it is the shape of. The nine cards each
              drew one and the strip that replaced them drew none; the data
              never stopped arriving — `loadMarketIndices` fetches 5-minute
              closes for every row, and the commodity and continuous loaders
              build theirs from candles they already hold.
            */}
            <CellSparkline
              values={item.sparkline}
              changePercent={item.changePercent}
              symbol={item.symbol}
            />
          </StripCell>
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
