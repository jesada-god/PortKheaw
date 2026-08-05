'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/src/lib/supabase/server';
import { getOptionsMarketDataService } from '@/src/lib/market-data/options';
import { calculatePortfolio } from '@/src/lib/portfolio/calculations';
import { PortfolioRepository } from '@/src/lib/portfolio/repository';
import { purchaseOptionFromChain } from '@/src/lib/portfolio/options/purchase-service';
import { denyEntitlement } from '@/src/lib/subscription/entitlement-guard';
import { resolveRequestEntitlement } from '@/src/lib/subscription/server-entitlement';
import { entitlementFailure } from '@/src/lib/subscription/entitlement-errors';
import { portfolioCreationEntitlement } from '@/src/lib/subscription/subscription-limits';

export type OptionPurchasePortfolioChoice = {
  id: string;
  name: string;
  cashBalance: number;
};

export type OptionPurchaseActionResult = Awaited<ReturnType<typeof purchaseOptionFromChain>>
  | { ok: false; code: 'unauthorized' | 'upgrade-required' | 'database'; message: string };

export type OptionPurchasePortfoliosResult =
  | { ok: true; portfolios: OptionPurchasePortfolioChoice[]; atLimit: boolean; timezone: string }
  | { ok: false; code: 'unauthorized' | 'upgrade-required' | 'database'; message: string };

async function context() {
  const entitlement = await resolveRequestEntitlement();
  const denial = denyEntitlement(entitlement, 'portfolio.options.create');
  if (denial) return { denial, entitlement, repository: null };
  const client = await createClient();
  if (!client) return { denial: null, entitlement, repository: null };
  const { data: { user } } = await client.auth.getUser();
  return { denial: null, entitlement, repository: user ? new PortfolioRepository(client) : null };
}

function denied(code: 'AUTHENTICATION_REQUIRED' | 'UPGRADE_REQUIRED', message: string) {
  return {
    ok: false as const,
    code: code === 'AUTHENTICATION_REQUIRED' ? 'unauthorized' as const : 'upgrade-required' as const,
    message,
  };
}

function databaseFailure(error: unknown): OptionPurchaseActionResult {
  const entitlement = entitlementFailure(error);
  if (entitlement) return denied('UPGRADE_REQUIRED', entitlement.message);
  const message = (error as { message?: string } | null)?.message ?? '';
  if (message.includes('INSUFFICIENT_CASH')) {
    return { ok: false, code: 'insufficient-cash', message: 'เงินสดในพอร์ตไม่พอสำหรับรายการนี้' };
  }
  if (message.includes('IDEMPOTENCY_CONFLICT')) {
    return { ok: false, code: 'database', message: 'คำขอนี้ถูกใช้กับข้อมูลอื่นแล้ว กรุณาปิด Sheet แล้วลองใหม่' };
  }
  return { ok: false, code: 'database', message: 'เพิ่มออปชันเข้าพอร์ตไม่สำเร็จ กรุณาลองใหม่' };
}

export async function loadOptionPurchasePortfoliosAction(): Promise<OptionPurchasePortfoliosResult> {
  const resolved = await context();
  if (resolved.denial) return denied(resolved.denial.code, resolved.denial.message);
  if (!resolved.repository) return denied('AUTHENTICATION_REQUIRED', 'กรุณาเข้าสู่ระบบอีกครั้ง');
  try {
    const [portfolios, timezone] = await Promise.all([
      resolved.repository.getAll(),
      resolved.repository.getTimeZone(),
    ]);
    const activeOptions = portfolios.filter((portfolio) => portfolio.type === 'OPTION' && portfolio.archivedAt === null);
    const limit = portfolioCreationEntitlement(resolved.entitlement.tier, 'OPTION').maxCount;
    return {
      ok: true,
      portfolios: activeOptions.map((portfolio) => ({
        id: portfolio.id,
        name: portfolio.name,
        cashBalance: calculatePortfolio(portfolio.transactions).cashBalance,
      })),
      atLimit: activeOptions.length >= limit,
      timezone,
    };
  } catch {
    return { ok: false, code: 'database', message: 'โหลดพอร์ตออปชันไม่สำเร็จ' };
  }
}

export async function purchaseOptionFromChainAction(raw: unknown): Promise<OptionPurchaseActionResult> {
  const resolved = await context();
  if (resolved.denial) return denied(resolved.denial.code, resolved.denial.message);
  if (!resolved.repository) return denied('AUTHENTICATION_REQUIRED', 'กรุณาเข้าสู่ระบบอีกครั้ง');
  try {
    const result = await purchaseOptionFromChain(raw, {
      now: Date.now,
      loadChain: async (symbol, expiration) => (await getOptionsMarketDataService().getChain(symbol, expiration)).data,
      loadPortfolio: (id) => resolved.repository!.getById(id),
      create: (input, quote) => resolved.repository!.createOptionPurchase(input, quote),
    });
    if (result.ok) {
      revalidatePath('/portfolio');
      revalidatePath('/');
    }
    return result;
  } catch (error) {
    return databaseFailure(error);
  }
}
