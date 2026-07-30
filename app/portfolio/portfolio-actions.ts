'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { PortfolioRepository } from '@/src/lib/portfolio/repository';
import { createClient } from '@/src/lib/supabase/server';
import type { PortfolioActionResult } from './actions';

const portfolioName = z.string().trim().min(1, 'กรุณาตั้งชื่อพอร์ต').max(40, 'ชื่อพอร์ตต้องไม่เกิน 40 ตัวอักษร');
const portfolioType = z.enum(['STOCK', 'OPTION']);
const uuid = z.string().uuid();

async function repository() {
  const client = await createClient();
  if (!client) return null;
  const { data: { user } } = await client.auth.getUser();
  return user ? new PortfolioRepository(client) : null;
}

function resultFor(error: unknown): PortfolioActionResult {
  const value = error as { code?: string; message?: string } | null;
  if (value?.code === '23505') return { ok: false, code: 'duplicate', message: 'ชื่อพอร์ตนี้ซ้ำกับพอร์ตประเภทเดียวกัน (ระบบไม่แยกตัวพิมพ์เล็ก/ใหญ่)' };
  if (value?.code === '42501') return { ok: false, code: 'unauthorized', message: 'ไม่พบพอร์ตหรือคุณไม่มีสิทธิ์จัดการพอร์ตนี้' };
  if (value?.code === '23514') {
    if (value.message?.includes('Portfolio limit')) return { ok: false, code: 'limit', message: 'สร้างพอร์ตประเภทนี้ได้สูงสุด 10 พอร์ต' };
    if (value.message?.includes('type cannot change')) return { ok: false, code: 'has-transactions', message: 'เปลี่ยนประเภทไม่ได้เพราะพอร์ตนี้มีรายการใน Transaction Ledger แล้ว' };
    if (value.message?.includes('archived')) return { ok: false, code: 'archived', message: 'พอร์ตที่ Archive แล้วรับรายการใหม่ไม่ได้' };
    if (value.message?.includes('must be archived')) return { ok: false, code: 'not-empty', message: 'พอร์ตนี้มีประวัติรายการ จึงต้อง Archive แทนการลบถาวร' };
    return { ok: false, code: 'constraint', message: 'พอร์ตนี้ยังไม่ผ่านเงื่อนไขที่จำเป็นสำหรับการดำเนินการ' };
  }
  if (value?.code === '22023') return { ok: false, code: 'invalid', message: value.message ?? 'ข้อมูลพอร์ตไม่ถูกต้อง' };
  return { ok: false, code: 'database', message: 'บันทึกข้อมูลพอร์ตไม่สำเร็จ กรุณาลองอีกครั้ง' };
}

function refreshPortfolio() {
  revalidatePath('/portfolio');
  revalidatePath('/');
}

export async function createPortfolioAction(raw: unknown): Promise<PortfolioActionResult> {
  const input = z.object({ name: portfolioName, type: portfolioType }).safeParse(raw);
  if (!input.success) return { ok: false, code: 'invalid', message: input.error.issues[0].message };
  const repo = await repository();
  if (!repo) return { ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };
  try {
    await repo.createPortfolio(input.data.name, input.data.type);
    refreshPortfolio();
    return { ok: true };
  } catch (error) {
    return resultFor(error);
  }
}

export async function updatePortfolioAction(raw: unknown): Promise<PortfolioActionResult> {
  const input = z.object({ id: uuid, name: portfolioName, type: z.enum(['STOCK', 'OPTION', 'LEGACY']) }).safeParse(raw);
  if (!input.success) return { ok: false, code: 'invalid', message: input.error.issues[0].message };
  const repo = await repository();
  if (!repo) return { ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };
  try {
    await repo.updatePortfolio(input.data.id, input.data.name, input.data.type);
    refreshPortfolio();
    return { ok: true };
  } catch (error) {
    return resultFor(error);
  }
}

const goalSchema = z.object({
  portfolioId: uuid.nullable(),
  targetValueUsd: z.union([z.number().finite().positive().max(1_000_000_000_000), z.null()]),
  targetDate: z.union([z.string().date(), z.null()]),
}).refine((value) => value.targetValueUsd !== null || value.targetDate === null, {
  message: 'วันที่เป้าหมายต้องมีจำนวนเงินเป้าหมาย',
});

export async function setPortfolioGoalAction(raw: unknown): Promise<PortfolioActionResult> {
  const input = goalSchema.safeParse(raw);
  if (!input.success) return { ok: false, code: 'invalid', message: input.error.issues[0].message };
  const repo = await repository();
  if (!repo) return { ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };
  try {
    const goal = { targetValueUsd: input.data.targetValueUsd, targetDate: input.data.targetDate };
    if (input.data.portfolioId) await repo.setPortfolioGoal(input.data.portfolioId, goal);
    else await repo.setAggregateGoal(goal);
    refreshPortfolio();
    return { ok: true };
  } catch (error) {
    return resultFor(error);
  }
}

export async function archivePortfolioAction(id: string): Promise<PortfolioActionResult> {
  if (!uuid.safeParse(id).success) return { ok: false, code: 'invalid', message: 'ไม่พบพอร์ตที่ต้องการ Archive' };
  const repo = await repository();
  if (!repo) return { ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };
  try {
    await repo.archivePortfolio(id);
    refreshPortfolio();
    return { ok: true };
  } catch (error) {
    return resultFor(error);
  }
}

export async function restorePortfolioAction(id: string): Promise<PortfolioActionResult> {
  if (!uuid.safeParse(id).success) return { ok: false, code: 'invalid', message: 'ไม่พบพอร์ตที่ต้องการนำกลับมาใช้' };
  const repo = await repository();
  if (!repo) return { ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };
  try {
    await repo.restorePortfolio(id);
    refreshPortfolio();
    return { ok: true };
  } catch (error) {
    return resultFor(error);
  }
}

export async function deletePortfolioAction(id: string): Promise<PortfolioActionResult> {
  if (!uuid.safeParse(id).success) return { ok: false, code: 'invalid', message: 'ไม่พบพอร์ตที่ต้องการลบ' };
  const repo = await repository();
  if (!repo) return { ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };
  try {
    await repo.deleteEmptyPortfolio(id);
    refreshPortfolio();
    return { ok: true };
  } catch (error) {
    return resultFor(error);
  }
}

const transferSchema = z.object({
  sourcePortfolioId: uuid,
  destinationPortfolioId: uuid,
  amountUsd: z.number().finite().positive().max(1_000_000_000_000),
  occurredAt: z.string().min(1),
  note: z.string().trim().max(500).optional(),
  idempotencyKey: uuid,
}).refine((value) => value.sourcePortfolioId !== value.destinationPortfolioId, {
  message: 'พอร์ตต้นทางและปลายทางต้องเป็นคนละพอร์ต',
});

export async function transferPortfolioCashAction(raw: unknown): Promise<PortfolioActionResult> {
  const input = transferSchema.safeParse(raw);
  if (!input.success) return { ok: false, code: 'invalid', message: input.error.issues[0].message };
  const repo = await repository();
  if (!repo) return { ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };
  try {
    const occurredAt = /(?:Z|[+-]\d{2}:\d{2})$/.test(input.data.occurredAt)
      ? input.data.occurredAt
      : `${input.data.occurredAt}${input.data.occurredAt.length === 16 ? ':00' : ''}+07:00`;
    await repo.transferCash({ ...input.data, occurredAt });
    refreshPortfolio();
    return { ok: true };
  } catch (error) {
    return resultFor(error);
  }
}
