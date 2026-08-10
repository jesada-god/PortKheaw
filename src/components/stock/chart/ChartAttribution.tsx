/**
 * The attribution that Lightweight Charts' licence asks for, as a chart footer.
 *
 * The library is Apache-2.0 (`node_modules/lightweight-charts/LICENSE`, v5.2.0,
 * "Copyright 2023 TradingView, Inc."). Its README states one condition on top of
 * the licence text: the *attribution notice* from the upstream NOTICE file, plus
 * a link to <https://www.tradingview.com/>, has to appear on a page of the site
 * that is available to users.
 *
 * The library ships its own way to satisfy the *link* half — `attributionLogo`,
 * a mark drawn inside the plot — and says in the same sentence that a product
 * which already fulfils the requirement elsewhere may switch it off. This footer
 * is that elsewhere, which is what lets both chart hosts pass
 * `layout.attributionLogo: false`: the supported option, not a hidden element.
 * Nothing here may be conditionally rendered, collapsed behind a toggle or
 * `sr-only` — it has to stay legible wherever a chart is legible.
 *
 * The two notice lines are the upstream NOTICE **verbatim**. Note the copyright
 * glyph: upstream spells it with U+0441 (Cyrillic es), not the Latin "c", and
 * this file keeps that byte. It looks like a typo and is not ours to fix —
 * "correcting" it would stop reproducing the notice we are asked to reproduce.
 */

/** The link the licence requires. Also the tail of the NOTICE's second line. */
export const TRADINGVIEW_URL = 'https://www.tradingview.com/';

/** Line 1 of the upstream NOTICE, verbatim. */
export const TRADINGVIEW_NOTICE_PRODUCT = 'TradingView Lightweight Charts™';

/** Line 2 of the upstream NOTICE, verbatim minus the URL rendered as the link. */
export const TRADINGVIEW_NOTICE_COPYRIGHT = 'Copyright (с) 2025 TradingView, Inc.';

/** The licence the library is distributed under, named so a reader can find it. */
export const TRADINGVIEW_LICENSE_LABEL = 'Apache License 2.0';
export const TRADINGVIEW_LICENSE_URL = 'https://www.apache.org/licenses/LICENSE-2.0';

/*
 * Painted from theme tokens rather than the surrounding panels' `slate-*`, so it
 * stays legible in the light appearance without another entry in the palette
 * compatibility map. `break-words` because the notice carries a full URL and the
 * narrowest supported viewport is 320px — the footer wraps, the page does not
 * scroll sideways.
 */
const LINK = 'underline underline-offset-2 hover:text-[var(--text)]';

export function ChartAttribution({ className = '' }: { className?: string }) {
  return (
    <p
      className={`text-[11px] leading-5 break-words text-[var(--text-muted)] ${className}`.trim()}
      data-testid="chart-attribution"
    >
      {TRADINGVIEW_NOTICE_PRODUCT} · {TRADINGVIEW_NOTICE_COPYRIGHT}{' '}
      <a href={TRADINGVIEW_URL} target="_blank" rel="noreferrer" className={LINK}>
        {TRADINGVIEW_URL}
      </a>{' '}
      ·{' '}
      <a href={TRADINGVIEW_LICENSE_URL} target="_blank" rel="noreferrer" className={LINK}>
        {TRADINGVIEW_LICENSE_LABEL}
      </a>
    </p>
  );
}

export default ChartAttribution;
