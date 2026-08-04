import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';

export const PUBLIC_STATS_SINGLETON = true;

/** Read the non-identifying aggregate through the caller's existing role. */
export async function readPublicMemberCount(
  client: SupabaseClient<Database>,
): Promise<number | null> {
  const { data, error } = await client
    .from('app_public_stats')
    .select('member_count')
    .eq('singleton', PUBLIC_STATS_SINGLETON)
    .maybeSingle();

  if (error || !data) return null;
  const count = Number(data.member_count);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}
