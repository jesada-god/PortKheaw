'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/src/lib/supabase/server';
import { symbolSchema } from '@/src/lib/market-data/validation';
import { WatchlistRepository } from '@/src/lib/watchlist/repository';
import type { WatchlistActionResult } from '@/src/lib/watchlist/types';
import { getInstrumentStatus } from '@/src/lib/instruments/status';
import { ensureInstrumentLogo } from '@/src/lib/instruments/presentation';

const nameSchema = z.string().trim().min(1).max(80);

async function repository() {
  const client = await createClient();
  if (!client) return null;
  const { data: { user } } = await client.auth.getUser();
  return user ? new WatchlistRepository(client) : null;
}

function failure(error: unknown): WatchlistActionResult {
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
  if (code === '23505') return { ok: false, code: 'duplicate', message: 'Symbol นี้อยู่ในรายการติดตามแล้ว' };
  if (code === '42501' || code.startsWith('PGRST')) return { ok: false, code: 'unauthorized', message: 'คุณไม่มีสิทธิ์แก้ไขรายการติดตามนี้' };
  return { ok: false, code: 'database', message: 'บันทึกรายการติดตามไม่สำเร็จ กรุณาลองอีกครั้ง' };
}

export async function addWatchlistItemAction(rawSymbol: string): Promise<WatchlistActionResult> {
  const parsed = symbolSchema.safeParse(rawSymbol);
  if (!parsed.success) return { ok: false, code: 'invalid', message: 'Symbol ไม่ถูกต้อง' };
  const repo = await repository();
  if (!repo) return { ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };
  try {
    const client = await createClient();
    if (client && await getInstrumentStatus(client, parsed.data) === 'delisted') {
      return { ok: false, code: 'delisted', message: 'Symbol นี้ถูก delisted แล้ว จึงไม่สามารถเพิ่มเป็นรายการใหม่ได้' };
    }
    const item = await repo.add(parsed.data);
    /*
     * First sighting of this symbol on this account: resolve and persist its
     * logo now, in the mutation that created the row, and hand the URL back with
     * it. Without this the new row renders a monogram until some later request
     * happens to resolve it — which is exactly what a reader reports as "the
     * logo does not show up".
     */
    const logo = await ensureInstrumentLogo(parsed.data);
    revalidatePath('/watchlist');
    return { ok: true, item, logoUrl: logo.logoUrl, companyName: logo.companyName };
  } catch (error) {
    return failure(error);
  }
}

export async function removeWatchlistItemAction(rawSymbol: string): Promise<WatchlistActionResult> {
  const parsed = symbolSchema.safeParse(rawSymbol);
  if (!parsed.success) return { ok: false, code: 'invalid', message: 'Symbol ไม่ถูกต้อง' };
  const repo = await repository();
  if (!repo) return { ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };
  try {
    const removed = await repo.remove(parsed.data);
    if (!removed) return { ok: false, code: 'not-found', message: 'ไม่พบ Symbol ในรายการติดตาม' };
    revalidatePath('/watchlist');
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

export async function renameWatchlistAction(rawName: string): Promise<WatchlistActionResult> {
  const parsed = nameSchema.safeParse(rawName);
  if (!parsed.success) return { ok: false, code: 'invalid', message: 'ชื่อต้องมี 1–80 ตัวอักษร' };
  const repo = await repository();
  if (!repo) return { ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง' };
  try {
    await repo.rename(parsed.data);
    revalidatePath('/watchlist');
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}
