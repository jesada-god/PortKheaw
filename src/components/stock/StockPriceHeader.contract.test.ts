import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const header = readFileSync(join(process.cwd(), 'src/components/stock/StockPriceHeader.tsx'), 'utf8');
const detail = readFileSync(join(process.cwd(), 'src/components/stock/StockDetailClient.tsx'), 'utf8');

describe('StockPriceHeader integration contract', () => {
  it('does not fetch when currency or details change', () => {
    expect(header).not.toContain('fetch(');
    expect(header).toContain("onClick={() => setCurrency(item)}");
    expect(header).toContain('onClick={() => setDetailsOpen(true)}');
  });

  it('uses accessible, labelled status emoji and a shared modal', () => {
    expect(header).toContain('<StatusEmoji');
    expect(header).toContain('aria-hidden="true"');
    expect(header).toContain('<Modal');
    expect(header).toContain('aria-haspopup="dialog"');
  });

  it('discloses the provider, the session and every value with its own source', () => {
    expect(header).toContain('<Detail label="Provider"');
    expect(header).toContain('<Detail label="สถานะตลาด"');
    expect(header).toContain('<Detail label="Session Phase"');
    expect(header).toContain('<Detail label="ช่วงเวลาของราคา"');
    expect(header).toContain("label={quoteDate ? 'Trading date' : 'Timestamp'}");
    // Each canonical value is inspectable with the provider field it came from, so
    // "which number is this and where is it from" is always answerable.
    expect(header).toContain('<Detail label="Main Price Source"');
    expect(header).toContain('label="Regular Close"');
    expect(header).toContain('label="Previous Regular Close"');
    expect(header).toContain('comparisonBaseLabel(main.comparisonBaseKind)');
    expect(header).toContain('comparisonBaseLabel(secondary.comparisonBaseKind)');
    // The validation outcomes: a rejected value never disappears silently.
    expect(header).toContain('<Detail label="Data Validation"');
  });

  it('never uses a 1:1 FX fallback or a mock price', () => {
    expect(header).not.toContain('?? 1');
    expect(header.toLowerCase()).not.toContain('mock');
  });

  it('uses a mobile-safe Thai empty-price heading instead of a large Unavailable word', () => {
    expect(header).toContain("'ไม่พบราคาล่าสุด'");
    expect(header).toContain('text-[clamp(2.25rem,10vw,3.25rem)]');
    expect(header).toContain('whitespace-nowrap');
    expect(header).not.toContain("displayPrice === null ? 'Unavailable'");
  });

  it('uses the compact Investing-style price hierarchy and session rows', () => {
    // Material Symbols glyphs from the shared component, coloured by session tone.
    expect(header).toContain('<SessionIcon name={presentation.icon} tone={presentation.tone}');
    expect(header).toContain('name={extendedSessionPresentation(secondary.session).icon}');
    expect(header).toContain('data-testid="extended-hours-row"');
    // The extended row always carries its own trading date, so a Friday
    // after-hours print read on a Sunday cannot be mistaken for today.
    expect(header).toContain('data-testid="extended-hours-date"');
    expect(header).not.toContain('shadow-xl');
  });

  it('does not render fallback change placeholders or duplicate market errors', () => {
    expect(header).toContain('{mainChange && <div');
    // The secondary row exists only when the snapshot resolved a real print, so no
    // placeholder row and no fabricated 0.00% can be rendered.
    expect(header).toContain('{secondary && <div data-testid="extended-hours-row"');
    expect(header).not.toContain("stockDetailErrorMessage(marketError");
  });

  /**
   * The current-session bug guard, enforced on the source itself: the header is
   * presentation only. It must take the resolved session from the model and must
   * not re-derive one from a quote/candle/extended timestamp or a raw provider
   * status field.
   */
  it('performs no market-session, row or comparison-base inference of its own', () => {
    // Everything displayed is destructured from the ONE canonical snapshot model.
    expect(header).toContain('const { session: phase, main, secondary, presentation, snapshot } = model;');
    expect(header).toContain('presentation.icon');
    expect(header).not.toContain('deriveMarketSession');
    expect(header).not.toContain('currentStatus');
    expect(header).not.toContain('classifyUsEquityTimestamp');
    // The status is precomputed by the model; the component never re-derives it.
    expect(header).not.toContain('resolveDataStatus(');
  });

  /**
   * The imperative hot path writes straight to the main price DOM node, which is the
   * node the NVTS defect corrupted. Its gate must be the phase + the tick's own
   * timestamp — never a provider-supplied session string, which Alpaca never sends.
   */
  it('gates the transient price sink on the phase and the tick timestamp', () => {
    expect(header).toContain("if (phase !== 'REGULAR' || main.role !== 'regular') return;");
    expect(header).toContain("if (!metadata?.asOf || classifyUsEquitySession(metadata.asOf) !== 'regular') return;");
    // The old gate trusted `metadata.session`, which read `undefined` for Alpaca.
    expect(header).not.toContain("metadata?.session === 'after-hours'");
  });

  it('resolves the current session once, from the dedicated resolver only', () => {
    expect(detail).toContain('resolveCurrentMarketSession({');
    // And builds exactly ONE canonical snapshot, which the header renders from.
    expect(detail).toContain('resolveCanonicalMarketSnapshot({');
    expect(detail).toContain('snapshot: marketSnapshot');
    expect(detail).toContain('useExchangeClock(evaluatedAt)');
    expect(detail).toContain('applySymbolHalt(resolvedSession.session, halted)');
    // The defect: a live PRICE session (derived from a trade timestamp) was
    // promoted into the market-wide status and shown as "ตลาดเปิด".
    expect(detail).not.toContain('liveMarketStatus');
    expect(detail).not.toContain('effectiveMarket');
  });

  it('persists the last-known extended quote and evaluates freshness on the ticking clock', () => {
    expect(detail).toContain('preserveLastKnownExtendedQuote(');
    expect(detail).toContain('evaluatedAt: exchangeNow');
    expect(detail).toContain('evaluatedAt={exchangeNow}');
  });

  it('flashes the price on a live move without refetching, keyed on the source USD value', () => {
    // Flash is driven from the source USD price (regularPrice / extendedQuote.price),
    // so a USD/THB toggle never flashes — only a real tick does. No fetch is added.
    expect(header).toContain('usePriceFlash(mainPrice)');
    expect(header).toContain('usePriceFlash(secondary?.price ?? null)');
    expect(header).toContain('flashClass(priceFlash.direction)');
    expect(header).toContain('key={priceFlash.nonce}');
    expect(header).not.toContain('fetch(');
  });

  it('shows the intraday data timestamp with seconds precision', () => {
    expect(header).toContain('withSeconds: true');
  });

  it('does not render Bid or Ask in the stock price header', () => {
    expect(header).not.toContain('showBook');
    expect(header).not.toContain('displayBid');
    expect(header).not.toContain('displayAsk');
    expect(detail).not.toContain('bid={bid}');
    expect(detail).not.toContain('ask={ask}');
  });

  it('keeps Previous Close out of the Overview cards', () => {
    const overviewCards = detail.slice(detail.indexOf('function Overview'));
    expect(overviewCards).not.toContain("['Previous Close'");
  });

  it('does not render a technical reason inside every metric card', () => {
    const metricCard = detail.slice(
      detail.indexOf('function MetricCard'),
      detail.indexOf('function numberValue'),
    );
    expect(metricCard).not.toContain('reason');
    expect(metricCard).toContain("value ?? 'ไม่พบข้อมูล'");
  });
});
