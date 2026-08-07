import 'server-only';

import { cache } from 'react';
import { createClient } from '@/src/lib/supabase/server';
import { normalizeReleaseImportance, type ReleaseImportance } from './release-notes';

/**
 * The one announcement this reader has not acknowledged, resolved on the server.
 *
 * The database decides both halves — which release is the latest published one,
 * and whether this account has already dismissed it — because a browser deciding
 * either would mean the popup is only as reliable as the device it last ran on.
 * That is the whole reason the seen state is a row and not `localStorage`.
 *
 * Returns `null` for a signed-out visitor, for an unreadable session, and for
 * any failure. An announcement that cannot be resolved is simply not shown; it
 * is never a reason to fail a page render.
 */

export interface ReleaseAnnouncement {
  id: string;
  version: string | null;
  title: string;
  content: string;
  importance: ReleaseImportance;
  publishedAt: string;
}

async function readAnnouncement(): Promise<ReleaseAnnouncement | null> {
  const client = await createClient();
  if (!client) return null;

  try {
    const { data: { user } } = await client.auth.getUser();
    if (!user) return null;

    const { data, error } = await client.rpc('resolve_my_release_announcement');
    if (error) throw error;
    const row = data?.[0];
    if (!row || !row.published_at) return null;

    return {
      id: row.id,
      version: row.version ?? null,
      title: row.title,
      content: row.content,
      importance: normalizeReleaseImportance(row.importance),
      publishedAt: row.published_at,
    };
  } catch {
    return null;
  }
}

export const resolveReleaseAnnouncement = cache(readAnnouncement);
