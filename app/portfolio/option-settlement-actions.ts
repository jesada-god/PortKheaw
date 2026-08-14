'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/src/lib/supabase/server';
import { PortfolioRepository } from '@/src/lib/portfolio/repository';
import { calculatePortfolio } from '@/src/lib/portfolio/calculations';
import { portfolioTransactionSchema } from '@/src/lib/portfolio/validation';
import { preparePortfolioTransactionForCreate } from '@/src/lib/portfolio/transaction-preparation';
import {
  authorizeOptionSettlement,
  optionMarketDate,
  optionSettlementSubject,
  type OptionSettlementPlan,
} from '@/src/lib/portfolio/options/settlement';
import {
  DEFAULT_TRANSACTION_TIME_ZONE,
  resolveTransactionTimeZone,
  validateTransactionDateTime,
} from '@/src/lib/portfolio/transaction-datetime';
import { entitlementFailure } from '@/src/lib/subscription/entitlement-errors';

/**
 * ใช้สิทธิ์ and หมดอายุ, decided on the server against the ledger.
 *
 * The browser sends four things — which portfolio, which position, how many
 * contracts, and when — and nothing else. Every figure the settlement turns on
 * is re-derived here from `calculatePortfolio` over the portfolio's own
 * transactions: the cash balance, the shares of the underlying actually held,
 * and the contracts still open. That is what makes the preview a preview: a
 * reader who saw "เงินสดจะลดลง $7,300" ten minutes ago and has since spent the
 * cash is refused here, not in the browser that is still showing the old number.
 *
 * This adds no second ledger and no second money path. Once the settlement is
 * authorised the row goes through the same schema, the same preparation step and
 * the same `create_portfolio_ledger_transaction` RPC every other transaction
 * uses — so ownership, entitlement, archived/deleted portfolios, idempotency and
 * the ledger's own negative-balance constraints all still apply underneath.
 */

export type OptionSettlementActionResult =
  | { ok: true; plan: OptionSettlementPlan }
  | { ok: false; code: string; message: string };

const settlementRequestSchema = z.object({
  portfolioId: z.string().uuid('กรุณาเลือกพอร์ตออปชัน'),
  /** The position key the ledger summary issues — never a client-built identity. */
  positionKey: z.string().trim().min(1).max(120),
  action: z.enum(['exercise', 'expired']),
  contracts: z.number().int().positive().max(1_000_000),
  occurredAt: z.string().trim().min(1),
  timezone: z.string().trim().min(1).max(64).default(DEFAULT_TRANSACTION_TIME_ZONE)
    .transform(resolveTransactionTimeZone),
  note: z.string().trim().max(500, 'หมายเหตุต้องไม่เกิน 500 ตัวอักษร').default(''),
  idempotencyKey: z.string().uuid(),
});

export type OptionSettlementRequestInput = z.input<typeof settlementRequestSchema>;

function failure(error: unknown): OptionSettlementActionResult {
  const value = error as { code?: string; message?: string } | null;
  const entitlement = entitlementFailure(error);
  if (entitlement) return { ok: false, ...entitlement };
  if (value?.code === '23514') {
    return { ok: false, code: 'insufficient-position', message: 'รายการนี้ทำให้จำนวนหุ้นหรือสัญญาติดลบ กรุณาตรวจจำนวนและลำดับเวลาใน Ledger' };
  }
  if (value?.code === '42501') return { ok: false, code: 'unauthorized', message: 'คุณไม่มีสิทธิ์แก้ไขรายการนี้' };
  return { ok: false, code: 'database', message: 'บันทึกข้อมูลไม่สำเร็จ กรุณาลองอีกครั้ง' };
}

export async function settleOptionPositionAction(raw: unknown): Promise<OptionSettlementActionResult> {
  const parsed = settlementRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, code: 'invalid', message: parsed.error.issues[0]?.message ?? 'กรุณาตรวจสอบข้อมูลที่กรอก' };
  }
  const input = parsed.data;

  const dateTime = validateTransactionDateTime(input.occurredAt, input.timezone);
  if (!dateTime.ok) return { ok: false, code: 'invalid', message: dateTime.message };

  const client = await createClient();
  if (!client) return { ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };
  const { data: { user } } = await client.auth.getUser();
  if (!user) return { ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };
  const repository = new PortfolioRepository(client);

  try {
    // Row-level security scopes this read to the reader, so a portfolio id that
    // is not theirs — or one they have deleted — simply is not found.
    const portfolio = await repository.getById(input.portfolioId);
    if (!portfolio) return { ok: false, code: 'unauthorized', message: 'ไม่พบพอร์ตนี้ หรือถูกลบไปแล้ว' };

    const summary = calculatePortfolio(portfolio.transactions);
    const position = summary.optionPositions.find((item) => item.key === input.positionKey);
    if (!position) return { ok: false, code: 'not-found', message: 'ไม่พบสัญญาออปชันนี้ในพอร์ต' };

    const authorization = authorizeOptionSettlement({
      action: input.action,
      subject: optionSettlementSubject(position),
      contracts: input.contracts,
      cashBalance: summary.cashBalance,
      underlyingShares: summary.holdings.find((item) => item.symbol === position.underlyingSymbol)?.quantity ?? 0,
      marketDate: optionMarketDate(),
    });
    if (!authorization.ok) return { ok: false, code: authorization.code, message: authorization.message };

    /*
      Zero premium, zero fee, and the contract identity copied from the position
      rather than retyped: an exercise settles at the strike and an expiry
      settles at nothing, so there is no premium to charge and nothing for a
      reader to get wrong. The same schema every option row is validated by runs
      over it, so this path cannot write a shape the ledger would refuse.
    */
    const transaction = portfolioTransactionSchema.safeParse({
      portfolioId: portfolio.id,
      type: input.action,
      quantity: String(input.contracts),
      price: '0',
      fee: '0',
      originalCurrency: 'USD',
      occurredAt: input.occurredAt,
      timezone: input.timezone,
      note: input.note,
      underlyingSymbol: position.underlyingSymbol,
      contractSymbol: position.contractSymbol,
      optionKind: position.optionKind,
      optionSide: position.side,
      strikePrice: String(position.strikePrice),
      expirationDate: position.expirationDate,
      multiplier: String(position.multiplier),
      idempotencyKey: input.idempotencyKey,
    });
    if (!transaction.success) {
      return { ok: false, code: 'invalid', message: transaction.error.issues[0]?.message ?? 'ข้อมูลสัญญาไม่ถูกต้อง' };
    }

    await repository.create(await preparePortfolioTransactionForCreate(transaction.data));
    revalidatePath('/portfolio');
    revalidatePath('/portfolio/transactions');
    revalidatePath('/');
    return { ok: true, plan: authorization.plan };
  } catch (error) {
    return failure(error);
  }
}
