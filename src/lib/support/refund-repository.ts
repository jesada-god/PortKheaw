import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  BillingInvoiceStatus,
  BillingPlanKey,
  Database,
  RefundRequestReason,
  RefundRequestStatus,
} from '@/src/types/database';
import type { SupportAttachmentRef, SupportThreadMessage, ThreadAuditEntry } from './ticket-repository';

/**
 * Reading refund requests and the purchases they point at.
 *
 * The invoice list comes from `list_my_billing_invoices()` — a sanitized
 * projection that returns *our* uuid for each purchase and no provider
 * identifier at all. That is what makes "pick the payment you want refunded" a
 * safe question to put in a form: the value the browser sends back is
 * meaningless against any account but its own, so a tampered submission fails
 * the ownership lookup rather than reaching somebody else's invoice.
 *
 * Everything runs through the caller's session. The operator console uses the
 * same functions and is admitted by the admin arm of the same policies.
 */

export interface BillingInvoiceView {
  invoiceRef: string;
  planKey: BillingPlanKey | null;
  status: BillingInvoiceStatus;
  amountPaidMinor: number;
  amountRefundedMinor: number;
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  issuedAt: string | null;
  paidAt: string | null;
  /** The most recent request against this purchase, if there is one. */
  refundRequestStatus: RefundRequestStatus | null;
}

export interface RefundRequestSummary {
  id: string;
  reference: string;
  userId: string;
  invoiceRef: string | null;
  status: RefundRequestStatus;
  reasonCategory: RefundRequestReason;
  amountMinor: number | null;
  currency: string | null;
  tierSnapshot: string;
  createdAt: string;
  updatedAt: string;
  refundedAt: string | null;
}

export interface RefundRequestDetail extends RefundRequestSummary {
  details: string;
  messages: SupportThreadMessage[];
  attachments: SupportAttachmentRef[];
}

const REQUEST_COLUMNS =
  'id, reference, user_id, invoice_ref, status, reason_category, details, amount_minor, currency, tier_snapshot, created_at, updated_at, refunded_at';

/** Exactly the columns `REQUEST_COLUMNS` selects — see the note in the ticket repository. */
type RequestRow = Pick<
  Database['public']['Tables']['refund_requests']['Row'],
  | 'id' | 'reference' | 'user_id' | 'invoice_ref' | 'status' | 'reason_category'
  | 'details' | 'amount_minor' | 'currency' | 'tier_snapshot'
  | 'created_at' | 'updated_at' | 'refunded_at'
>;

function toSummary(row: RequestRow): RefundRequestSummary {
  return {
    id: row.id,
    reference: row.reference,
    userId: row.user_id,
    invoiceRef: row.invoice_ref,
    status: row.status,
    reasonCategory: row.reason_category,
    amountMinor: row.amount_minor,
    currency: row.currency,
    tierSnapshot: row.tier_snapshot,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    refundedAt: row.refunded_at,
  };
}

/**
 * The reader's own purchases.
 *
 * Returns an empty list rather than throwing when the projection is missing,
 * which is the state of a deployment whose database has not been migrated yet:
 * deploys are not atomic, and a subscription page that 500s for the minute in
 * between is worse than one that shows no history for it.
 */
export async function listMyBillingInvoices(
  client: SupabaseClient<Database>,
): Promise<BillingInvoiceView[]> {
  const { data, error } = await client.rpc('list_my_billing_invoices');
  if (error) {
    if (isMissingSchema(error)) return [];
    throw error;
  }
  return (data ?? []).map((row) => ({
    invoiceRef: row.invoice_ref,
    planKey: row.plan_key,
    status: row.status,
    amountPaidMinor: row.amount_paid_minor,
    amountRefundedMinor: row.amount_refunded_minor,
    currency: row.currency,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    issuedAt: row.issued_at,
    paidAt: row.paid_at,
    refundRequestStatus: row.refund_request_status,
  }));
}

function isMissingSchema(error: { code?: string } | null): boolean {
  return error?.code === '42P01'
    || error?.code === '42703'
    || error?.code === 'PGRST202'
    || error?.code === 'PGRST204'
    || error?.code === 'PGRST205';
}

export async function listMyRefundRequests(
  client: SupabaseClient<Database>,
  limit = 50,
): Promise<RefundRequestSummary[]> {
  const { data, error } = await client
    .from('refund_requests')
    .select(REQUEST_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    if (isMissingSchema(error)) return [];
    throw error;
  }
  return (data ?? []).map(toSummary);
}

export interface AdminRefundFilter {
  query?: string | null;
  status?: RefundRequestStatus | null;
  limit?: number;
}

export async function listRefundRequestsForAdmin(
  client: SupabaseClient<Database>,
  filter: AdminRefundFilter = {},
): Promise<RefundRequestSummary[]> {
  let request = client
    .from('refund_requests')
    .select(REQUEST_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(filter.limit ?? 50, 1), 100));

  if (filter.status) request = request.eq('status', filter.status);

  const needle = filter.query?.trim().replace(/[,()*]/g, ' ').trim();
  if (needle) request = request.ilike('reference', `%${needle}%`);

  const { data, error } = await request;
  if (error) throw error;
  return (data ?? []).map(toSummary);
}

export async function readRefundRequest(
  client: SupabaseClient<Database>,
  requestId: string,
  options: { includeInternal?: boolean } = {},
): Promise<RefundRequestDetail | null> {
  const { data: request, error } = await client
    .from('refund_requests')
    .select(REQUEST_COLUMNS)
    .eq('id', requestId)
    .maybeSingle();
  if (error) throw error;
  if (!request) return null;

  let messageRequest = client
    .from('support_thread_messages')
    .select('id, author_role, body, is_internal, created_at')
    .eq('refund_request_id', requestId)
    .order('created_at', { ascending: true })
    .limit(200);
  if (!options.includeInternal) messageRequest = messageRequest.eq('is_internal', false);

  const [messages, attachments] = await Promise.all([
    messageRequest,
    client
      .from('support_attachments')
      .select('id, storage_path, mime_type, size_bytes, created_at')
      .eq('refund_request_id', requestId)
      .order('created_at', { ascending: true })
      .limit(20),
  ]);
  if (messages.error) throw messages.error;
  if (attachments.error) throw attachments.error;

  return {
    ...toSummary(request),
    details: request.details,
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

/** The audit trail for one refund request. See `readTicketAudit` for why. */
export async function readRefundAudit(
  client: SupabaseClient<Database>,
  requestId: string,
  limit = 50,
): Promise<ThreadAuditEntry[]> {
  try {
    const { data, error } = await client.rpc('admin_thread_audit', {
      input_ticket_id: null,
      input_refund_request_id: requestId,
      input_limit: limit,
    });
    if (error) throw error;
    return (data ?? []).map((row) => ({
      id: row.event_id,
      actorRole: row.actor_role,
      action: row.action,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      createdAt: row.created_at,
    }));
  } catch {
    return [];
  }
}
