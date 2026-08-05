import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';
import { captureServerError } from '@/src/lib/monitoring/report';
import { consumeRateLimit, resolveClientAddress } from '@/src/lib/security/rate-limit';

/**
 * Every read the operator console makes, in one place.
 *
 * All of them are `security definer` routines that check `is_platform_admin`
 * inside the database, called through the operator's *own* session — so the
 * service key is never used to render a page, and a bug in a component cannot
 * read anything the caller's role does not already permit.
 *
 * Each read is wrapped rather than allowed to throw. An operations dashboard that
 * renders nine panels must show the eight that worked and say plainly that the
 * ninth did not; a single failed aggregate taking the whole page down is how an
 * operator ends up unable to see the incident they came to look at.
 */

export type AdminClient = SupabaseClient<Database>;

export interface AdminReadResult<T> {
  data: T;
  unavailable: boolean;
}

async function read<T>(
  scope: string,
  fallback: T,
  run: () => Promise<T>,
): Promise<AdminReadResult<T>> {
  try {
    return { data: await run(), unavailable: false };
  } catch (cause) {
    captureServerError({ scope: `admin.${scope}`, cause, level: 'warning' });
    return { data: fallback, unavailable: true };
  }
}

export type DashboardOverview = Database['public']['Functions']['admin_dashboard_overview']['Returns'][number];
export type BillingActivityRow = Database['public']['Functions']['admin_recent_billing_activity']['Returns'][number];
export type BetaProgramState = Database['public']['Functions']['admin_beta_program_state']['Returns'][number];
export type BetaReportRow = Database['public']['Functions']['admin_beta_report']['Returns'][number];
export type BetaFeatureRow = Database['public']['Functions']['admin_beta_feature_report']['Returns'][number];
export type BetaInviteRow = Database['public']['Functions']['admin_beta_invites']['Returns'][number];
export type AuditFeedRow = Database['public']['Functions']['admin_audit_feed']['Returns'][number];

export function loadDashboardOverview(
  client: AdminClient,
  period: { from: string; to: string },
): Promise<AdminReadResult<DashboardOverview | null>> {
  return read('dashboard-overview', null, async () => {
    const { data, error } = await client.rpc('admin_dashboard_overview', {
      input_from_date: period.from,
      input_to_date: period.to,
    });
    if (error) throw error;
    return data?.[0] ?? null;
  });
}

export function loadRecentActivity(
  client: AdminClient,
  input: {
    kind: Database['public']['Functions']['admin_recent_billing_activity']['Args']['input_kind'];
    query: string | null;
    limit: number;
    offset: number;
  },
): Promise<AdminReadResult<BillingActivityRow[]>> {
  return read('recent-activity', [], async () => {
    const { data, error } = await client.rpc('admin_recent_billing_activity', {
      input_kind: input.kind,
      input_query: input.query,
      input_limit: input.limit,
      input_offset: input.offset,
    });
    if (error) throw error;
    return data ?? [];
  });
}

export function loadBetaProgramState(
  client: AdminClient,
): Promise<AdminReadResult<BetaProgramState | null>> {
  return read('beta-state', null, async () => {
    const { data, error } = await client.rpc('admin_beta_program_state');
    if (error) throw error;
    return data?.[0] ?? null;
  });
}

export function loadBetaReport(client: AdminClient): Promise<AdminReadResult<BetaReportRow[]>> {
  return read('beta-report', [], async () => {
    const { data, error } = await client.rpc('admin_beta_report');
    if (error) throw error;
    return data ?? [];
  });
}

export function loadBetaFeatureReport(
  client: AdminClient,
  limit = 20,
): Promise<AdminReadResult<BetaFeatureRow[]>> {
  return read('beta-features', [], async () => {
    const { data, error } = await client.rpc('admin_beta_feature_report', { input_limit: limit });
    if (error) throw error;
    return data ?? [];
  });
}

export function loadBetaInvites(
  client: AdminClient,
  input: { query: string | null; limit: number; offset: number },
): Promise<AdminReadResult<BetaInviteRow[]>> {
  return read('beta-invites', [], async () => {
    const { data, error } = await client.rpc('admin_beta_invites', {
      input_query: input.query,
      input_limit: input.limit,
      input_offset: input.offset,
    });
    if (error) throw error;
    return data ?? [];
  });
}

export function loadAuditFeed(
  client: AdminClient,
  input: { limit: number; offset: number },
): Promise<AdminReadResult<AuditFeedRow[]>> {
  return read('audit-feed', [], async () => {
    const { data, error } = await client.rpc('admin_audit_feed', {
      input_limit: input.limit,
      input_offset: input.offset,
    });
    if (error) throw error;
    return data ?? [];
  });
}

/** The total a paged routine reported, or zero when the page is empty. */
export function totalFrom(rows: readonly { total_count: number }[]): number {
  return rows.length > 0 ? Number(rows[0].total_count) : 0;
}

/**
 * A bound on operator *searches*.
 *
 * Applied only when a search term is present, because the plain dashboard render
 * is not a search and an operator refreshing it should never hit a limit. The
 * searches themselves join `auth.users` and scan the ledger, so an unbounded one
 * is the cheapest way to make the database work hard from a single session.
 *
 * Returning `false` means the page renders without running the query and says so
 * — it never renders stale or partial results as if they were the answer.
 */
export async function withinAdminSearchLimit(
  client: AdminClient,
  userId: string | null,
): Promise<boolean> {
  const outcome = await consumeRateLimit(client, {
    scope: 'admin.search',
    userId,
    clientAddress: await resolveClientAddress(),
  });
  return outcome.allowed;
}
