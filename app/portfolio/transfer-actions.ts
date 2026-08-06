'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { PortfolioRepository } from '@/src/lib/portfolio/repository';
import { createClient } from '@/src/lib/supabase/server';
import { entitlementFailure } from '@/src/lib/subscription/entitlement-errors';
import { loadPortfolioPrices } from '@/src/lib/overview/service';
import { calculatePortfolio } from '@/src/lib/portfolio/calculations';
import { calculateOptionLedger } from '@/src/lib/portfolio/options/calculations';
import { loadPortfolioOptionQuotes } from '@/src/lib/portfolio/options/quote-pipeline';
import { getOptionsMarketDataService } from '@/src/lib/market-data/options';
import type { MarketPriceInput, PortfolioRecord } from '@/src/lib/portfolio/types';
import type { OptionQuoteInput } from '@/src/lib/portfolio/options/types';
import {
  buildPortfolioDeletionSummary,
  buildTransferPreview,
  commitTransfer,
  resolveTransferContext,
  type PortfolioDeletionSummary,
  type TransferFailure,
  type TransferPreview,
} from '@/src/lib/portfolio/transfer/service';
import { transferableAssets, type TransferableAssets } from '@/src/lib/portfolio/transfer/plan';

/*
 * Every action here reloads the ledger and recomputes. None of them accepts an
 * amount, a balance or a cost basis from the caller — only which portfolio,
 * which positions, and how many of each. That is the line the whole feature is
 * built on, and it is drawn here because this is the last place a browser can
 * still reach.
 */

const uuid = z.string().uuid();

export type TransferActionResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: string; message: string };

async function context() {
  const client = await createClient();
  if (!client) return null;
  const { data: { user } } = await client.auth.getUser();
  if (!user) return null;
  return { client, repository: new PortfolioRepository(client) };
}

/**
 * Market prices, loaded only so a preview can show what a move is worth. They
 * never reach a ledger row: a transfer carries cost basis, and a quote that
 * failed to load makes a value read `—` rather than making a transfer wrong.
 */
async function marketContext(portfolios: readonly PortfolioRecord[]): Promise<{
  prices: Record<string, MarketPriceInput>;
  optionQuotes: Record<string, OptionQuoteInput | null>;
}> {
  const symbols = [...new Set(portfolios
    .flatMap((portfolio) => portfolio.transactions)
    .filter((item) => item.type === 'acquisition' || item.type === 'disposal'
      || item.type === 'initial_position' || item.type === 'transfer_in' || item.type === 'transfer_out')
    .map((item) => item.symbol)
    .filter((value): value is string => Boolean(value)))];

  const prices: Record<string, MarketPriceInput> = {};
  try {
    const canonical = await loadPortfolioPrices(symbols);
    for (const symbol of symbols) {
      const item = canonical.get(symbol)?.display;
      if (!item || item.price === null) continue;
      prices[symbol] = {
        price: item.price,
        previousClose: item.change === null ? null : item.price - item.change,
        cached: item.status === 'saved',
        stale: item.freshness?.status === 'stale',
        source: 'canonical-market-snapshot',
        asOf: item.asOf,
      };
    }
  } catch {
    // A preview without prices still states quantities and cost basis, which is
    // what the move is actually made of.
  }

  let optionQuotes: Record<string, OptionQuoteInput | null> = {};
  try {
    const open = portfolios
      .flatMap((portfolio) => calculateOptionLedger(portfolio.transactions).positions)
      .filter((position) => position.status === 'open');
    if (open.length) {
      let service: ReturnType<typeof getOptionsMarketDataService> | null = null;
      try { service = getOptionsMarketDataService(); } catch { service = null; }
      optionQuotes = await loadPortfolioOptionQuotes(
        open,
        service
          ? async (underlying, expiration) => (await service!.getChain(underlying, expiration)).data
          : undefined,
      );
    }
  } catch {
    optionQuotes = {};
  }

  return { prices, optionQuotes };
}

function failureMessage(failure: TransferFailure): { code: string; message: string } {
  if (failure.code === 'same-portfolio') {
    return { code: 'same-portfolio', message: 'พอร์ตต้นทางและปลายทางต้องเป็นคนละพอร์ต' };
  }
  if (failure.code === 'source-not-found') {
    return { code: 'not-found', message: 'ไม่พบพอร์ตต้นทาง หรือพอร์ตนี้ถูกลบไปแล้ว' };
  }
  if (failure.code === 'destination-not-found') {
    return { code: 'not-found', message: 'ไม่พบพอร์ตปลายทาง หรือพอร์ตนี้ถูกลบไปแล้ว' };
  }
  if (failure.code === 'destination-unavailable') {
    return { code: 'archived', message: 'พอร์ตปลายทางถูก Archive แล้ว จึงรับสินทรัพย์ใหม่ไม่ได้' };
  }
  if (failure.error === 'nothing-selected') {
    return { code: 'nothing-selected', message: 'กรุณาเลือกสินทรัพย์หรือจำนวนเงินที่ต้องการย้ายอย่างน้อย 1 รายการ' };
  }
  if (failure.error === 'unknown-position') {
    return {
      code: 'stale',
      message: `ไม่พบ ${failure.subject ?? 'สินทรัพย์'} ในพอร์ตต้นทางแล้ว จำนวนสินทรัพย์เปลี่ยนไป กรุณาโหลดรายการใหม่`,
    };
  }
  if (failure.error === 'quantity-exceeds-open') {
    return {
      code: 'stale',
      message: `จำนวนของ ${failure.subject ?? 'สินทรัพย์'} ที่ถืออยู่จริงน้อยกว่าที่เลือกไว้ กรุณาโหลดรายการใหม่`,
    };
  }
  if (failure.error === 'quantity-not-positive') {
    return { code: 'invalid', message: 'จำนวนที่ย้ายต้องมากกว่า 0' };
  }
  return { code: 'invalid', message: 'จำนวนเงินสดที่ย้ายมากกว่าเงินสดที่มีอยู่จริงในพอร์ตต้นทาง' };
}

