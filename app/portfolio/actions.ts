'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/src/lib/supabase/server';
import { PortfolioRepository } from '@/src/lib/portfolio/repository';
import { portfolioTransactionSchema } from '@/src/lib/portfolio/validation';
import { getInstrumentStatus } from '@/src/lib/instruments/status';

export type PortfolioActionResult = { ok: true } | { ok: false; code: string; message: string; fields?: Record<string, string> };

async function repository() {
  const client = await createClient();
  if (!client) return null;
  const { data: { user } } = await client.auth.getUser();
  return user ? new PortfolioRepository(client) : null;
}

function failure(error: unknown): PortfolioActionResult {
  const value = error as { code?: string; message?: string } | null;
  if (value?.code === '23514') return { ok: false, code: 'insufficient-position', message: 'รายการนี้ทำให้จำนวนหุ้นหรือสัญญาติดลบ กรุณาตรวจจำนวนและลำดับเวลาใน Ledger' };
  if (value?.code === '42501') return { ok: false, code: 'unauthorized', message: 'คุณไม่มีสิทธิ์แก้ไขรายการนี้' };
  return { ok: false, code: 'database', message: 'บันทึกข้อมูลไม่สำเร็จ กรุณาลองอีกครั้ง' };
}

function parse(raw: unknown): PortfolioActionResult | ReturnType<typeof portfolioTransactionSchema.parse> {
  const result = portfolioTransactionSchema.safeParse(raw);
  if (result.success) return result.data;
  const fields: Record<string, string> = {};
  for (const issue of result.error.issues) fields[String(issue.path[0] ?? 'form')] ??= issue.message;
  return { ok: false, code: 'invalid', message: 'กรุณาตรวจสอบข้อมูลที่กรอก', fields };
}

export async function createPortfolioTransactionAction(raw: unknown): Promise<PortfolioActionResult> {
  const input = parse(raw);
  if ('ok' in input) return input;
  const repo = await repository();
  if (!repo) return { ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };
  try {
    const openingSymbol = input.type === 'acquisition' || input.type === 'initial_position'
      ? input.symbol
      : input.type === 'buy_to_open' || input.type === 'sell_to_open'
        ? input.underlyingSymbol
        : null;
    if (openingSymbol) {
      const client = await createClient();
      if (client && await getInstrumentStatus(client, openingSymbol) === 'delisted') {
        return { ok: false, code: 'delisted', message: 'ไม่สามารถเปิดสถานะใหม่ของ Symbol ที่ delisted แล้ว' };
      }
    }
    await repo.create(input);
    revalidatePath('/portfolio');
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

export async function updatePortfolioTransactionAction(id: string, raw: unknown): Promise<PortfolioActionResult> {
  if (!isUuid(id)) return { ok: false, code: 'invalid', message: 'ไม่พบรายการที่ต้องการแก้ไข' };
  const input = parse(raw);
  if ('ok' in input) return input;
  const repo = await repository();
  if (!repo) return { ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };
  try {
    await repo.update(id, input);
    revalidatePath('/portfolio');
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

export async function deletePortfolioTransactionAction(id: string): Promise<PortfolioActionResult> {
  if (!isUuid(id)) return { ok: false, code: 'invalid', message: 'ไม่พบรายการที่ต้องการลบ' };
  const repo = await repository();
  if (!repo) return { ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };
  try {
    await repo.delete(id);
    revalidatePath('/portfolio');
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

export async function setPortfolioBaseCurrencyAction(raw: unknown): Promise<PortfolioActionResult> {
  if (raw !== 'USD' && raw !== 'THB') return { ok: false, code: 'invalid', message: 'สกุลเงินไม่ถูกต้อง' };
  const repo = await repository();
  if (!repo) return { ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };
  try {
    await repo.setBaseCurrency(raw);
    revalidatePath('/portfolio');
    revalidatePath('/settings');
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
