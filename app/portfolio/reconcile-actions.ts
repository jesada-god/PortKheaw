'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/src/lib/supabase/server';
import { PortfolioRepository } from '@/src/lib/portfolio/repository';
import { loadPortfolioReconciliationSnapshot } from '@/src/lib/portfolio/reconciliation-service';
import {
  MAXIMUM_RECONCILED_VALUE,
  planPortfolioReconciliation,
  type PortfolioReconciliationPlan,
} from '@/src/lib/portfolio/reconciliation';
import { getFxRate } from '@/src/lib/market-data/fx/service';
import { entitlementFailure } from '@/src/lib/subscription/entitlement-errors';
import {
  DEFAULT_TRANSACTION_TIME_ZONE,
  resolveTransactionTimeZone,
  validateTransactionDateTime,
} from '@/src/lib/portfolio/transaction-datetime';
import { fixed, fixedDivide, fixedToNumber } from '@/src/lib/money/fixed';

export type ReconcilePortfolioValueResult =
  | { ok: true; plan: PortfolioReconciliationPlan }
  | {
    ok: false;
    code: string;
    message: string;
    maxWithdrawableUsd?: number;
    minimumTotalUsd?: number;
  };

const schema = z.object({
  portfolioId: z.string().uuid('กรุณาเลือกพอร์ตที่ต้องการปรับยอด'),
  /*
   * What the owner typed, in the currency they were looking at. The server
   * converts it to the canonical USD the ledger stores, using a rate it fetches
   * itself — a client-supplied rate would let the browser choose the delta.
   */
  targetValue: z.number().finite().min(0, 'มูลค่าพอร์ตรวมต้องไม่ติดลบ').max(MAXIMUM_RECONCILED_VALUE),
  currency: z.enum(['USD', 'THB']),
  occurredAt: z.string().trim().min(1),
  timezone: z.string().trim().min(1).max(64).optional()
    .default(DEFAULT_TRANSACTION_TIME_ZONE)
    .transform(resolveTransactionTimeZone),
  note: z.string().trim().max(500, 'หมายเหตุต้องไม่เกิน 500 ตัวอักษร').optional().default(''),
  idempotencyKey: z.string().uuid(),
}).superRefine((value, context) => {
  const dateTime = validateTransactionDateTime(value.occurredAt, value.timezone);
  if (!dateTime.ok) context.addIssue({ code: 'custom', path: ['occurredAt'], message: dateTime.message });
});

function failure(error: unknown): ReconcilePortfolioValueResult {
  const value = error as { code?: string; message?: string } | null;
  const entitlement = entitlementFailure(error);
  if (entitlement) return { ok: false, ...entitlement };
  if (value?.code === '23514' && value.message?.includes('archived')) {
    return { ok: false, code: 'archived', message: 'พอร์ตที่ Archive แล้วรับรายการใหม่ไม่ได้' };
  }
  if (value?.code === '42501') return { ok: false, code: 'unauthorized', message: 'คุณไม่มีสิทธิ์ปรับยอดพอร์ตนี้' };
  return { ok: false, code: 'database', message: 'บันทึกการปรับยอดไม่สำเร็จ กรุณาลองอีกครั้ง' };
}

export async function reconcilePortfolioValueAction(raw: unknown): Promise<ReconcilePortfolioValueResult> {
  const input = schema.safeParse(raw);
  if (!input.success) return { ok: false, code: 'invalid', message: input.error.issues[0].message };

  const client = await createClient();
  if (!client) return { ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };
  const { data: { user } } = await client.auth.getUser();
  if (!user) return { ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };

  let targetUsd = input.data.targetValue;
  if (input.data.currency === 'THB') {
    const fx = await getFxRate('USD', 'THB').catch(() => ({ quote: null, unavailable: true }));
    const rate = fx.quote?.rate ?? null;
    if (!rate || !Number.isFinite(Number(rate)) || Number(rate) <= 0) {
      return { ok: false, code: 'fx-unavailable', message: 'ยังไม่มีอัตราแลกเปลี่ยนจริง จึงปรับยอดเป็น THB ไม่ได้' };
    }
    targetUsd = fixedToNumber(fixedDivide(fixed(input.data.targetValue), fixed(rate)));
  }

  try {
    const snapshot = await loadPortfolioReconciliationSnapshot(client, input.data.portfolioId);
    if (!snapshot) return { ok: false, code: 'unauthorized', message: 'ไม่พบพอร์ตที่ต้องการปรับยอด' };

    const plan = planPortfolioReconciliation({
      currentTotalUsd: snapshot.summary.totalValue,
      cashBalanceUsd: snapshot.summary.cashBalance,
      targetTotalUsd: targetUsd,
    });
    if (!plan.ok) {
      return {
        ok: false,
        code: plan.code,
        message: plan.message,
        maxWithdrawableUsd: plan.maxWithdrawableUsd,
        minimumTotalUsd: plan.minimumTotalUsd,
      };
    }

    /*
     * One ordinary ledger row, written through the same RPC every other
     * transaction uses — so the entitlement gate, the ledger assertions and the
     * `(portfolio_id, idempotency_key)` uniqueness that makes a double submit a
     * no-op all apply here without a second implementation.
     */
    await new PortfolioRepository(client).create({
      portfolioId: input.data.portfolioId,
      type: plan.type,
      amount: plan.amountUsd.toFixed(2),
      originalCurrency: 'USD',
      occurredAt: input.data.occurredAt,
      timezone: input.data.timezone,
      note: input.data.note,
      idempotencyKey: input.data.idempotencyKey,
    });

    revalidatePath('/portfolio');
    revalidatePath('/portfolio/transactions');
    revalidatePath('/');
    return { ok: true, plan };
  } catch (error) {
    return failure(error);
  }
}