/**
 * Errors raised inside the transfer RPC. The typed ones are behaviour the
 * interface must react to differently — a stale preview is reloaded, everything
 * else is reported — so they are matched on the token the database raises rather
 * than on a message a locale could change.
 */
function transferFailure(error: unknown): { code: string; message: string } {
  const value = error as { code?: string; message?: string } | null;
  const entitlement = entitlementFailure(error);
  if (entitlement) return { code: entitlement.code, message: entitlement.message };
  const message = value?.message ?? '';
  if (message.includes('TRANSFER_POSITIONS_CHANGED')) {
    return {
      code: 'stale',
      message: 'จำนวนสินทรัพย์ในพอร์ตเปลี่ยนไปหลังจากที่คุณดูตัวอย่าง ระบบยังไม่ได้ย้ายอะไรเลย กรุณาตรวจสอบรายการใหม่อีกครั้ง',
    };
  }
  if (message.includes('TRANSFER_OPTION_EXPIRED')) {
    return { code: 'stale', message: 'สัญญาออปชันหมดอายุแล้ว จึงย้ายไม่ได้ กรุณาโหลดรายการใหม่' };
  }
  if (message.includes('TRANSFER_PORTFOLIO_DELETED')) {
    return { code: 'not-found', message: 'พอร์ตต้นทางหรือปลายทางถูกลบไปแล้ว' };
  }
  if (message.includes('TRANSFER_NOTHING_TO_MOVE') || message.includes('TRANSFER_EMPTY_LEG')) {
    return { code: 'nothing-selected', message: 'ไม่มีสินทรัพย์ที่ย้ายได้ในรายการที่เลือก' };
  }
  if (value?.code === '42501') {
    return { code: 'unauthorized', message: 'คุณไม่มีสิทธิ์ย้ายสินทรัพย์ระหว่างพอร์ตนี้' };
  }
  if (value?.code === '23514') {
    return { code: 'constraint', message: 'ย้ายไม่สำเร็จเพราะจำนวนสินทรัพย์ไม่ตรงกับที่ถืออยู่จริง ระบบไม่ได้บันทึกอะไรเลย' };
  }
  return { code: 'database', message: 'ย้ายสินทรัพย์ไม่สำเร็จ ระบบไม่ได้บันทึกรายการใด ๆ กรุณาลองอีกครั้ง' };
}

const selectionSchema = z.object({
  sourcePortfolioId: uuid,
  destinationPortfolioId: uuid,
  equities: z.array(z.object({
    symbol: z.string().trim().min(1).max(24),
    quantity: z.number().finite().positive(),
  })).max(200).default([]),
  options: z.array(z.object({
    key: z.string().trim().min(1).max(96),
    contracts: z.number().finite().positive(),
  })).max(200).default([]),
  cashUsd: z.number().finite().nonnegative().max(1_000_000_000_000).default(0),
});

/** What the source still holds, for the "choose what to move" step. */
export async function loadTransferableAssetsAction(raw: unknown): Promise<TransferActionResult<{
  assets: TransferableAssets;
  destinations: { id: string; name: string; type: PortfolioRecord['type'] }[];
}>> {
  const input = z.object({ portfolioId: uuid }).safeParse(raw);
  if (!input.success) return { ok: false, code: 'invalid', message: 'ไม่พบพอร์ตที่ต้องการย้ายสินทรัพย์' };
  const resolved = await context();
  if (!resolved) return { ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };
  try {
    const portfolios = await resolved.repository.getAll();
    const source = portfolios.find((item) => item.id === input.data.portfolioId);
    if (!source) return { ok: false, code: 'not-found', message: 'ไม่พบพอร์ตที่ต้องการย้ายสินทรัพย์' };
    const market = await marketContext(portfolios);
    return {
      ok: true,
      assets: transferableAssets(calculatePortfolio(source.transactions, market.prices, market.optionQuotes)),
      destinations: portfolios
        .filter((item) => item.id !== source.id && item.archivedAt === null)
        .map((item) => ({ id: item.id, name: item.name, type: item.type })),
    };
  } catch {
    return { ok: false, code: 'database', message: 'โหลดสินทรัพย์ในพอร์ตไม่สำเร็จ กรุณาลองอีกครั้ง' };
  }
}

