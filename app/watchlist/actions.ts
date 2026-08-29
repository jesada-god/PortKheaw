'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/src/lib/supabase/server';
import { symbolSchema } from '@/src/lib/market-data/validation';
import { WatchlistRepository } from '@/src/lib/watchlist/repository';
import { WATCHLIST_NAME_MAX, checkWatchlistName } from '@/src/lib/watchlist/naming';
import type { WatchlistActionResult } from '@/src/lib/watchlist/types';
import { getInstrumentStatus } from '@/src/lib/instruments/status';
import { ensureInstrumentLogo } from '@/src/lib/instruments/presentation';

const nameSchema = z.string().trim().min(1).max(WATCHLIST_NAME_MAX);
const idSchema = z.string().uuid();

async function repository() {
  const client = await createClient();
  if (!client) return null;
  const { data: { user } } = await client.auth.getUser();
  return user ? new WatchlistRepository(client) : null;
}

/**
 * A database error, as a sentence a reader can act on.
 *
 * The codes are the contract between the guarded functions and this layer, and
 * each one exists because "บันทึกไม่สำเร็จ" is the wrong answer to it:
 *
 *   23505  a unique index refused the write. Two of them can — a symbol already
 *          in this list, and a list name already used — so the CALLER supplies
 *          the sentence; only it knows which write it was making.
 *   23514  `delete_watchlist` refused to remove the reader's only list. A rule,
 *          not a fault, and a reader told "something went wrong" would retry it.
 *   54000  the twenty-list ceiling.
 *   42501  not the caller's row, or no session. `rename_watchlist` and
 *          `delete_watchlist` raise this for a list that is not theirs rather
 *          than confirming the id exists.
 */
function failure(error: unknown, duplicateMessage?: string): WatchlistActionResult {
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
  if (code === '23505') {
    return {
      ok: false,
      code: 'duplicate',
      message: duplicateMessage ?? 'Symbol นี้อยู่ในรายการติดตามแล้ว',
    };
  }
  if (code === '23514') {
    return {
      ok: false,
      code: 'last-list',
      message: 'ลบไม่ได้ เพราะนี่เป็นรายการสุดท้ายที่เหลืออยู่ สร้างรายการใหม่ก่อนแล้วค่อยลบรายการนี้',
    };
  }
  if (code === '54000') {
    return { ok: false, code: 'limit', message: 'สร้างได้สูงสุด 20 รายการ ลบรายการที่ไม่ได้ใช้ก่อน' };
  }
  if (code === '42501' || code.startsWith('PGRST')) {
    return { ok: false, code: 'unauthorized', message: 'คุณไม่มีสิทธิ์แก้ไขรายการติดตามนี้' };
  }
  return { ok: false, code: 'database', message: 'บันทึกรายการติดตามไม่สำเร็จ กรุณาลองอีกครั้ง' };
}

const unauthorized: WatchlistActionResult = {
  ok: false, code: 'unauthorized', message: 'กรุณาเข้าสู่ระบบอีกครั้ง',
};

/**
 * `watchlistId` is optional on the item actions and defaults to the reader's
 * default list, which keeps every existing caller working unchanged. When it IS
 * supplied it is validated as a uuid here and checked for ownership by RLS on
 * the write itself — a malformed id must not reach the database as a filter.
 */
function optionalId(raw: string | undefined): string | null | 'invalid' {
  if (raw === undefined) return null;
  return idSchema.safeParse(raw).success ? raw : 'invalid';
}

