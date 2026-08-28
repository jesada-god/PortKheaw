// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MARKET_STATUS_INPUTS } from '@/src/config/market-status';
import { CARD_MUST_NOT_SAY, NEVER_SAY } from '@/src/lib/presentation/banned-copy';
import { evaluateMarketStatus, type MarketStatusReading } from '@/src/lib/market-status/rules';
import { MarketStatusCard } from './MarketStatusCard';

/**
 * The card, RENDERED — not read as source text.
 *
 * A contract test that greps the component file proves a string is present in a
 * file; it cannot tell whether the string reaches a reader, whether the branch
 * that prints it is reachable, or whether a `null` slipped through as the text
 * "null". Everything here mounts the real component into a real DOM and asserts
 * on `textContent`, so what is checked is what a reader would see.
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

function readings(moves: Partial<Record<string, number | null>>): MarketStatusReading[] {
  return MARKET_STATUS_INPUTS.map((input) => {
    const percent = moves[input.key] ?? (moves[input.key] === undefined ? 0 : null);
    return {
      key: input.key,
      value: percent === null ? null : 100 * (1 + percent / 100),
      comparisonClose: percent === null ? null : 100,
    };
  });
}

function render(moves: Partial<Record<string, number | null>>, sessionDate: string | null = null) {
  const evaluation = evaluateMarketStatus(readings(moves));
  act(() => root.render(<MarketStatusCard evaluation={evaluation} sessionDate={sessionDate} />));
  return container.querySelector('[data-testid="market-status-card"]') as HTMLElement;
}

const UP = { SPX: 1.5, NDX: 1.8, DJI: 1.5, VIX: -15, US10Y: -4, DXY: -1.2 };

describe('the rendered card', () => {
  it('mounts and prints a status a reader can see', () => {
    const card = render(UP);
    expect(card).not.toBeNull();
    expect(card.textContent).toContain('ตลาดกำลังไปต่อ');
    expect(card.textContent).toContain('เงินไหลเข้าสินทรัพย์เสี่ยง');
  });

  it('prints a real number for every one of the six inputs', () => {
    const card = render(UP);
    for (const input of MARKET_STATUS_INPUTS) {
      const row = card.querySelector(`[data-testid="market-status-input-${input.key}"]`);
      expect(row, `${input.key} has no row`).not.toBeNull();
      // A real figure, not a dash and not an empty cell.
      expect(row!.textContent).toMatch(/\d/);
      expect(row!.textContent).toContain(input.labelTh);
    }
  });

  it('labels every proxy as a proxy, and marks no direct instrument as one', () => {
    /*
      SPY is not the S&P 500. A reader comparing this row against an index quoted
      anywhere else must be able to see why the numbers differ.
    */
    const card = render(UP);
    for (const input of MARKET_STATUS_INPUTS) {
      const row = card.querySelector(`[data-testid="market-status-input-${input.key}"]`)!;
      if (input.proxyLabelTh) expect(row.textContent).toContain(input.proxyLabelTh);
      else expect(row.textContent).not.toContain('อ้างอิง');
    }
  });

  it('marks a rising fear gauge red and a rising index green', () => {
    // The mark reads the MEANING of the move, not its arrow.
    const card = render({ SPX: 1.5, NDX: 1.8, DJI: 1.5, VIX: 20, US10Y: 0, DXY: 0 });
    const vix = card.querySelector('[data-testid="market-status-input-VIX"] [data-status]')!;
    const spx = card.querySelector('[data-testid="market-status-input-SPX"] [data-status]')!;
    expect(vix.getAttribute('data-status')).toBe('bad');
    expect(spx.getAttribute('data-status')).toBe('good');
  });

  it('shows an em dash and an unknown mark for an input it could not read', () => {
    const card = render({ ...UP, DXY: null });
    const row = card.querySelector('[data-testid="market-status-input-DXY"]')!;
    expect(row.textContent).toContain('—');
    expect(row.querySelector('[data-status]')!.getAttribute('data-status')).toBe('unknown');
  });

  it('replaces the status with ข้อมูลไม่ครบ when an equity input is missing', () => {
    const card = render({ ...UP, SPX: null });
    expect(card.textContent).toContain('ข้อมูลไม่ครบ');
    // Never both at once.
    expect(card.textContent).not.toContain('ตลาดกำลังไปต่อ');
    expect(card.textContent).not.toContain('ตลาดทรงตัว');
    const headline = card.querySelector('[data-testid="market-status-headline"]')!;
    expect(headline.getAttribute('data-status')).toBe('unknown');
  });

  it('names the day when the numbers are a completed close', () => {
    const card = render(UP, '2025-08-29');
    expect(card.textContent).toContain('ราคาปิดของวันศุกร์ที่ 29 ส.ค. 2025');
  });

  it('carries no day line while the market is open', () => {
    const card = render(UP, null);
    expect(card.querySelector('[data-testid="market-status-asof"]')).toBeNull();
  });

  it('never leaks a null, an undefined or a NaN into the rendered text', () => {
    for (const moves of [UP, { ...UP, SPX: null }, { ...UP, VIX: null }, {}]) {
      const card = render(moves);
      for (const leak of ['null', 'undefined', 'NaN', 'Infinity', '[object']) {
        expect(card.textContent, `leaked ${leak}`).not.toContain(leak);
      }
    }
  });

  it('never renders a score or a confidence percentage', () => {
    /*
      The six prices and their moves are the only numbers allowed. A percentage
      appears exactly as many times as there are readable inputs — one per row —
      so an extra one would be a score or a confidence figure that escaped.
    */
    const card = render(UP);
    const percentages = (card.textContent ?? '').match(/%/g) ?? [];
    expect(percentages).toHaveLength(MARKET_STATUS_INPUTS.length);
  });

  it('says nothing from either banned-copy list, in any state', () => {
    for (const moves of [UP, { ...UP, SPX: null }, { ...UP, US10Y: null }, {}]) {
      const text = render(moves).textContent ?? '';
      for (const word of CARD_MUST_NOT_SAY) expect(text).not.toContain(word);
      for (const phrase of NEVER_SAY) expect(text).not.toContain(phrase);
    }
  });

  it('keeps every figure inside a container that can scroll rather than widening the page', () => {
    // The card sits in the overview grid on a 320px handset; a row that cannot
    // wrap pushes the whole page sideways.
    const card = render(UP);
    expect(card.className).toContain('min-w-0');
    for (const input of MARKET_STATUS_INPUTS) {
      const row = card.querySelector(`[data-testid="market-status-input-${input.key}"]`)!;
      expect(row.className).toContain('min-w-0');
    }
  });
});
