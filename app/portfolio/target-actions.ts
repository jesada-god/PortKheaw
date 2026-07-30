'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/src/lib/supabase/server';
import { PortfolioRepository } from '@/src/lib/portfolio/repository';
import { calculateOptionLedger, calculateOptionTarget } from '@/src/lib/portfolio/options/calculations';
import { OptionTargetRepository } from '@/src/lib/portfolio/options/target-repository';
import type { PortfolioActionResult } from './actions';

const targetSchema = z.object({
  id: z.string().uuid().optional(),
  contractSymbol: z.string().trim().toUpperCase().min(3).max(80),
  mode: z.enum(['premium', 'profit_percent']),
  targetValue: z.number().finite().nonnegative().max(1_000_000),
  estimatedFee: z.number().finite().nonnegative().max(1_000_000),
});

async function context() {
  const client = await createClient();
  if (!client) return null;
  const { data: { user } } = await client.auth.getUser();
  if (!user) return null;
  return {
    portfolio: new PortfolioRepository(client),
    targets: new OptionTargetRepository(client),
  };
}

export async function upsertOptionTargetAction(raw: unknown): Promise<PortfolioActionResult> {
  const input = targetSchema.safeParse(raw);
  if (!input.success) return { ok: false, code: 'invalid', message: 'ข้อมูลเป้าหมายขายไม่ถูกต้อง' };
  const ctx = await context();
  if (!ctx) return { ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };
  try {
    const portfolio = await ctx.portfolio.getDefault();
    const position = calculateOptionLedger(portfolio.transactions).positions
      .find((item) => item.contractSymbol === input.data.contractSymbol && item.status === 'open');
    if (!position) return { ok: false, code: 'not-found', message: 'ไม่พบสถานะออปชันเปิดสำหรับเป้าหมายนี้' };
    const calculation = calculateOptionTarget(position, input.data.mode, input.data.targetValue, input.data.estimatedFee);
    await ctx.targets.upsert({
      ...input.data,
      side: position.side,
      targetPremium: calculation.targetPremium,
    });
    revalidatePath('/portfolio');
    return { ok: true };
  } catch {
    return { ok: false, code: 'database', message: 'บันทึกเป้าหมายขายไม่สำเร็จ กรุณาลองอีกครั้ง' };
  }
}

export async function deleteOptionTargetAction(id: string): Promise<PortfolioActionResult> {
  if (!z.string().uuid().safeParse(id).success) return { ok: false, code: 'invalid', message: 'ไม่พบเป้าหมายขาย' };
  const ctx = await context();
  if (!ctx) return { ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };
  try {
    await ctx.targets.delete(id);
    revalidatePath('/portfolio');
    return { ok: true };
  } catch {
    return { ok: false, code: 'database', message: 'ลบเป้าหมายขายไม่สำเร็จ กรุณาลองอีกครั้ง' };
  }
}
