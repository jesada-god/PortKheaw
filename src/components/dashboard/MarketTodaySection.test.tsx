// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKET_STATUS_INPUTS } from '@/src/config/market-status';
import { MARKET_ASSETS } from '@/src/lib/overview/market-assets';
import type { MarketIndexCard } from '@/src/lib/overview/types';
import type { OvIndexKey, OvIndexReading, OvMarketSnapshot } from '@/src/lib/market-overview/types';
import { MarketAssetStrip, MarketTodayStrip } from './MarketTodaySection';

/*
  A plain anchor, with the navigation swallowed. jsdom cannot follow a link and
  prints "Not implemented: navigation" when one is activated — which the Space
  test does on purpose — so the click is recorded and stopped here.
*/
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: {
    href: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        event.preventDefault();
        rest.onClick?.(event);
      }}
    >
      {children}
    </a>
  ),
}));

/**
 * THE TWO BANDS, RENDERED.
 *
 * Everything asserted here failed silently once already, and in the same shape:
 * a field that the pipeline carried end to end and the cell never printed. A
 * contract test that greps the source would have passed on all of it — the
 * strings were in the types, in the config and in the props. Only mounting the
 * component and reading `textContent` catches a value that arrives and is
 * dropped, so that is what these do.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** A snapshot built from the real input table, so a config change reaches it. */
function snapshot(overrides: Partial<Record<OvIndexKey, Partial<OvIndexReading>>> = {}): OvMarketSnapshot {
  const readings = Object.fromEntries(MARKET_STATUS_INPUTS.map((input) => [
    input.key,
    {
      key: input.key,
      symbol: input.symbol,
      labelTh: input.labelTh,
      proxyLabelTh: input.proxyLabelTh,
      value: 100,
      comparisonClose: 99,
      changePercent: 1.0101,
      asOf: '2026-09-01T20:00:00.000Z',
      ...overrides[input.key],
    } satisfies OvIndexReading,
  ])) as Record<OvIndexKey, OvIndexReading>;
  return {
    readings,
    status: 'up',
    availability: 'available',
    regime: 'risk_on',
    regimeReasons: [],
    missing: [],
    session: 'CLOSED',
    sessionDate: '2026-09-01',
    evaluatedAt: '2026-09-02T00:00:00.000Z',
    stale: false,
  };
}

/** An asset row per catalogue entry, carrying the catalogue's own proxy label. */
function assetCards(): MarketIndexCard[] {
  return MARKET_ASSETS.map((asset) => ({
    symbol: asset.symbol,
    instrument: { symbol: asset.symbol, companyName: asset.name, logoUrl: asset.logoUrl },
    price: 100,
    currency: 'USD',
    change: 1,
    changePercent: 1,
    session: 'CLOSED',
    sessionLabel: 'ปิดตลาด',
    status: 'closed',
    asOf: '2026-09-01T20:00:00.000Z',
    tradingDate: '2026-09-01',
    extended: null,
    freshness: null,
    sparkline: [],
    name: asset.name,
    proxyLabel: asset.proxyLabel,
    subtitle: `${asset.symbol} · ${asset.proxyLabel}`,
  } as unknown as MarketIndexCard));
}

function renderStrip(overrides: Partial<Record<OvIndexKey, Partial<OvIndexReading>>> = {}) {
  act(() => root.render(<MarketTodayStrip snapshot={snapshot(overrides)} />));
  return container;
}

function renderAssets(items = assetCards()) {
  act(() => root.render(<MarketAssetStrip items={items} />));
  return container;
}

describe('the six-instrument band admits a stand-in', () => {
  it('says nothing extra while every input quotes the thing its label names', () => {
    const band = renderStrip();
    // The state today: `proxyLabelTh` is null on all six, so no cell carries a
    // qualifier and none of them claims to be "the real thing" either.
    for (const input of MARKET_STATUS_INPUTS) {
      expect(band.querySelector(`[data-testid="market-today-proxy-${input.key}"]`)).toBeNull();
    }
    expect(band.textContent).not.toContain('อ้างอิง');
  });

  /*
    The regression this file exists for. `proxyLabelTh` was carried from the
    config through `OvIndexReading` into these props and then dropped, which is
    how a fund's share price came to sit under a label naming an index with
    nothing on screen saying so. Asserted through the component rather than the
    config, because the config was never the part that was wrong.
  */
  it('prints the qualifier in the cell the moment a reading carries one', () => {
    const band = renderStrip({ SPX: { proxyLabelTh: 'กองทุนอ้างอิง' } });
    const cell = band.querySelector('[data-testid="market-today-SPX"]')!;
    expect(cell.textContent).toContain('กองทุนอ้างอิง');
    // Still the label and the number, in that cell, unchanged.
    expect(cell.textContent).toContain(MARKET_STATUS_INPUTS[0].labelTh);
  });

  it('keeps the qualifier quieter than the figure it qualifies', () => {
    const band = renderStrip({ SPX: { proxyLabelTh: 'กองทุนอ้างอิง' } });
    const cell = band.querySelector('[data-testid="market-today-SPX"]')!;
    const note = cell.querySelector('[data-testid="market-today-proxy-SPX"]')!;
    const figure = cell.querySelector('.figure')!;
    expect(note.className).toContain('text-[10px]');
    expect(note.className).toContain('text-[var(--text-muted)]');
    // The number stays the heaviest thing in the cell.
    expect(figure.className).toContain('font-bold');
    expect(note.className).not.toContain('font-bold');
  });
});

