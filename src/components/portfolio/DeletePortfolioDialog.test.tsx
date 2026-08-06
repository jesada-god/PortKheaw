// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeletePortfolioDialog } from './DeletePortfolioDialog';
import type { PortfolioDeletionSummary } from '@/src/lib/portfolio/transfer/service';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The dialog is the last thing between a reader and a deleted portfolio, so
 * what it refuses to do matters more than what it shows. Each case here is one
 * of those refusals.
 */

function summary(overrides: Partial<PortfolioDeletionSummary> = {}): PortfolioDeletionSummary {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'พอร์ตทดลอง',
    type: 'STOCK',
    isLegacy: false,
    totalValue: 12_345,
    cashBalance: 500,
    hasNegativeCash: false,
    openHoldings: 2,
    openOptionPositions: 1,
    transactionCount: 17,
    hasTransferableAssets: true,
    destinations: [{ id: 'dest', name: 'พอร์ตปลายทาง', type: 'STOCK' }],
    isLastActive: false,
    replacementWritableName: null,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
let confirmed: string[];
let transferRequests: number;

const money = (value: number | string | null) => value === null ? '—' : `$${Number(value).toFixed(2)}`;

function render(props: Partial<React.ComponentProps<typeof DeletePortfolioDialog>> = {}) {
  act(() => {
    root.render(<DeletePortfolioDialog
      open
      loading={false}
      summary={summary()}
      error=""
      pending={false}
      money={money}
      onClose={() => undefined}
      onTransferFirst={() => { transferRequests += 1; }}
      onConfirm={(name) => confirmed.push(name)}
      {...props}
    />);
  });
}

function query<T extends Element = HTMLElement>(selector: string) {
  return document.body.querySelector<T>(selector);
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  confirmed = [];
  transferRequests = 0;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe('the delete dialog', () => {
  it('states the portfolio it is about to delete by name', () => {
    render();
    expect(document.body.textContent).toContain('ลบพอร์ต “พอร์ตทดลอง”?');
    expect(document.body.textContent).toContain('ไม่กระทบบัญชี แผนสมาชิก Trial หรือพอร์ตอื่น');
  });

  it('shows the counts it was given rather than a placeholder', () => {
    render();
    const facts = query('[data-testid="delete-portfolio-facts"]')!.textContent ?? '';
    expect(facts).toContain('$12345.00');
    expect(facts).toContain('2 รายการ');
    expect(facts).toContain('1 สัญญา');
    expect(facts).toContain('17 รายการ');
  });

  it('offers to move the assets first when there are any', () => {
    render();
    const button = query('[data-testid="delete-portfolio-transfer-first"]');
    expect(button).not.toBeNull();
    act(() => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(transferRequests).toBe(1);
  });

  it('does not offer to move anything from a portfolio holding only closed history', () => {
    render({ summary: summary({ hasTransferableAssets: false, openHoldings: 0, openOptionPositions: 0 }) });
    expect(query('[data-testid="delete-portfolio-transfer-first"]')).toBeNull();
    expect(document.body.textContent)
      .toContain('พอร์ตนี้ไม่มีสินทรัพย์ที่ถืออยู่ แต่ยังมีประวัติธุรกรรม 17 รายการ ซึ่งจะถูกลบพร้อมพอร์ต');
  });

  it('does not offer a move when there is nowhere to move to', () => {
    render({ summary: summary({ destinations: [] }) });
    expect(query('[data-testid="delete-portfolio-transfer-first"]')).toBeNull();
  });

  it('keeps the confirm button disabled until the name is typed exactly', () => {
    render();
    act(() => {
      query('[data-testid="delete-portfolio-continue"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const confirm = query<HTMLButtonElement>('[data-testid="delete-portfolio-confirm"]')!;
    expect(confirm.disabled).toBe(true);

    const input = query<HTMLInputElement>('[data-testid="delete-portfolio-name-input"]')!;
    act(() => {
      setValue(input, 'พอร์ตอื่น');
    });
    expect(query<HTMLButtonElement>('[data-testid="delete-portfolio-confirm"]')!.disabled).toBe(true);

    act(() => {
      setValue(input, 'พอร์ตทดลอง');
    });
    expect(query<HTMLButtonElement>('[data-testid="delete-portfolio-confirm"]')!.disabled).toBe(false);
  });

  it('sends the typed name so the database can check it too', () => {
    render();
    act(() => {
      query('[data-testid="delete-portfolio-continue"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    act(() => {
      setValue(query<HTMLInputElement>('[data-testid="delete-portfolio-name-input"]')!, '  พอร์ตทดลอง  ');
    });
    act(() => {
      query('[data-testid="delete-portfolio-confirm"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(confirmed).toEqual(['พอร์ตทดลอง']);
  });

  it('refuses the last active portfolio before the reader can type anything', () => {
    render({ summary: summary({ isLastActive: true }) });
    expect(query<HTMLButtonElement>('[data-testid="delete-portfolio-continue"]')!.disabled).toBe(true);
    expect(document.body.textContent).toContain('กรุณาสร้างพอร์ตใหม่ก่อนแล้วจึงลบพอร์ตนี้');
  });

  it('warns about negative cash and says a move will not clear it', () => {
    render({ summary: summary({ cashBalance: -820.5, hasNegativeCash: true }) });
    expect(document.body.textContent).toContain('พอร์ตนี้มียอดเงินสดติดลบ');
    expect(document.body.textContent).toContain('การลบพอร์ตจะไม่ล้างยอดค้างนี้');
  });

  it('names the portfolio that takes over as the writable stock portfolio', () => {
    render({ summary: summary({ replacementWritableName: 'พอร์ตสำรอง' }) });
    expect(document.body.textContent).toContain('จะใช้ “พอร์ตสำรอง” เป็นพอร์ตหุ้นหลักแทน');
  });

  it('says it is reading rather than showing stale zeroes while it loads', () => {
    render({ loading: true, summary: null });
    expect(document.body.textContent).toContain('กำลังอ่านข้อมูลล่าสุดของพอร์ตนี้');
    expect(query('[data-testid="delete-portfolio-facts"]')).toBeNull();
  });

  it('blocks a second click while a deletion is in flight', () => {
    render({ pending: true });
    act(() => {
      query('[data-testid="delete-portfolio-continue"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // The continue button is disabled, so the confirm stage is never reached.
    expect(query('[data-testid="delete-portfolio-confirm"]')).toBeNull();
    expect(confirmed).toEqual([]);
  });
});

/** React tracks input value on the DOM node, so the setter has to be bypassed. */
function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
