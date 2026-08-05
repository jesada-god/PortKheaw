import { fixed, fixedToNumber } from '../money/fixed';

/*
 * Reconciling a portfolio to a value the owner already knows.
 *
 * A portfolio's total value is not a stored number — it is `cash + market
 * value of positions`, recomputed from the Transaction Ledger on every read.
 * So "set my portfolio to $12,000" cannot be an update; the only honest way to
 * land on a different total without inventing holdings is to move external
 * cash in or out, which is exactly what a deposit or a withdrawal is.
 *
 * That is what this plans: it turns a wanted total into one ordinary ledger
 * cash flow. Positions, quantities and cost basis are untouched, and because
 * deposits and withdrawals are external capital rather than trading results,
 * profit and loss does not move either.
 *
 * The same function runs in the browser (to preview) and on the server (to
 * decide). The server recomputes the current value from the ledger first and
 * never reads a total the client sent.
 */

export const RECONCILIATION_EPSILON = 0.01;
export const MAXIMUM_RECONCILED_VALUE = 1_000_000_000_000;

export type PortfolioReconciliationFailureCode =
  | 'value-unavailable'
  | 'invalid'
  | 'no-change'
  | 'insufficient-cash';

export interface PortfolioReconciliationPlan {
  ok: true;
  /** The ledger transaction type this reconciliation will write. */
  type: 'deposit' | 'withdrawal';
  currentTotalUsd: number;
  targetTotalUsd: number;
  /** Signed: positive adds cash, negative removes it. */
  deltaUsd: number;
  /** Unsigned amount written to the ledger row. */
  amountUsd: number;
  cashBeforeUsd: number;
  cashAfterUsd: number;
}

export interface PortfolioReconciliationRefusal {
  ok: false;
  code: PortfolioReconciliationFailureCode;
  message: string;
  /** Present on `insufficient-cash`: how much cash may still be withdrawn. */
  maxWithdrawableUsd?: number;
  /** Present on `insufficient-cash`: the lowest total this portfolio can reach. */
  minimumTotalUsd?: number;
}

export type PortfolioReconciliationResult =
  | PortfolioReconciliationPlan
  | PortfolioReconciliationRefusal;

function round(value: number): number {
  return fixedToNumber(fixed(value.toFixed(2)));
}

export function planPortfolioReconciliation({
  currentTotalUsd,
  cashBalanceUsd,
  targetTotalUsd,
}: {
  currentTotalUsd: number | null;
  cashBalanceUsd: number;
  targetTotalUsd: number;
}): PortfolioReconciliationResult {
  if (currentTotalUsd === null || !Number.isFinite(currentTotalUsd)) {
    return {
      ok: false,
      code: 'value-unavailable',
      message: 'ยังปรับยอดไม่ได้ เพราะบางสินทรัพย์ยังไม่มีราคาจริง จึงคำนวณมูลค่าปัจจุบันไม่ได้',
    };
  }
  if (!Number.isFinite(targetTotalUsd) || targetTotalUsd < 0 || targetTotalUsd > MAXIMUM_RECONCILED_VALUE) {
    return { ok: false, code: 'invalid', message: 'มูลค่าพอร์ตรวมที่ต้องการต้องเป็นตัวเลขตั้งแต่ 0 ขึ้นไป' };
  }

  const current = round(currentTotalUsd);
  const target = round(targetTotalUsd);
  const cashBefore = round(cashBalanceUsd);
  const delta = round(target - current);

  if (Math.abs(delta) < RECONCILIATION_EPSILON) {
    return { ok: false, code: 'no-change', message: 'ยอดที่กรอกเท่ากับมูลค่าปัจจุบัน จึงไม่ต้องปรับยอด' };
  }

  /*
   * Lowering the total means taking cash out, and a reconciliation may not be
   * the thing that pushes a portfolio into negative cash. If the owner wants a
   * lower total than the cash on hand allows, the gap is in a transaction or a
   * position, and that is where it has to be fixed.
   */
  const maxWithdrawable = Math.max(0, cashBefore);
  if (delta < 0 && Math.abs(delta) > maxWithdrawable + RECONCILIATION_EPSILON / 2) {
    return {
      ok: false,
      code: 'insufficient-cash',
      message: 'เงินสดในพอร์ตไม่พอสำหรับการลดยอดเท่านี้',
      maxWithdrawableUsd: maxWithdrawable,
      minimumTotalUsd: round(current - maxWithdrawable),
    };
  }

  return {
    ok: true,
    type: delta > 0 ? 'deposit' : 'withdrawal',
    currentTotalUsd: current,
    targetTotalUsd: target,
    deltaUsd: delta,
    amountUsd: round(Math.abs(delta)),
    cashBeforeUsd: cashBefore,
    cashAfterUsd: round(cashBefore + delta),
  };
}

export const RECONCILIATION_NOTE_PRESETS = [
  'ปรับยอดเริ่มต้น',
  'นำเข้าพอร์ตเดิม',
  'กระทบยอด',
] as const;
