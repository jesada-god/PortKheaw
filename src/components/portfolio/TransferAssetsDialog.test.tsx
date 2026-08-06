// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TransferAssetsDialog, type TransferSelectionState } from './TransferAssetsDialog';
import type { TransferableAssets } from '@/src/lib/portfolio/transfer/plan';
import type { TransferPreview } from '@/src/lib/portfolio/transfer/service';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const money = (value: number | string | null) => value === null ? '—' : `$${Number(value).toFixed(2)}`;

function assets(overrides: Partial<TransferableAssets> = {}): TransferableAssets {
  return {
    equities: [{ symbol: 'AAPL', quantity: 6, costBasis: 900, marketValue: 1200, acquiredAt: '2026-01-05T05:00:00.000Z' }],
    options: [{
      key: 'AAPL261218C00200000',
      contractSymbol: 'AAPL261218C00200000',
      underlyingSymbol: 'AAPL',
      optionKind: 'call',
      side: 'long',
      strikePrice: 200,
      expirationDate: '2026-12-18',
      multiplier: 100,
      contracts: 6,
      remainingCost: 1800,
      averagePremium: 3,
      marketValue: 2400,
    }],
    cashBalance: 500,
    transferableCash: 500,
    hasNegativeCash: false,
    hasAnything: true,
    ...overrides,
  };
}

function preview(): TransferPreview {
  return {
    sourceId: 'source',
    sourceName: 'ต้นทาง',
    destinationId: 'dest',
    destinationName: 'ปลายทาง',
    plan: {
      legs: [],
      expectations: [],
      lines: [
        { kind: 'equity', label: 'AAPL', detail: '6 หน่วย', quantity: 6, costBasis: 900, marketValue: 1200, whole: true },
        { kind: 'cash', label: 'เงินสด', detail: 'ย้ายเงินสดระหว่างพอร์ต', quantity: 200, costBasis: 200, marketValue: 200, whole: false },
      ],
      movedCostBasis: 1100,
      movedMarketValue: 1400,
      cashUsd: 200,
    },
    sourceCashAfter: 300,
    destinationCashAfter: 200,
    hasNegativeCash: false,
  };
}

let container: HTMLDivElement;
let root: Root;
let previews: TransferSelectionState[];
let confirmations: number;

function render(props: Partial<React.ComponentProps<typeof TransferAssetsDialog>> = {}) {
  act(() => {
    root.render(<TransferAssetsDialog
      open
      step="items"
      loading={false}
      pending={false}
      error=""
      sourceName="ต้นทาง"
      assets={assets()}
      destinations={[{ id: 'dest', name: 'ปลายทาง', type: 'STOCK' }]}
      destinationId="dest"
      preview={null}
      completedDestinationName=""
      money={money}
      onClose={() => undefined}
      onDestinationChange={() => undefined}
      onStepChange={() => undefined}
      onPreview={(selection) => previews.push(selection)}
      onConfirm={() => { confirmations += 1; }}
      onOpenDestination={() => undefined}
      onDeleteSource={() => undefined}
      {...props}
    />);
  });
}

function query<T extends Element = HTMLElement>(selector: string) {
  return document.body.querySelector<T>(selector);
}

