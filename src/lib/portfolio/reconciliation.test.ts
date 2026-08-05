import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planPortfolioReconciliation } from './reconciliation';
import { calculatePortfolio } from './calculations';
import type { PortfolioTransaction } from './types';

function transaction(overrides: Partial<PortfolioTransaction> & { id: string; type: PortfolioTransaction['type'] }): PortfolioTransaction {
  return {
    portfolioId: 'portfolio-1',
    symbol: null,
    quantity: null,
    price: null,
    amount: null,
    occurredAt: '2026-08-01',
    occurredAtTime: '2026-08-01T05:00:00.000Z',
    note: null,
    createdAt: '2026-08-01T05:00:00.000Z',
    updatedAt: '2026-08-01T05:00:00.000Z',
    ...overrides,
  };
}

describe('portfolio balance reconciliation', () => {
  it('raises a total with a deposit and lowers it with a withdrawal', () => {
    const up = planPortfolioReconciliation({ currentTotalUsd: 1_000, cashBalanceUsd: 200, targetTotalUsd: 1_250 });
    expect(up).toMatchObject({
      ok: true,
      type: 'deposit',
      deltaUsd: 250,
      amountUsd: 250,
      cashBeforeUsd: 200,
      cashAfterUsd: 450,
      currentTotalUsd: 1_000,
      targetTotalUsd: 1_250,
    });

    const down = planPortfolioReconciliation({ currentTotalUsd: 1_000, cashBalanceUsd: 400, targetTotalUsd: 750 });
    expect(down).toMatchObject({
      ok: true,
      type: 'withdrawal',
      deltaUsd: -250,
      amountUsd: 250,
      cashBeforeUsd: 400,
      cashAfterUsd: 150,
    });
  });

  it('refuses a total that cannot be reached and says how far the cash goes', () => {
    const result = planPortfolioReconciliation({ currentTotalUsd: 1_000, cashBalanceUsd: 120, targetTotalUsd: 500 });
    expect(result).toMatchObject({
      ok: false,
      code: 'insufficient-cash',
      maxWithdrawableUsd: 120,
      minimumTotalUsd: 880,
    });
    // Exactly emptying the cash is still allowed; one cent more is not.
    expect(planPortfolioReconciliation({ currentTotalUsd: 1_000, cashBalanceUsd: 120, targetTotalUsd: 880 }).ok).toBe(true);
    expect(planPortfolioReconciliation({ currentTotalUsd: 1_000, cashBalanceUsd: 120, targetTotalUsd: 879.99 }).ok).toBe(false);
  });

  it('treats an already-negative cash balance as nothing left to withdraw', () => {
    expect(planPortfolioReconciliation({ currentTotalUsd: 500, cashBalanceUsd: -50, targetTotalUsd: 400 }))
      .toMatchObject({ ok: false, code: 'insufficient-cash', maxWithdrawableUsd: 0, minimumTotalUsd: 500 });
  });

  it('refuses an unchanged, invalid or unpriceable total', () => {
    expect(planPortfolioReconciliation({ currentTotalUsd: 1_000, cashBalanceUsd: 500, targetTotalUsd: 1_000 }))
      .toMatchObject({ ok: false, code: 'no-change' });
    expect(planPortfolioReconciliation({ currentTotalUsd: 1_000, cashBalanceUsd: 500, targetTotalUsd: 1_000.004 }))
      .toMatchObject({ ok: false, code: 'no-change' });
    expect(planPortfolioReconciliation({ currentTotalUsd: 1_000, cashBalanceUsd: 500, targetTotalUsd: -1 }))
      .toMatchObject({ ok: false, code: 'invalid' });
    expect(planPortfolioReconciliation({ currentTotalUsd: 1_000, cashBalanceUsd: 500, targetTotalUsd: Number.NaN }))
      .toMatchObject({ ok: false, code: 'invalid' });
    // A portfolio holding something without a real price has no current total,
    // so there is no delta to compute and nothing may be written.
    expect(planPortfolioReconciliation({ currentTotalUsd: null, cashBalanceUsd: 500, targetTotalUsd: 2_000 }))
      .toMatchObject({ ok: false, code: 'value-unavailable' });
  });

  it('moves the total and cash by the delta while leaving profit and loss alone', () => {
    const ledger: PortfolioTransaction[] = [
      transaction({ id: 'a', type: 'deposit', amount: '1000' }),
      transaction({
        id: 'b',
        type: 'acquisition',
        symbol: 'AAPL',
        quantity: '4',
        price: '100',
        fee: '0',
        occurredAtTime: '2026-08-01T06:00:00.000Z',
      }),
    ];
    const prices = { AAPL: { price: 110, previousClose: 105 } };
    const before = calculatePortfolio(ledger, prices);
    expect(before.totalValue).toBe(1_040);

    const plan = planPortfolioReconciliation({
      currentTotalUsd: before.totalValue,
      cashBalanceUsd: before.cashBalance,
      targetTotalUsd: 1_500,
    });
    expect(plan).toMatchObject({ ok: true, type: 'deposit', amountUsd: 460 });

    const after = calculatePortfolio([
      ...ledger,
      transaction({ id: 'c', type: 'deposit', amount: '460', occurredAtTime: '2026-08-01T07:00:00.000Z' }),
    ], prices);

    expect(after.totalValue).toBe(1_500);
    expect(after.cashBalance).toBe(before.cashBalance + 460);
    // External capital is not a trading result: absolute gain, realised gain,
    // unrealised gain and today's move are all untouched by the reconciliation.
    expect(after.totalGain).toBe(before.totalGain);
    expect(after.realizedGain).toBe(before.realizedGain);
    expect(after.unrealizedGain).toBe(before.unrealizedGain);
    expect(after.todayChange).toBe(before.todayChange);
    expect(after.netDepositedCapital).toBe(before.netDepositedCapital + 460);
  });
});

describe('portfolio balance reconciliation server contract', () => {
  const action = readFileSync(resolve(process.cwd(), 'app/portfolio/reconcile-actions.ts'), 'utf8');

  it('recomputes the current value on the server and never accepts a client delta', () => {
    expect(action).toContain('loadPortfolioReconciliationSnapshot');
    expect(action).toContain('currentTotalUsd: snapshot.summary.totalValue');
    expect(action).toContain('cashBalanceUsd: snapshot.summary.cashBalance');
    expect(action).not.toContain('currentTotalUsd: input');
    expect(action).not.toMatch(/deltaUsd:\s*input/);
  });

  it('writes the reconciliation through the shared ledger RPC with the submitted idempotency key', () => {
    expect(action).toContain('new PortfolioRepository(client).create({');
    expect(action).toContain('type: plan.type');
    expect(action).toContain('idempotencyKey: input.data.idempotencyKey');
    expect(action).toContain("revalidatePath('/portfolio')");
    expect(action).toContain("revalidatePath('/portfolio/transactions')");
  });

  it('resolves THB with a server-fetched rate rather than one the browser supplied', () => {
    expect(action).toContain("getFxRate('USD', 'THB')");
    expect(action).not.toContain('fxRateAtTransaction: input');
    expect(action).toContain("code: 'fx-unavailable'");
  });
});
