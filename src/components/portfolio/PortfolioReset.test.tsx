// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The reset button and the dialog behind it, rendered for real.
 *
 * What matters here is not that a button exists — a source-reading test could
 * claim that — but the four things a reader can do wrong with an irreversible
 * action: press it and be shown no warning, cancel and have it happen anyway,
 * press confirm twice and send two, and be shown a success that the server
 * refused. Each of those is a case below.
 */

const resetPortfolioAction = vi.fn();
const refresh = vi.fn();
const addToast = vi.fn();

vi.mock('@/app/portfolio/portfolio-actions', () => ({
  archivePortfolioAction: vi.fn(),
  createPortfolioAction: vi.fn(),
  resetPortfolioAction: (...args: unknown[]) => resetPortfolioAction(...args),
  restoreDeletedPortfolioAction: vi.fn(),
  restorePortfolioAction: vi.fn(),
  setPortfolioGoalAction: vi.fn(),
  softDeletePortfolioAction: vi.fn(),
  transferPortfolioCashAction: vi.fn(),
  updatePortfolioAction: vi.fn(),
}));

vi.mock('@/app/portfolio/transfer-actions', () => ({
  confirmAssetTransferAction: vi.fn(),
  loadPortfolioDeletionSummaryAction: vi.fn(),
  loadTransferableAssetsAction: vi.fn(),
  previewAssetTransferAction: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('@/src/components/ui/Toast', () => ({
  useToast: () => ({ addToast }),
  Toaster: () => null,
}));

vi.mock('@/src/components/subscription/EntitlementProvider', () => ({
  useEntitlement: () => ({ requestUpgrade: vi.fn() }),
}));

import { PortfolioManager } from './PortfolioManager';
import type { PortfolioRecord, PortfolioSummary } from '@/src/lib/portfolio/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';

function portfolio(id: string, name: string): PortfolioRecord {
  return {
    id, name, type: 'STOCK', isLegacy: false, archivedAt: null, deletedAt: null,
    purgeAfter: null, targetValueUsd: null, targetDate: null, baseCurrency: 'USD',
    transactions: [],
  };
}

function summary(overrides: Partial<PortfolioSummary> = {}): PortfolioSummary {
  return {
    holdings: [], cashBalance: 1_000, marketValue: 5_000, costBasis: 4_000,
    realizedGain: 0, unrealizedGain: 1_000, totalValue: 6_000,
    equityMarketValue: 5_000, optionsMarketValue: 0, optionRemainingCost: 0,
    netDepositedCapital: 5_000, netTransferredCapital: 0, totalGain: 1_000,
    totalGainPercent: 20, todayChange: 12, todayChangePercent: 0.2,
    todayChangeAsOf: null, todayChangeSource: null,
    optionPositions: [], hasMissingPrices: false,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

function render() {
  const money = (value: number | string | null) => (value === null ? '—' : `$${Number(value).toFixed(2)}`);
  act(() => {
    root.render(<PortfolioManager
      portfolios={[portfolio(FIRST, 'พอร์ตหลัก'), portfolio(SECOND, 'พอร์ตสอง')]}
      summaries={{ [FIRST]: summary(), [SECOND]: summary() }}
      aggregate={summary()}
      aggregateGoal={{ targetValueUsd: null, targetDate: null }}
      selectedPortfolioId={FIRST}
      optionTargetCounts={{}}
      recentlyDeleted={[]}
      timezone="Asia/Bangkok"
      effectiveTier="elite"
      showBalances
      isOnline
      money={money}
      signed={(value) => (value === null ? '—' : `${value}`)}
      percent={(value) => (value === null ? '—' : `${value}%`)}
      onSelect={() => undefined}
      openRequest={null}
      onOpenRequestHandled={() => undefined}
    />);
  });
  // Managing a portfolio now lives behind one navigation row, so the reset
  // control is reached the way a reader reaches it.
  openManagePanel();
}

/*
 * The manage area is a dialog, so it renders through a portal to `document.body`
 * rather than inside the container — which is also why opening the reset dialog
 * closes it, and why the assertions below read the document.
 */
function openManagePanel() {
  const entry = container.querySelector('[data-testid="portfolio-manage-entry"]');
  if (entry && !document.querySelector('[data-testid="portfolio-manage-panel"]')) click(entry);
}

function click(element: Element | null) {
  if (!element) throw new Error('Nothing to click');
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function resetButton(id: string) {
  return document.querySelector(`[data-testid="reset-portfolio-${id}"]`);
}

function dialogText() {
  return document.body.textContent ?? '';
}

function confirmButton() {
  return document.querySelector('[data-testid="confirm-reset-portfolio"]') as HTMLButtonElement | null;
}

function cancelButton() {
  return [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'ยกเลิก') ?? null;
}

beforeEach(() => {
  resetPortfolioAction.mockReset();
  refresh.mockReset();
  addToast.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the reset control on a portfolio card', () => {
  it('is offered on every card and never resets on the press itself', () => {
    render();
    expect(resetButton(FIRST)).not.toBeNull();
    expect(resetButton(SECOND)).not.toBeNull();

    click(resetButton(FIRST));

    expect(resetPortfolioAction).not.toHaveBeenCalled();
  });

  it('warns in Thai about exactly what goes and what stays', () => {
    render();
    click(resetButton(FIRST));

    const text = dialogText();
    expect(text).toContain('รีเซ็ตพอร์ตนี้?');
    expect(text).toContain('รายการลงทุน เงินสด ประวัติธุรกรรม และข้อมูลผลตอบแทนทั้งหมดของพอร์ตนี้จะถูกล้าง และไม่สามารถย้อนกลับได้ แต่ตัวพอร์ตจะยังอยู่');
    // The portfolio is named, so a reader on a page of cards knows which one.
    expect(text).toContain('พอร์ตหลัก');
    expect(confirmButton()?.textContent).toContain('ยืนยันรีเซ็ต');
    expect(cancelButton()).not.toBeNull();
  });

  it('cancelling closes the dialog and sends nothing', () => {
    render();
    click(resetButton(FIRST));
    click(cancelButton());

    expect(resetPortfolioAction).not.toHaveBeenCalled();
    expect(confirmButton()).toBeNull();
  });

  it('sends the id of the card that was pressed, not the selected portfolio', async () => {
    resetPortfolioAction.mockResolvedValue({ ok: true, cleared: {
      transactionsRemoved: 4, optionPositionsRemoved: 0, optionTargetsRemoved: 0, goalCleared: false,
    } });
    render();

    click(resetButton(SECOND));
    await act(async () => { click(confirmButton()); });

    expect(resetPortfolioAction).toHaveBeenCalledTimes(1);
    expect(resetPortfolioAction).toHaveBeenCalledWith({ id: SECOND });
    // The page's own numbers come from the server, so the success path has to
    // ask for them again rather than edit what is on screen.
    expect(refresh).toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    expect(confirmButton()).toBeNull();
  });

  it('cannot be submitted twice, even on two clicks inside one frame', async () => {
    let release: (value: { ok: boolean }) => void = () => undefined;
    resetPortfolioAction.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    render();
    click(resetButton(FIRST));

    // Both clicks land before the first request answers — the case a `pending`
    // flag alone does not catch, because neither has re-rendered yet.
    act(() => {
      confirmButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      confirmButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(resetPortfolioAction).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({ ok: true });
      await Promise.resolve();
    });
    expect(resetPortfolioAction).toHaveBeenCalledTimes(1);
  });

  it('keeps the dialog open and shows the server’s refusal rather than a false success', async () => {
    resetPortfolioAction.mockResolvedValue({
      ok: false, code: 'unauthorized', message: 'ไม่พบพอร์ตหรือคุณไม่มีสิทธิ์จัดการพอร์ตนี้',
    });
    render();
    click(resetButton(FIRST));
    await act(async () => { click(confirmButton()); });

    expect(document.querySelector('[data-testid="reset-portfolio-error"]')?.textContent)
      .toBe('ไม่พบพอร์ตหรือคุณไม่มีสิทธิ์จัดการพอร์ตนี้');
    expect(addToast).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    // Still open, so the reader can read the reason and decide again.
    expect(confirmButton()).not.toBeNull();
  });

  it('is disabled offline, like every other write on the card', () => {
    render();
    const button = resetButton(FIRST) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    act(() => {
      root.render(<PortfolioManager
        portfolios={[portfolio(FIRST, 'พอร์ตหลัก'), portfolio(SECOND, 'พอร์ตสอง')]}
        summaries={{ [FIRST]: summary(), [SECOND]: summary() }}
        aggregate={summary()}
        aggregateGoal={{ targetValueUsd: null, targetDate: null }}
        selectedPortfolioId={FIRST}
        optionTargetCounts={{}}
        recentlyDeleted={[]}
        timezone="Asia/Bangkok"
        effectiveTier="elite"
        showBalances
        isOnline={false}
        money={(value) => String(value)}
        signed={(value) => String(value)}
        percent={(value) => String(value)}
        onSelect={() => undefined}
        openRequest={null}
        onOpenRequestHandled={() => undefined}
      />);
    });
    openManagePanel();

    expect((resetButton(FIRST) as HTMLButtonElement).disabled).toBe(true);
  });
});
