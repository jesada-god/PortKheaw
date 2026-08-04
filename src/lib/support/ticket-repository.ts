import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Database,
  SupportAuthorRole,
  SupportTicketCategory,
  SupportTicketStatus,
} from '@/src/types/database';

/**
 * Reading tickets.
 *
 * Everything here runs through the **reader's own session**, never the service
 * role, so row-level security is what decides visibility rather than a `where`
 * clause this file could get wrong. The same functions serve the operator
 * console: an administrator's session satisfies the admin arm of the same
 * policies, so there is one query path and one place for the rules to live.
 *
 * The one thing the caller must still get right is `includeInternal`, which
 * decides whether operator notes are *requested*. The policy already hides them
 * from a non-operator, so this is the second lock, not the only one.
 */

export interface SupportTicketSummary {
  id: string;
  reference: string;
  userId: string;
  category: SupportTicketCategory;
  subject: string;
  status: SupportTicketStatus;
  tierSnapshot: string;
  createdAt: string;
  updatedAt: string;
  lastAdminReplyAt: string | null;
  lastUserReplyAt: string | null;
}

export interface SupportThreadMessage {
  id: string;
  authorRole: SupportAuthorRole;
  body: string;
  isInternal: boolean;
  createdAt: string;
}

export interface SupportAttachmentRef {
  id: string;
  storagePath: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface SupportTicketDetail extends SupportTicketSummary {
  description: string;
  messages: SupportThreadMessage[];
  attachments: SupportAttachmentRef[];
}

const TICKET_COLUMNS =
  'id, reference, user_id, category, subject, description, status, tier_snapshot, created_at, updated_at, last_admin_reply_at, last_user_reply_at';

/**
 * Exactly the columns `TICKET_COLUMNS` selects.
 *
 * Narrower than the table's `Row` on purpose: typing the mapper against the full
 * row would compile against columns the query does not fetch, and the first one
 * somebody read would be `undefined` at runtime with nothing to catch it.
 */
type TicketRow = Pick<
  Database['public']['Tables']['support_tickets']['Row'],
  | 'id' | 'reference' | 'user_id' | 'category' | 'subject' | 'description'
  | 'status' | 'tier_snapshot' | 'created_at' | 'updated_at'
  | 'last_admin_reply_at' | 'last_user_reply_at'
>;

function toSummary(row: TicketRow): SupportTicketSummary {
  return {
    id: row.id,
    reference: row.reference,
    userId: row.user_id,
    category: row.category,
    subject: row.subject,
    status: row.status,
    tierSnapshot: row.tier_snapshot,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAdminReplyAt: row.last_admin_reply_at,
    lastUserReplyAt: row.last_user_reply_at,
  };
}

/** The signed-in reader's own tickets. RLS makes "own" true by construction. */
export async function listMyTickets(
  client: SupabaseClient<Database>,
  limit = 50,
): Promise<SupportTicketSummary[]> {
  const { data, error } = await client
    .from('support_tickets')
    .select(TICKET_COLUMNS)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map(toSummary);
}

export interface AdminTicketFilter {
  query?: string | null;
  status?: SupportTicketStatus | null;
  limit?: number;
}

/**
 * The operator queue.
 *
 * Reachable only by a session the ticket policy admits as an administrator; a
 * non-operator running the identical query sees their own rows and nothing more,
 * which is the failure mode we want if a guard is ever missed upstream.
 */
export async function listTicketsForAdmin(
  client: SupabaseClient<Database>,
  filter: AdminTicketFilter = {},
): Promise<SupportTicketSummary[]> {
  let request = client
    .from('support_tickets')
    .select(TICKET_COLUMNS)
    .order('updated_at', { ascending: false })
    .limit(Math.min(Math.max(filter.limit ?? 50, 1), 100));

  if (filter.status) request = request.eq('status', filter.status);

  const needle = filter.query?.trim();
  if (needle) {
    // Reference or subject. Commas and parentheses would break PostgREST's `or`
    // grammar, so they are stripped rather than escaped.
    const safe = needle.replace(/[,()*]/g, ' ').trim();
    if (safe) request = request.or(`reference.ilike.%${safe}%,subject.ilike.%${safe}%`);
  }

  const { data, error } = await request;
  if (error) throw error;
  return (data ?? []).map(toSummary);
}

/**
 * One ticket with its thread.
 *
 * `includeInternal` is the operator's private margin. When false the internal
 * rows are filtered out of the *query* as well as being invisible to the policy,
 * so a page that forgets to check cannot render one.
 */
export async function readTicket(
  client: SupabaseClient<Database>,
  ticketId: string,
  options: { includeInternal?: boolean } = {},
): Promise<SupportTicketDetail | null> {
  const { data: ticket, error } = await client
    .from('support_tickets')
    .select(TICKET_COLUMNS)
    .eq('id', ticketId)
    .maybeSingle();
  if (error) throw error;
  if (!ticket) return null;

  let messageRequest = client
    .from('support_thread_messages')
    .select('id, author_role, body, is_internal, created_at')
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: true })
    .limit(200);
  if (!options.includeInternal) messageRequest = messageRequest.eq('is_internal', false);

  const [messages, attachments] = await Promise.all([
    messageRequest,
    client
      .from('support_attachments')
      .select('id, storage_path, mime_type, size_bytes, created_at')
      .eq('ticket_id', ticketId)
      .order('created_at', { ascending: true })
      .limit(20),
  ]);
  if (messages.error) throw messages.error;
  if (attachments.error) throw attachments.error;

  return {
    ...toSummary(ticket),
    description: ticket.description,
    messages: (messages.data ?? []).map((row) => ({
      id: row.id,
      authorRole: row.author_role,
      body: row.body,
      isInternal: row.is_internal,
      createdAt: row.created_at,
    })),
    attachments: (attachments.data ?? []).map((row) => ({
      id: row.id,
      storagePath: row.storage_path,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      createdAt: row.created_at,
    })),
  };
}

/** The audit trail for one ticket. Operator console only; no grant exists. */
export async function readTicketAudit(
  client: SupabaseClient<Database>,
  ticketId: string,
  limit = 50,
): Promise<Array<{
  id: number;
  actorRole: SupportAuthorRole;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  createdAt: string;
}>> {
  const { data, error } = await client
    .from('support_audit_events')
    .select('id, actor_role, action, from_status, to_status, created_at')
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    actorRole: row.actor_role,
    action: row.action,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    createdAt: row.created_at,
  }));
}
