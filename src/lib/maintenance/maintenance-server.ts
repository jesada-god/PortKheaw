import 'server-only';

import { cache } from 'react';
import { createClient } from '@/src/lib/supabase/server';

/**
 * The maintenance switch, as a server component or a route handler sees it.
 *
 * Same routine as the edge gate calls, so the notice page and the gate can never
 * disagree about whether the product is down. Wrapped in React's per-request
 * cache: the page, its recovery poller's initial state and any layout that asks
 * must observe one answer and issue one round trip.
 *
 * This is a *description*, not an enforcement point. Nothing may open or close a
 * surface based on what this returns — the gate in `middleware.ts` already
 * decided that, once, for the whole request.
 */

export interface MaintenanceState {
  enabled: boolean;
  message: string | null;
  expectedResumeAt: string | null;
  startedAt: string | null;
  isAdmin: boolean;
  /** `false` when the read failed, so a caller can avoid asserting "we are up". */
  resolved: boolean;
}

const UNRESOLVED: MaintenanceState = {
  enabled: false,
  message: null,
  expectedResumeAt: null,
  startedAt: null,
  isAdmin: false,
  resolved: false,
};

async function readMaintenanceState(): Promise<MaintenanceState> {
  const client = await createClient();
  if (!client) return UNRESOLVED;

  try {
    const { data, error } = await client.rpc('resolve_maintenance_state');
    if (error) throw error;
    const row = data?.[0];
    if (!row) return UNRESOLVED;
    return {
      enabled: row.maintenance_enabled === true,
      message: row.maintenance_message ?? null,
      expectedResumeAt: row.expected_resume_at ?? null,
      startedAt: row.maintenance_started_at ?? null,
      isAdmin: row.is_admin === true,
      resolved: true,
    };
  } catch {
    // Up, unless the database says otherwise — the same fail-safe the edge gate
    // uses, for the same reason: an unreadable switch is not an operator's
    // decision to switch anything off.
    return UNRESOLVED;
  }
}

export const resolveMaintenanceState = cache(readMaintenanceState);
