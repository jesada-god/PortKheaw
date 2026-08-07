'use server';

import { createClient } from '@/src/lib/supabase/server';

/**
 * Mark an announcement seen.
 *
 * Called when the reader presses X or "รับทราบ" — never on render. Marking on
 * render would lose an announcement to a page that flashed past during a
 * navigation, and the whole guarantee of this feature is that a reader sees each
 * release exactly once, not at most once.
 *
 * The account is never sent. The routine reads `auth.uid()` itself, so there is
 * no argument through which one reader could acknowledge on behalf of another.
 * Idempotent by construction, so a double press or two devices is one row.
 *
 * Returns a boolean rather than throwing: a failed acknowledgement means the
 * popup appears again next visit, which is a mild annoyance, and turning it into
 * a client-visible error would be a worse one.
 */
export async function acknowledgeReleaseNoteAction(releaseId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(releaseId)) return false;

  try {
    const client = await createClient();
    if (!client) return false;
    const { data, error } = await client.rpc('acknowledge_release_note', {
      input_release_id: releaseId,
    });
    if (error) throw error;
    return data === 'acknowledged';
  } catch {
    return false;
  }
}
