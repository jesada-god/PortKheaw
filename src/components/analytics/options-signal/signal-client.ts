/**
 * Browser loader for the Options Signal.
 *
 * The whole engine now runs on the server, because the candle-derived inputs it
 * reads ARE the breakdown: shipping them to compute a gauge in the browser would
 * hand every reader the numbers the breakdown is sold for. This module only
 * fetches the already-projected payload and reports, truthfully, which of the
 * three outcomes came back — a signal, a plan refusal, or a failure.
 */

import type { OptionsSignalDto } from '@/src/lib/analytics/options-signal/dto';
import { readEntitlementDenial } from '@/src/lib/subscription/entitlement-guard';

export type OptionsSignalOutcome =
  | { status: 'ready'; signal: OptionsSignalDto }
  | { status: 'locked'; message: string }
  | { status: 'unavailable'; message: string };

const FAILURE_MESSAGE = 'ยังโหลดข้อมูลพื้นฐานของสัญญาณไม่สำเร็จ จึงไม่แสดงผลลัพธ์ที่เดาขึ้นเอง';

export async function requestOptionsSignal(
  symbol: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<OptionsSignalOutcome> {
  const response = await fetcher(`/api/analytics/options-signal/${encodeURIComponent(symbol)}`, {
    signal, headers: { Accept: 'application/json' }, cache: 'no-store',
  });
  let payload: unknown = null;
  try { payload = await response.json(); } catch { payload = null; }

  if (!response.ok) {
    const denial = readEntitlementDenial(payload);
    if (denial) return { status: 'locked', message: denial.message };
    return { status: 'unavailable', message: FAILURE_MESSAGE };
  }

  const data = (payload as { data?: OptionsSignalDto | null } | null)?.data;
  if (!data?.summary) return { status: 'unavailable', message: FAILURE_MESSAGE };
  return { status: 'ready', signal: data };
}
