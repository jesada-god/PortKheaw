'use client';

import { StatusLabel } from '@/src/components/ui/StatusLabel';
import { inputStatusLevel, marketStatusCopy } from '@/src/lib/market-status/presentation';
import type { MarketStatusEvaluation } from '@/src/lib/market-status/rules';

/**
 * The Market Status card.
 *
 * ===========================================================================
 * SIX REAL NUMBERS, ONE WORD, ONE SENTENCE
 * ===========================================================================
 * Every instrument prints its actual value and its actual move. That is the
 * point of the card: a reader can check any line of it against any other source
 * and find the same number. What they cannot find anywhere on it is the internal
 * score or a confidence percentage — those measure this product's weighting
 * table, not the market, and printing one would dress a judgement call as a
 * measurement.
 *
 * ===========================================================================
 * A PROXY IS LABELLED AS ONE, EVERY TIME
 * ===========================================================================
 * No row carries a proxy badge today, because no row is a proxy: all six quote
 * the instrument their label names. The three equity rows used to be SPY, QQQ
 * and DIA — funds tracking the indices, priced by their own order books and
 * carrying fees that make them drift — and they carried "กองทุนอ้างอิง" to say so.
 * They now quote `^GSPC`, `^NDX` and `^DJI`, so the badge would itself be the
 * false statement.
 *
 * The mechanism stays, and it is not decoration: the row prints whatever
 * `proxyLabelTh` holds, for any input. Should a provider ever force a stand-in
 * back, saying so is a config change and not a code change — because a reader
 * comparing this row against an index quoted elsewhere must never find two
 * different numbers with no way to tell which is wrong.
 *
 * ===========================================================================
 * THE MARK ON EACH ROW READS MEANING, NOT DIRECTION
 * ===========================================================================
 * A rising VIX gets 🔴, because the fear gauge going up is bad news even though
 * the number went up. `inputStatusLevel` applies each input's polarity for
 * exactly this. Colouring the arrow instead would make the one row that most
 * needs interpreting the one row that gets none.
 */
export function MarketStatusCard({
  evaluation,
  sessionDate,
}: {
  evaluation: MarketStatusEvaluation;
  /** Completed trading date the numbers are from, or null while the market is open. */
  sessionDate: string | null;
}) {
  const copy = marketStatusCopy(evaluation, sessionDate);

  return (
    <section className="panel min-w-0 p-4" data-testid="market-status-card">
      <div className="min-w-0">
        <p className="figure-label">ภาพรวมตลาด</p>
        <div className="mt-1 min-w-0">
          <StatusLabel
            level={copy.level}
            label={copy.headline}
            className="text-lg"
            data-testid="market-status-headline"
          />
        </div>
        {/*
          The subtitle is always drawn. It carries the regime when one could be
          established and says why not when it could not — an absent line would
          leave "the market has not picked a direction" and "we could not tell"
          looking identical.
        */}
        <p
          className="mt-1 text-xs leading-5 text-[var(--text-secondary)]"
          data-testid="market-status-subtitle"
        >
          {copy.subtitle}
        </p>
        {copy.asOfNote && (
          <p className="mt-0.5 text-[11px] leading-4 text-[var(--text-muted)]" data-testid="market-status-asof">
            {copy.asOfNote}
          </p>
        )}
      </div>

      <dl className="mt-4 grid min-w-0 grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        {evaluation.inputs.map((item) => {
          const level = inputStatusLevel(
            item.changePercent,
            item.input.polarity,
            item.input.flatBandPercent,
          );
          return (
            <div key={item.input.key} className="min-w-0" data-testid={`market-status-input-${item.input.key}`}>
              <dt className="min-w-0 text-xs text-[var(--text-muted)]">
                <span className="break-words">{item.input.labelTh}</span>
                {item.input.proxyLabelTh && (
                  <span className="ml-1 whitespace-nowrap rounded-full bg-[var(--surface-hover)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
                    {item.input.proxyLabelTh}
                  </span>
                )}
              </dt>
              <dd className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="figure break-all font-mono text-sm font-semibold text-[var(--text)]">
                  {/*
                    An unreadable input prints an em dash rather than a zero. A
                    zero is a reading — "this did not move" — and the two must
                    never look the same.
                  */}
                  {item.value === null ? '—' : formatValue(item.value)}
                </span>
                <StatusLabel
                  level={level}
                  label={item.changePercent === null ? 'ยังไม่มีค่า' : formatPercent(item.changePercent)}
                  className="text-xs"
                />
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

/*
  Locale pinned for the same reason every other figure in the product pins it: a
  bare `toLocaleString` follows whatever the runtime is set to, so the server and
  a th-TH browser render one number two ways and the hydrated DOM disagrees with
  the HTML it replaced.
*/
function formatValue(value: number): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}