describe('the asset band admits a stand-in', () => {
  it('qualifies a fund and a futures contract, and leaves the asset itself bare', () => {
    const band = renderAssets();
    const textOf = (symbol: string) =>
      band.querySelector(`[data-testid="market-asset-${symbol}"]`)!.textContent ?? '';

    // A fund tracking an index, and a fund holding miners.
    expect(textOf('SPY')).toContain('ETF อ้างอิง');
    expect(textOf('REMX')).toContain('ETF อ้างอิง');
    // The front-month contract that IS the world's reference price for gold —
    // still not the metal in a vault, and the card says which.
    expect(textOf('GC-F')).toContain('สัญญาล่วงหน้า');
    /*
      Bitcoin is the asset, quoted directly. "สินทรัพย์จริง" is not a disclosure
      but a boast, and its absence is the statement — the same silence the six
      instruments above keep for the same reason.
    */
    expect(textOf('BTC-USD')).not.toContain('สินทรัพย์จริง');
    expect(band.querySelector('[data-testid="market-asset-proxy-BTC-USD"]')).toBeNull();
  });

  it('prints a qualifier for every catalogue row that is standing in for something', () => {
    const band = renderAssets();
    for (const asset of MARKET_ASSETS) {
      const note = band.querySelector(`[data-testid="market-asset-proxy-${asset.symbol}"]`);
      if (asset.proxyLabel === 'สินทรัพย์จริง') expect(note, asset.symbol).toBeNull();
      else expect(note?.textContent, asset.symbol).toBe(asset.proxyLabel);
    }
  });
});

describe('a cell is tappable exactly when it has somewhere to go', () => {
  /*
    The regression this restores. Every one of these rows was a card, and every
    card was a single anchor to the instrument's own page; the strip that
    replaced them rendered `<div>`s, so a reader who tapped a price got nothing.
  */
  it('opens the instrument behind every asset cell', () => {
    const band = renderAssets();
    for (const asset of MARKET_ASSETS) {
      const cell = band.querySelector(`[data-testid="market-asset-${asset.symbol}"]`)!;
      expect(cell.tagName, asset.symbol).toBe('A');
      expect(cell.getAttribute('href'), asset.symbol)
        .toBe(`/stock/${encodeURIComponent(asset.symbol)}`);
      // Named for a screen reader, because the visible text is a price.
      expect(cell.getAttribute('aria-label'), asset.symbol).toContain(asset.name);
    }
  });

  it('stays a band rather than becoming a card again', () => {
    const cell = renderAssets().querySelector('[data-testid="market-asset-GC-F"]')!;
    // The same cell class, so the hairlines and the height are untouched.
    expect(cell.className).toContain('data-strip__cell');
    expect(cell.className).toContain('hover:bg-[var(--surface-hover)]');
    expect(cell.className).toContain('focus-visible:outline');
    // No border, no elevation, no scale — those would rebuild the card.
    expect(cell.className).not.toMatch(/rounded-2xl/);
    expect(cell.className).not.toMatch(/border/);
    expect(cell.className).not.toMatch(/shadow-/);
  });

  /*
    Space is not a link's native key — it scrolls the page — and readers who
    arrive by keyboard try it. The card this cell replaced claimed it, and so
    does the cell.
  */
  it('navigates on Space as well as Enter', () => {
    const cell = renderAssets().querySelector('[data-testid="market-asset-BTC-USD"]') as HTMLElement;
    let clicked = false;
    cell.addEventListener('click', () => { clicked = true; });
    act(() => {
      cell.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(clicked).toBe(true);
  });

  /*
    A live probe of `loadStockDetailGatewaySnapshot` against all six instrument
    symbols returns a page carrying no price: "Symbol is not present in
    market_instruments". The route does not 404 — it renders empty — which is
    the worse failure, because the reader has already spent the tap. So these
    cells are deliberately not anchors, and this pins that until the rows exist.
  */
  it('does not invite a tap on the six instruments, which have no page yet', () => {
    const band = renderStrip();
    for (const input of MARKET_STATUS_INPUTS) {
      const cell = band.querySelector(`[data-testid="market-today-${input.key}"]`)!;
      expect(cell.tagName, input.key).toBe('DIV');
      expect(cell.getAttribute('href'), input.key).toBeNull();
    }
  });
});