export async function addWatchlistItemAction(
  rawSymbol: string,
  watchlistId?: string,
): Promise<WatchlistActionResult> {
  const parsed = symbolSchema.safeParse(rawSymbol);
  if (!parsed.success) return { ok: false, code: 'invalid', message: 'Symbol ไม่ถูกต้อง' };
  const target = optionalId(watchlistId);
  if (target === 'invalid') return { ok: false, code: 'invalid', message: 'ไม่พบรายการติดตามนี้' };
  const repo = await repository();
  if (!repo) return unauthorized;
  try {
    const client = await createClient();
    if (client && await getInstrumentStatus(client, parsed.data) === 'delisted') {
      return { ok: false, code: 'delisted', message: 'Symbol นี้ถูก delisted แล้ว จึงไม่สามารถเพิ่มเป็นรายการใหม่ได้' };
    }
    const item = await repo.add(parsed.data, target ?? undefined);
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

export async function removeWatchlistItemAction(
  rawSymbol: string,
  watchlistId?: string,
): Promise<WatchlistActionResult> {
  const parsed = symbolSchema.safeParse(rawSymbol);
  if (!parsed.success) return { ok: false, code: 'invalid', message: 'Symbol ไม่ถูกต้อง' };
  const target = optionalId(watchlistId);
  if (target === 'invalid') return { ok: false, code: 'invalid', message: 'ไม่พบรายการติดตามนี้' };
  const repo = await repository();
  if (!repo) return unauthorized;
  try {
    const removed = await repo.remove(parsed.data, target ?? undefined);
    if (!removed) return { ok: false, code: 'not-found', message: 'ไม่พบ Symbol ในรายการติดตาม' };
    revalidatePath('/watchlist');
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

export async function createWatchlistAction(rawName: string): Promise<WatchlistActionResult> {
  const checked = checkWatchlistName(rawName);
  if (!checked.ok) return { ok: false, code: 'invalid', message: checked.message! };
  const repo = await repository();
  if (!repo) return unauthorized;
  try {
    await repo.create(checked.normalized);
    revalidatePath('/watchlist');
    revalidatePath('/');
    return { ok: true };
  } catch (error) {
    return failure(error, 'มีรายการชื่อนี้อยู่แล้ว ใช้ชื่ออื่น');
  }
}

/**
 * Rename ONE list, named explicitly.
 *
 * The single-list version took only a name and renamed whatever resolved as the
 * default. With several lists that would rename a list the reader is not
 * looking at, so the id is required and the signature changed rather than being
 * defaulted — a silent default here is a wrong write, not a convenience.
 */
export async function renameWatchlistAction(
  watchlistId: string,
  rawName: string,
): Promise<WatchlistActionResult> {
  if (!idSchema.safeParse(watchlistId).success) {
    return { ok: false, code: 'invalid', message: 'ไม่พบรายการติดตามนี้' };
  }
  const checked = checkWatchlistName(rawName);
  if (!checked.ok) return { ok: false, code: 'invalid', message: checked.message! };
  const repo = await repository();
  if (!repo) return unauthorized;
  try {
    await repo.rename(watchlistId, checked.normalized);
    revalidatePath('/watchlist');
    revalidatePath('/');
    return { ok: true };
  } catch (error) {
    return failure(error, 'มีรายการชื่อนี้อยู่แล้ว ใช้ชื่ออื่น');
  }
}

/**
 * Delete one list.
 *
 * The confirmation is the CLIENT's — a destructive action needs a step a reader
 * takes deliberately, and it belongs where they can see what they are deleting.
 * The last-list rule is NOT the client's: it is enforced in
 * `public.delete_watchlist` under a lock, so two parallel deletes of a two-list
 * account cannot both pass, and it reaches here as `last-list`.
 */
export async function deleteWatchlistAction(watchlistId: string): Promise<WatchlistActionResult> {
  if (!idSchema.safeParse(watchlistId).success) {
    return { ok: false, code: 'invalid', message: 'ไม่พบรายการติดตามนี้' };
  }
  const repo = await repository();
  if (!repo) return unauthorized;
  try {
    await repo.delete(watchlistId);
    revalidatePath('/watchlist');
    revalidatePath('/');
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

/** Which list the Overview preview draws from. Null returns them to the default. */
export async function chooseOverviewWatchlistAction(
  watchlistId: string | null,
): Promise<WatchlistActionResult> {
  if (watchlistId !== null && !idSchema.safeParse(watchlistId).success) {
    return { ok: false, code: 'invalid', message: 'ไม่พบรายการติดตามนี้' };
  }
  const repo = await repository();
  if (!repo) return unauthorized;
  try {
    await repo.chooseForOverview(watchlistId);
    revalidatePath('/');
    revalidatePath('/watchlist');
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

/** Pin or unpin one symbol for the Overview preview. */
export async function setWatchlistPinAction(
  watchlistId: string,
  rawSymbol: string,
  pinned: boolean,
): Promise<WatchlistActionResult> {
  if (!idSchema.safeParse(watchlistId).success) {
    return { ok: false, code: 'invalid', message: 'ไม่พบรายการติดตามนี้' };
  }
  const parsed = symbolSchema.safeParse(rawSymbol);
  if (!parsed.success) return { ok: false, code: 'invalid', message: 'Symbol ไม่ถูกต้อง' };
  const repo = await repository();
  if (!repo) return unauthorized;
  try {
    await repo.setPinned(watchlistId, parsed.data, pinned);
    revalidatePath('/');
    revalidatePath('/watchlist');
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}
