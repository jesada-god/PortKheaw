'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/src/lib/supabase/server';
import { AlertsRepository } from '@/src/lib/alerts/repository';
import type { AlertActionResult } from '@/src/lib/alerts/types';
import { symbolSchema } from '@/src/lib/market-data/validation';
import { getInstrumentStatus } from '@/src/lib/instruments/status';

const alertIdSchema = z.uuid();
/**
 * The same five conditions the column admits, with the one bound that is not
 * the column's.
 *
 * `earnings` measures `targetValue` in WHOLE DAYS — the calendar resolves to
 * days, so a fractional threshold would compare a precise number against a
 * rounded one. `price_alerts_earnings_target_check` says so in the database
 * too; this says it here so the reader gets a sentence instead of a constraint
 * violation.
 */
const alertInputSchema = z.object({
  symbol: symbolSchema,
  condition: z.enum(['above', 'below', 'percent_change_up', 'percent_change_down', 'earnings']),
  targetValue: z.number().finite().positive().max(1_000_000_000),
  cooldownMinutes: z.number().int().min(1).max(10080),
  enabled: z.boolean(),
}).refine(
  (input) => input.condition !== 'earnings'
    || (Number.isInteger(input.targetValue) && input.targetValue >= 1 && input.targetValue <= 365),
  { path: ['targetValue'], message: 'earnings alerts count whole days, 1 to 365' },
);
export type AlertInput = z.infer<typeof alertInputSchema>;

async function context() {
  const client = await createClient();
  if (!client) return null;
  const { data: { user } } = await client.auth.getUser();
  return user ? { client, repo: new AlertsRepository(client, user.id) } : null;
}

function failure(error: unknown): AlertActionResult {
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
  if (code === '42501' || code.startsWith('PGRST')) return { ok: false, code: 'unauthorized', message: 'คุณไม่มีสิทธิ์แก้ไข Price Alert นี้' };
  /*
    23514 is the column's CHECK refusing the row, and there is one way for a
    reader to reach it with input this action has already validated: the
    deployment is running ahead of its database and `202609200001` — the
    migration that widens `price_alerts_condition_check` to admit `earnings` —
    has not been applied yet.

    Named rather than folded into the generic database failure, because the two
    call for different actions: "try again" is useless advice for a schema that
    will keep refusing, and an operator reading this message knows immediately
    which migration is missing.
  */
  if (code === '23514') return { ok: false, code: 'unsupported', message: 'ระบบยังไม่รองรับเงื่อนไขนี้ กรุณาแจ้งผู้ดูแลให้อัปเดตฐานข้อมูล' };
  return { ok: false, code: 'database', message: 'บันทึก Price Alert ไม่สำเร็จ กรุณาลองอีกครั้ง' };
}

export async function createAlertAction(raw: AlertInput): Promise<AlertActionResult> {
  const parsed = alertInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, code: 'invalid', message: 'ข้อมูล Price Alert ไม่ถูกต้อง' };
  const ctx = await context();
  if (!ctx) return { ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };
  try {
    if (await getInstrumentStatus(ctx.client, parsed.data.symbol) === 'delisted') return { ok: false, code: 'delisted', message: 'ไม่สามารถสร้าง Alert ใหม่สำหรับ Symbol ที่ delisted' };
    const alert = await ctx.repo.create(parsed.data);
    revalidatePath('/alerts');
    return { ok: true, alert };
  } catch (error) { return failure(error); }
}

export async function updateAlertAction(rawId: string, raw: AlertInput): Promise<AlertActionResult> {
  const id = alertIdSchema.safeParse(rawId); const input = alertInputSchema.safeParse(raw);
  if (!id.success || !input.success) return { ok: false, code: 'invalid', message: 'ข้อมูล Price Alert ไม่ถูกต้อง' };
  const ctx = await context();
  if (!ctx) return { ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };
  try {
    const alert = await ctx.repo.update(id.data, input.data);
    if (!alert) return { ok: false, code: 'not-found', message: 'ไม่พบ Price Alert หรือคุณไม่มีสิทธิ์แก้ไข' };
    revalidatePath('/alerts'); return { ok: true, alert };
  } catch (error) { return failure(error); }
}

export async function setAlertEnabledAction(rawId: string, enabled: boolean): Promise<AlertActionResult> {
  const id = alertIdSchema.safeParse(rawId);
  if (!id.success || typeof enabled !== 'boolean') return { ok: false, code: 'invalid', message: 'ข้อมูลไม่ถูกต้อง' };
  const ctx = await context(); if (!ctx) return { ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };
  try { const changed = await ctx.repo.setEnabled(id.data, enabled); if (!changed) return { ok: false, code: 'not-found', message: 'ไม่พบ Price Alert' };
    revalidatePath('/alerts'); return { ok: true }; } catch (error) { return failure(error); }
}

export async function deleteAlertAction(rawId: string): Promise<AlertActionResult> {
  const id = alertIdSchema.safeParse(rawId);
  if (!id.success) return { ok: false, code: 'invalid', message: 'ข้อมูลไม่ถูกต้อง' };
  const ctx = await context(); if (!ctx) return { ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };
  try { const removed = await ctx.repo.remove(id.data); if (!removed) return { ok: false, code: 'not-found', message: 'ไม่พบ Price Alert' };
    revalidatePath('/alerts'); return { ok: true }; } catch (error) { return failure(error); }
}