/**
 * The preview, and the id the confirmation will replay.
 *
 * The group id is minted here rather than on confirm, so the plan a reader
 * looked at and the plan that gets written are the same identified thing — and
 * so two clicks on the confirm button carry one id between them.
 */
export async function previewAssetTransferAction(raw: unknown): Promise<TransferActionResult<{
  preview: TransferPreview;
  groupId: string;
}>> {
  const input = selectionSchema.safeParse(raw);
  if (!input.success) return { ok: false, code: 'invalid', message: input.error.issues[0].message };
  const resolved = await context();
  if (!resolved) return { ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };
  try {
    const portfolios = await resolved.repository.getAll();
    const market = await marketContext(portfolios);
    const contextResult = resolveTransferContext(
      portfolios,
      input.data.sourcePortfolioId,
      input.data.destinationPortfolioId,
      market.prices,
      market.optionQuotes,
    );
    if (!contextResult.ok) return { ok: false, ...failureMessage(contextResult.failure) };
    const destinationCash = calculatePortfolio(
      contextResult.context.destination.transactions,
      market.prices,
      market.optionQuotes,
    ).cashBalance;
    const preview = buildTransferPreview(
      contextResult.context,
      destinationCash,
      {
        equities: input.data.equities,
        options: input.data.options,
        cashUsd: input.data.cashUsd,
      },
      randomUUID,
    );
    if (!preview.ok) return { ok: false, ...failureMessage(preview.failure) };
    return { ok: true, preview: preview.preview, groupId: randomUUID() };
  } catch {
    return { ok: false, code: 'database', message: 'สร้างตัวอย่างการย้ายไม่สำเร็จ กรุณาลองอีกครั้ง' };
  }
}

const confirmSchema = selectionSchema.extend({
  groupId: uuid,
  note: z.string().trim().max(500).optional(),
});

/**
 * Confirmation, which rebuilds the plan from scratch rather than accepting the
 * one the preview returned. The preview is a picture; this is the transaction,
 * and the two are allowed to disagree — if they do, the database's fingerprint
 * check refuses the write and the reader is asked to look again.
 */
export async function confirmAssetTransferAction(raw: unknown): Promise<TransferActionResult<{
  destinationId: string;
  destinationName: string;
  alreadyApplied: boolean;
}>> {
  const input = confirmSchema.safeParse(raw);
  if (!input.success) return { ok: false, code: 'invalid', message: input.error.issues[0].message };
  const resolved = await context();
  if (!resolved) return { ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };
  try {
    const portfolios = await resolved.repository.getAll();
    const market = await marketContext(portfolios);
    const contextResult = resolveTransferContext(
      portfolios,
      input.data.sourcePortfolioId,
      input.data.destinationPortfolioId,
      market.prices,
      market.optionQuotes,
    );
    if (!contextResult.ok) return { ok: false, ...failureMessage(contextResult.failure) };
    const preview = buildTransferPreview(
      contextResult.context,
      0,
      {
        equities: input.data.equities,
        options: input.data.options,
        cashUsd: input.data.cashUsd,
      },
      randomUUID,
    );
    if (!preview.ok) return { ok: false, ...failureMessage(preview.failure) };

    const result = await commitTransfer(resolved.repository, {
      sourceId: contextResult.context.source.id,
      destinationId: contextResult.context.destination.id,
      groupId: input.data.groupId,
      plan: preview.preview.plan,
      occurredAt: new Date().toISOString(),
      note: input.data.note,
    });
    revalidatePath('/portfolio');
    revalidatePath('/portfolio/transactions');
    revalidatePath('/');
    return {
      ok: true,
      destinationId: contextResult.context.destination.id,
      destinationName: contextResult.context.destination.name,
      alreadyApplied: result.alreadyApplied,
    };
  } catch (error) {
    return { ok: false, ...transferFailure(error) };
  }
}

/** The facts the delete dialog states, read fresh when the dialog opens. */
export async function loadPortfolioDeletionSummaryAction(raw: unknown): Promise<TransferActionResult<{
  summary: PortfolioDeletionSummary;
}>> {
  const input = z.object({ portfolioId: uuid }).safeParse(raw);
  if (!input.success) return { ok: false, code: 'invalid', message: 'ไม่พบพอร์ตที่ต้องการลบ' };
  const resolved = await context();
  if (!resolved) return { ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };
  try {
    const portfolios = await resolved.repository.getAll();
    const market = await marketContext(portfolios);
    const summary = buildPortfolioDeletionSummary(
      portfolios,
      input.data.portfolioId,
      market.prices,
      market.optionQuotes,
    );
    if (!summary) return { ok: false, code: 'not-found', message: 'ไม่พบพอร์ตที่ต้องการลบ' };
    return { ok: true, summary };
  } catch {
    return { ok: false, code: 'database', message: 'โหลดข้อมูลพอร์ตไม่สำเร็จ กรุณาลองอีกครั้ง' };
  }
}