function click(selector: string) {
  act(() => {
    query(selector)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  previews = [];
  confirmations = 0;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe('choosing what to move', () => {
  it('lists only what the server said is still held', () => {
    render();
    expect(query('[data-testid="transfer-equities"]')!.textContent).toContain('AAPL');
    expect(query('[data-testid="transfer-equities"]')!.textContent).toContain('ถืออยู่ 6 หน่วย');
    expect(query('[data-testid="transfer-options"]')!.textContent).toContain('เปิดอยู่ 6 สัญญา');
  });

  it('shows nothing to move for a portfolio whose positions are all closed', () => {
    render({ assets: assets({ equities: [], options: [], cashBalance: 0, transferableCash: 0, hasAnything: false }) });
    expect(query('[data-testid="transfer-equities"]')).toBeNull();
    expect(query('[data-testid="transfer-options"]')).toBeNull();
    expect(document.body.textContent).toContain('พอร์ตนี้ไม่มีสินทรัพย์ที่ถืออยู่ให้ย้าย');
  });

  it('keeps the preview button disabled until something is selected', () => {
    render();
    expect(query<HTMLButtonElement>('[data-testid="transfer-preview"]')!.disabled).toBe(true);
    click('[data-testid="transfer-equities"] input[type="checkbox"]');
    expect(query<HTMLButtonElement>('[data-testid="transfer-preview"]')!.disabled).toBe(false);
  });

  it('defaults a selected position to its whole open quantity', () => {
    render();
    click('[data-testid="transfer-equities"] input[type="checkbox"]');
    click('[data-testid="transfer-preview"]');
    expect(previews).toEqual([{ equities: { AAPL: '6' }, options: {}, cash: '' }]);
  });

  it('sends quantities only, never an amount', () => {
    render();
    click('[data-testid="transfer-options"] input[type="checkbox"]');
    click('[data-testid="transfer-preview"]');
    const sent = previews[0];
    expect(Object.keys(sent)).toEqual(['equities', 'options', 'cash']);
    expect(sent.options).toEqual({ AAPL261218C00200000: '6' });
  });

  it('refuses to offer a cash box when the balance is negative, and says why', () => {
    render({ assets: assets({ cashBalance: -420, transferableCash: 0, hasNegativeCash: true }) });
    expect(query('[data-testid="transfer-cash-amount"]')).toBeNull();
    expect(document.body.textContent)
      .toContain('พอร์ตนี้มียอดเงินสดติดลบ การย้ายสินทรัพย์จะไม่ล้างยอดค้างนี้');
  });

  it('selects everything at once when asked to', () => {
    render();
    const selectAll = [...document.body.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('เลือกทั้งหมด'))!;
    act(() => { selectAll.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    click('[data-testid="transfer-preview"]');
    expect(previews[0]).toEqual({
      equities: { AAPL: '6' },
      options: { AAPL261218C00200000: '6' },
      cash: '500',
    });
  });
});

describe('the preview step', () => {
  it('states both sides of the move and the balances that follow', () => {
    render({ step: 'preview', preview: preview() });
    const lines = query('[data-testid="transfer-preview-lines"]')!.textContent ?? '';
    expect(lines).toContain('AAPL');
    expect(lines).toContain('ย้ายทั้งหมด');
    expect(lines).toContain('ย้ายบางส่วน');
    expect(document.body.textContent).toContain('เงินสดต้นทางหลังย้าย');
    expect(document.body.textContent).toContain('$300.00');
    expect(document.body.textContent).toContain('$200.00');
  });

  it('says plainly that this is not a trade', () => {
    render({ step: 'preview', preview: preview() });
    expect(document.body.textContent).toContain('การย้ายไม่ใช่การขายและไม่ส่งคำสั่งซื้อขายจริง');
  });

  it('does not fire a second confirmation while one is in flight', () => {
    render({ step: 'preview', preview: preview(), pending: true });
    const confirm = query<HTMLButtonElement>('[data-testid="transfer-confirm"]')!;
    expect(confirm.disabled).toBe(true);
    act(() => { confirm.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(confirmations).toBe(0);
  });

  it('shows a stale-position error without pretending anything was written', () => {
    render({
      step: 'items',
      error: 'จำนวนสินทรัพย์ในพอร์ตเปลี่ยนไปหลังจากที่คุณดูตัวอย่าง ระบบยังไม่ได้ย้ายอะไรเลย',
    });
    const alert = document.body.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('ระบบยังไม่ได้ย้ายอะไรเลย');
  });
});

describe('after a successful move', () => {
  it('names the destination and offers the two things worth doing next', () => {
    render({ step: 'done', completedDestinationName: 'ปลายทาง' });
    expect(document.body.textContent).toContain('ย้ายสินทรัพย์ไปยัง “ปลายทาง” สำเร็จ');
    const labels = [...document.body.querySelectorAll('button')].map((button) => button.textContent);
    expect(labels.some((label) => label?.includes('เปิดพอร์ตปลายทาง'))).toBe(true);
    expect(labels.some((label) => label?.includes('ลบพอร์ตเดิม'))).toBe(true);
  });
});

describe('responsiveness', () => {
  it('lets wide content wrap instead of pushing the dialog sideways', () => {
    render({ step: 'preview', preview: preview() });
    const lines = query('[data-testid="transfer-preview-lines"]')!;
    // Every label is allowed to break, which is what keeps a long contract
    // symbol from widening the dialog past the viewport at 320px.
    const breakable = lines.querySelectorAll('.break-words');
    expect(breakable.length).toBeGreaterThan(0);
  });
});
