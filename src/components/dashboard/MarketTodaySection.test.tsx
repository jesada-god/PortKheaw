// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKET_STATUS_INPUTS } from '@/src/config/market-status';
import { MARKET_ASSETS } from '@/src/lib/overview/market-assets';
import type { MarketIndexCard } from '@/src/lib/overview/types';
import type { OvIndexKey, OvIndexReading, OvMarketSnapshot } from '@/src/lib/market-overview/types';
import { OV_MARKET_STATUS_WORD, OV_REGIME_WORD } from '@/src/lib/market-overview/types';
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
    // A short intraday series, because a cell with no series draws no line at
    // all — which is a different case, asserted on its own below.
    sparkline: [99.2, 99.8, 100.4, 100.1, 100],
    name: asset.name,
    proxyLabel: asset.proxyLabel,
    subtitle: `${asset.symbol} · ${asset.proxyLabel}`,
  } as unknown as MarketIndexCard));
}

function renderStrip(overrides: Partial<Record<OvIndexKey, Partial<OvIndexReading>>> = {}) {
  act(() => root.render(<MarketTodayStrip snapshot={snapshot(overrides)} />));
  return container;
}

function renderSnapshot(patch: Partial<OvMarketSnapshot>) {
  act(() => root.render(<MarketTodayStrip snapshot={{ ...snapshot(), ...patch }} />));
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

  /*
    THIS TEST USED TO ASSERT THE OPPOSITE, and the reversal is the point.

    It read "stays a band rather than becoming a card again" and forbade a
    border and a radius on the cell, guarding the `.data-strip` band this
    section shipped as. The owner reversed that decision: the section's three
    grids now share one corner radius, so the guard is INVERTED rather than
    deleted — what is pinned down is still that the cell's box is deliberate,
    and only the decision it pins has changed.

    (The three `not.toMatch` lines this replaces could not fail. Their regexes
    were written with a literal 0x08 byte where `\b` was meant, so each was
    matching backspace-border-backspace and never the word. They are replaced
    with `toContain` on the token, which cannot be written wrong the same way.)

    The radius and the border are asserted as the TOKENS, never as pixels: a
    cell that hardcoded 14px would satisfy a value check and still be exactly
    the drift this exists to catch.
  */
  it('draws every cell as a card on the section’s one radius', () => {
    const cell = renderAssets().querySelector('[data-testid="market-asset-GC-F"]')!;
    expect(cell.className).toContain('rounded-[var(--radius-panel)]');
    expect(cell.className).toContain('border-[var(--border)]');
    // The affordance is untouched by the reversal.
    expect(cell.className).toContain('hover:bg-[var(--surface-hover)]');
    expect(cell.className).toContain('focus-visible:outline');
    // Still no elevation and no scale — a card that lifts is a different claim.
    expect(cell.className).not.toMatch(/shadow-/);
    expect(cell.className).not.toMatch(/scale-/);
  });

  /*
    The band's own edge had to go when the cells got corners: a rectangle drawn
    around eight rounded cards is a second, square frame around them.

    `.data-strip` is SHARED — the portfolio tracker and the stock detail metrics
    still draw bands with it — so this asserts the override happens HERE, in
    this file's markup, and not in `foundation.css` where it would silently
    reshape two other surfaces.
  */
  it('drops the band border in this markup, not in the shared class', () => {
    const strip = renderAssets().querySelector('.data-strip')!;
    expect(strip.className).toContain('border-0');
    expect(strip.className).toContain('gap-2');
    // The column geometry is still the shared class's.
    expect(strip.className).toContain('data-strip--flow');
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

describe('the asset cell carries the mark and the shape of the day', () => {
  /*
    Both were on the nine cards this band replaced and neither survived the
    rewrite. The data never stopped arriving — `loadMarketIndices` fetches
    5-minute closes for every row and the catalogue ships artwork for all nine —
    so what was lost was only the rendering.
  */
  it('puts the instrument mark in the same line as the name', () => {
    const band = renderAssets();
    for (const asset of MARKET_ASSETS) {
      const cell = band.querySelector(`[data-testid="market-asset-${asset.symbol}"]`)!;
      const label = cell.querySelector('.figure-label')!;
      const name = label.querySelector(`[data-testid="market-asset-${asset.symbol}-name"]`);
      const mark = label.querySelector('img, [role="img"]');
      // In the label, not above it — a row of its own would cost the cell
      // another sixteen pixels for an identifier rather than a fact.
      expect(mark, `${asset.symbol} has no mark`).not.toBeNull();
      expect(name?.textContent, asset.symbol).toBe(asset.name);
    }
  });

  it('never lets the mark be what gets cut when a name is long', () => {
    const cell = renderAssets().querySelector('[data-testid="market-asset-CL-F"]')!;
    const label = cell.querySelector('.figure-label')!;
    const name = label.querySelector('[data-testid="market-asset-CL-F-name"]')!;
    // A shortened name is readable; a cropped logo is not.
    expect(name.className).toContain('truncate');
    expect(label.className).toContain('min-w-0');
  });

  it('draws the day as a line under the percentage', () => {
    const band = renderAssets();
    for (const asset of MARKET_ASSETS) {
      const spark = band.querySelector(`[data-testid="market-asset-spark-${asset.symbol}"]`);
      expect(spark, `${asset.symbol} has no sparkline`).not.toBeNull();
      expect(spark!.tagName.toLowerCase()).toBe('svg');
      // Sixteen pixels, and no axis, no grid, no label inside it.
      expect(spark!.getAttribute('class')).toContain('h-4');
      expect(spark!.querySelectorAll('text, line, g')).toHaveLength(0);
      /*
        The signed percentage directly above states the same fact, so a second
        announcement of it is noise to a screen reader.
      */
      expect(spark!.getAttribute('aria-hidden')).toBe('true');
    }
  });

  /*
    THE COLOUR IS THE READING. A line that were merely tinted could disagree
    with the number above it, which is the one thing a chart beside a figure
    must never do.
  */
  it('colours the line by direction, the same three ways the number is marked', () => {
    const strokeFor = (changePercent: number | null) => {
      const [item] = assetCards().filter((card) => card.symbol === 'SPY');
      act(() => root.render(<MarketAssetStrip items={[{ ...item!, changePercent }]} />));
      return container
        .querySelector('[data-testid="market-asset-spark-SPY"] polyline')!
        .getAttribute('stroke');
    };
    expect(strokeFor(1.2)).toBe('var(--positive)');
    expect(strokeFor(-1.2)).toBe('var(--negative)');
    expect(strokeFor(0)).toBe('var(--text-muted)');
    expect(strokeFor(null)).toBe('var(--text-muted)');
  });

  /*
    A single point is not a line, and drawing a flat rule across the cell would
    say "did not move" — a claim about the market, where the truth is an absence
    of data. The watchlist and portfolio paths still hardcode `sparkline: []`,
    so this is a state the band will meet.
  */
  it('draws nothing at all rather than a flat rule when there is no series', () => {
    const [item] = assetCards().filter((card) => card.symbol === 'SPY');
    for (const sparkline of [[], [761.78]]) {
      act(() => root.render(<MarketAssetStrip items={[{ ...item!, sparkline }]} />));
      expect(container.querySelector('[data-testid="market-asset-spark-SPY"]')).toBeNull();
      // The cell itself is untouched: the price and the percentage still print.
      expect(container.querySelector('[data-testid="market-asset-SPY"]')!.textContent)
        .toContain('100.00');
    }
  });
});

describe('the two readings say what each of them measures', () => {
  /*
    THE BUG THIS REPLACES, exactly as a reader met it:

        ● ตลาดไปทางลบ  กลาง ๆ
        ทั้งสามตัวยังไม่ขยับเกินเกณฑ์

    One coloured dot on a line carrying two answers to two different questions,
    and the dot belonged to the first. The second had no mark of its own, so the
    line read as a single self-contradicting sentence — and the reason under it,
    which describes the risk trio and has never described the status word, read
    as the explanation for the verdict it sat beneath.
  */
  it('names both readings, so neither is read as the other', () => {
    const block = renderSnapshot({ status: 'down', regime: 'neutral' });
    const direction = block.querySelector('[data-testid="market-today-status"]')!;
    const money = block.querySelector('[data-testid="market-today-regime"]')!;
    expect(direction.textContent).toContain('ทิศทาง');
    expect(direction.textContent).toContain(OV_MARKET_STATUS_WORD.down);
    expect(money.textContent).toContain('เงินรอบตลาด');
    expect(money.textContent).toContain(OV_REGIME_WORD.neutral);
    // The names have to differ, or naming them achieves nothing.
    expect(direction.textContent).not.toContain('เงินรอบตลาด');
  });

  it('gives the regime a mark of its own instead of borrowing the status mark', () => {
    const block = renderSnapshot({ status: 'down', regime: 'neutral' });
    const direction = block.querySelector('[data-testid="market-today-status"] [data-status]')!;
    const money = block.querySelector('[data-testid="market-today-regime"] [data-status]')!;
    expect(direction.getAttribute('data-status')).toBe('bad');
    expect(money.getAttribute('data-status')).toBe('neutral');
  });

  it.each([
    ['risk_on', 'good'],
    ['neutral', 'neutral'],
    ['risk_off', 'bad'],
  ] as const)('marks %s as %s', (regime, level) => {
    const block = renderSnapshot({ status: 'down', regime });
    const money = block.querySelector('[data-testid="market-today-regime"] [data-status]')!;
    expect(money.getAttribute('data-status')).toBe(level);
  });

  /*
    The reason line belongs to the regime and to nothing else. Asserted by
    CONTAINMENT rather than by order, because "underneath" is what it looked
    like before too — it was a sibling of the status row, and that is precisely
    how it came to be read as the status word's explanation.
  */
  it('puts the reasons inside the regime row, not beside the status word', () => {
    const block = renderSnapshot({
      status: 'down',
      regime: 'neutral',
      regimeReasons: ['VIX พันธบัตร ดอลลาร์ ยังไม่ขยับเกินเกณฑ์'],
    });
    const reasons = block.querySelector('[data-testid="market-today-reasons"]')!;
    expect(block.querySelector('[data-testid="market-today-regime"]')!.contains(reasons)).toBe(true);
    expect(block.querySelector('[data-testid="market-today-status"]')!.contains(reasons)).toBe(false);
    expect(reasons.textContent).toContain('VIX');
  });

  /*
    VIX or the ten-year unreadable withholds the regime, but the lines saying
    WHICH are still worth printing — and before this they printed with no header
    at all, which is the orphaning the change exists to end.
  */
  it('keeps a headed row for the reasons when the regime is withheld', () => {
    const block = renderSnapshot({
      status: 'down',
      regime: null,
      regimeReasons: ['ความกังวลของตลาด ยังไม่มีข้อมูล'],
    });
    const money = block.querySelector('[data-testid="market-today-regime"]')!;
    expect(money.textContent).toContain('เงินรอบตลาด');
    expect(money.querySelector('[data-status]')!.getAttribute('data-status')).toBe('unknown');
    expect(money.textContent).toContain('ความกังวลของตลาด ยังไม่มีข้อมูล');
  });

  it('draws no money row at all when there is neither a regime nor a reason', () => {
    const block = renderSnapshot({ status: 'down', regime: null, regimeReasons: [] });
    expect(block.querySelector('[data-testid="market-today-regime"]')).toBeNull();
    expect(block.querySelector('[data-testid="market-today-status"]')).not.toBeNull();
  });

  /*
    Both markers are read by `phase2-flag-manifest.mjs` and by
    `overview-phase2-qa.mjs` to decide whether the flag reached the page, so
    they have to survive a rewrite of what renders them.
  */
  it('keeps the markers the flag checker looks for', () => {
    const block = renderSnapshot({
      status: 'down',
      regime: 'neutral',
      regimeReasons: ['VIX พันธบัตร ดอลลาร์ ยังไม่ขยับเกินเกณฑ์'],
    });
    for (const marker of ['market-today-strip', 'market-today-status', 'market-today-reasons']) {
      expect(block.querySelector(`[data-testid="${marker}"]`), marker).not.toBeNull();
    }
  });
});
