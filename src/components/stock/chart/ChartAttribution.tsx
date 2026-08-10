import { LIGHTWEIGHT_CHARTS_NOTICE } from '@/src/lib/legal/open-source';

/**
 * One line of credit under the chart.
 *
 * Lightweight Charts is Apache-2.0 with one condition on top: the attribution
 * notice from the upstream NOTICE file, plus a link to tradingview.com, has to
 * reach the user. The library collects that itself by drawing a mark inside the
 * plot (`layout.attributionLogo`), and upstream says a product meeting the
 * requirement elsewhere may switch the mark off.
 *
 * So the debt is split rather than dodged. The link — the half that belongs next
 * to the thing it credits — is here, on the product name, under every chart. The
 * notice text, the version and the licence live on `/open-source`, which is
 * reachable from Settings. Together they are what lets both chart hosts pass
 * `attributionLogo: false`; neither half may quietly disappear, which is why
 * this is rendered unconditionally and tested from both ends.
 *
 * Painted from theme tokens, not the surrounding panels' `slate-*`, so it stays
 * legible in the light appearance without another entry in the palette
 * compatibility map.
 */

export const CHART_ATTRIBUTION_PREFIX = 'Charts powered by';
export const TRADINGVIEW_URL = LIGHTWEIGHT_CHARTS_NOTICE.homepage;
export const TRADINGVIEW_PRODUCT = LIGHTWEIGHT_CHARTS_NOTICE.name;

export function ChartAttribution({ className = '' }: { className?: string }) {
  return (
    <p
      className={`text-[11px] leading-5 break-words text-[var(--text-muted)] ${className}`.trim()}
      data-testid="chart-attribution"
    >
      {CHART_ATTRIBUTION_PREFIX}{' '}
      <a
        href={TRADINGVIEW_URL}
        target="_blank"
        rel="noreferrer"
        className="underline underline-offset-2 hover:text-[var(--text)]"
      >
        {TRADINGVIEW_PRODUCT}
      </a>
    </p>
  );
}

export default ChartAttribution;
