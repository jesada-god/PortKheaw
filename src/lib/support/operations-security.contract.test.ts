import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isProtectedPath } from '@/src/lib/auth/paths';
import {
  MAX_ATTACHMENT_BYTES,
  SUPPORT_ATTACHMENT_BUCKET,
} from './attachments';
import {
  REFUND_ADMIN_TRANSITIONS,
  REFUND_STATUS_EXPLANATION,
  refundAcceptsReply,
  refundIsCancelable,
  refundTransitionNeedsConfirmation,
  ticketAcceptsReply,
} from './presentation';

/**
 * The boundaries this phase is built on, asserted as source facts.
 *
 * A component or an action could be edited into offering something the database
 * would refuse — a transition, an internal note, an automatic refund — and the
 * failure would be invisible until somebody exercised it in production. These
 * tests read the code and the migration and check that the two still agree.
 */

const root = process.cwd();
const migration = readFileSync(
  resolve(root, 'supabase/migrations/202608050003_operations_support_and_trust.sql'),
  'utf8',
);

function source(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

describe('route protection', () => {
  it('bounces a signed-out visitor away from the operator console', () => {
    expect(isProtectedPath('/admin')).toBe(true);
    expect(isProtectedPath('/admin/billing')).toBe(true);
    expect(isProtectedPath('/admin/refunds/abc')).toBe(true);
  });

  /*
   * This used to read "keeps the operator gate itself in the layout, not the
   * middleware", and the premise was wrong in a way that reached production. A
   * layout and the page beneath it render concurrently: when the layout refused,
   * the console had already rendered, and its tree shipped in the response
   * beside the 404 marker under a 200.
   *
   * The gate is now inside each page, where it can actually stop one. Middleware
   * refuses the URL first — it is a filter, so that no renderer runs for a caller
   * who will be refused — and the database refuses the data last. What has not
   * changed is the rule underneath: middleware knows whether somebody is signed
   * in, and only the database knows whether they are an operator, so every layer
   * asks the database and none of them may grant on its own.
   */
  it('gates the console inside the pages, with middleware as a filter in front', () => {
    expect(source('app/admin/layout.tsx')).toContain('requireAdminPage()');
    for (const page of globSync('app/admin/**/page.tsx', { cwd: root })) {
      expect(`${page}: ${source(page).includes('requireAdminPage()')}`).toBe(`${page}: true`);
    }
    expect(source('middleware.ts')).toContain('isPlatformAdminForEdge(supabase)');
    // Every layer resolves the role from the database, never from the request.
    expect(source('src/lib/admin/admin-edge.ts')).toContain("client.rpc('get_my_account_access')");
    expect(source('src/lib/admin/admin-guard.ts')).toContain('resolveRequestAccountAccess');
  });

  it('leaves help and the policy pages readable without a session', () => {
    // The reader who cannot sign in is the one who most needs the contacts.
    expect(isProtectedPath('/support')).toBe(false);
    expect(isProtectedPath('/terms')).toBe(false);
    expect(isProtectedPath('/privacy')).toBe(false);
    expect(isProtectedPath('/refund-policy')).toBe(false);
    expect(isProtectedPath('/subscription-policy')).toBe(false);
    expect(isProtectedPath('/investment-disclaimer')).toBe(false);
  });

  it('still protects the reader’s own billing surfaces', () => {
    expect(isProtectedPath('/settings/refunds')).toBe(true);
    expect(isProtectedPath('/settings/subscription')).toBe(true);
  });
});

describe('the refund transition graph matches the database', () => {
  it('offers only the moves the routine accepts', () => {
    // The routine's own `allowed` expression, read out of the migration.
    expect(migration).toContain(
      "when request.status = 'pending' and input_status in ('reviewing', 'approved', 'rejected') then true",
    );
    expect(migration).toContain(
      "when request.status = 'reviewing' and input_status in ('approved', 'rejected') then true",
    );
    expect(migration).toContain(
      "when request.status = 'approved' and input_status in ('refunded', 'rejected') then true",
    );

    expect(REFUND_ADMIN_TRANSITIONS.pending).toEqual(['reviewing', 'approved', 'rejected']);
    expect(REFUND_ADMIN_TRANSITIONS.reviewing).toEqual(['approved', 'rejected']);
    expect(REFUND_ADMIN_TRANSITIONS.approved).toEqual(['refunded', 'rejected']);
  });

  it('treats rejected, refunded and canceled as terminal on both sides', () => {
    expect(REFUND_ADMIN_TRANSITIONS.rejected).toEqual([]);
    expect(REFUND_ADMIN_TRANSITIONS.refunded).toEqual([]);
    expect(REFUND_ADMIN_TRANSITIONS.canceled).toEqual([]);
  });

  it('demands evidence for the one transition that claims money moved', () => {
    expect(refundTransitionNeedsConfirmation('refunded')).toBe(true);
    expect(refundTransitionNeedsConfirmation('approved')).toBe(false);
    expect(migration).toContain("if input_status = 'refunded' and completion is null then");
    expect(migration).toContain("return 'confirmation_required';");
  });

  it('says plainly that approval is not a refund', () => {
    expect(REFUND_STATUS_EXPLANATION.approved).toContain('ยังไม่ใช่การคืนเงิน');
    expect(REFUND_STATUS_EXPLANATION.approved).toContain('ยังไม่ตัดสิทธิ์');
  });

  it('closes replies and cancellation at the right points', () => {
    expect(refundIsCancelable('pending')).toBe(true);
    expect(refundIsCancelable('approved')).toBe(false);
    expect(refundAcceptsReply('rejected')).toBe(false);
    expect(ticketAcceptsReply('closed')).toBe(false);
    expect(ticketAcceptsReply('waiting_user')).toBe(true);
  });
});

describe('no automatic refund exists', () => {
  it('never calls the payment provider from a refund path', () => {
    const actions = source('app/settings/refunds/actions.ts');
    expect(actions).not.toMatch(/stripe-provider|refunds\.create|new Stripe/);
    const control = source('src/components/admin/RefundDecisionControl.tsx');
    expect(control).not.toMatch(/stripe|refunds\.create/i);
  });

  it('reaches `refunded` only from provider confirmation or a recorded completion', () => {
    // The two doors, and there is no third.
    expect(migration).toContain("if input_kind = 'refund' and coalesce(input_is_full, false) and matched_invoice is not null then");
    expect(migration).toContain("status = 'refunded',");
  });
});

describe('protected fields are unreachable from a client', () => {
  it('grants a client no write on tickets, requests, invoices or audit', () => {
    for (const relation of [
      'public.support_tickets',
      'public.refund_requests',
      'public.support_thread_messages',
      'public.support_attachments',
      'public.support_audit_events',
      'public.billing_invoices',
      'public.billing_refund_events',
      'public.billing_webhook_retries',
      'public.billing_reconciliation_issues',
    ]) {
      expect(migration).toContain(`revoke all on table ${relation} from anon, authenticated`);
    }
    // Only SELECT is ever handed back, and only on the reader-facing four.
    expect(migration).toContain('grant select on table public.support_tickets to authenticated');
    expect(migration).toContain('grant select on table public.refund_requests to authenticated');
    expect(migration).not.toMatch(/grant (insert|update|delete)[^;]*to authenticated/);
  });

  it('keeps every operator routine checking the role inside the database', () => {
    const operatorRoutines = [
      'admin_reply_support_ticket',
      'admin_set_support_ticket_status',
      'admin_reply_refund_request',
      'admin_set_refund_request_status',
      'admin_search_accounts',
      'admin_account_invoices',
      'admin_account_webhook_history',
      'admin_open_billing_issues',
    ];
    for (const routine of operatorRoutines) {
      const body = migration.slice(migration.indexOf(`function public.${routine}(`));
      expect(body.slice(0, 4_000)).toContain('is_platform_admin(requesting_user)');
    }
  });

  it('makes the audit log refuse edits with a trigger, not a convention', () => {
    expect(migration).toContain('create trigger support_audit_events_append_only');
    expect(migration).toContain('before update or delete on public.support_audit_events');
    expect(migration).toContain("raise exception 'AUDIT_APPEND_ONLY'");
  });

  it('rate limits ticket and refund creation in the routine', () => {
    expect(migration).toContain("interval '24 hours'");
    expect(migration).toContain("return query select null::uuid, null::text, 'rate_limited'::text;");
  });
});

describe('attachments are private', () => {
  it('creates the bucket as non-public and grants no client policy', () => {
    expect(migration).toContain("values ('support-attachments', 'support-attachments', false)");
    expect(migration).toContain('on conflict (id) do update set public = false');
    expect(migration).not.toMatch(/create policy[^;]*on storage\.objects/i);
  });

  it('validates type and size before a byte is stored', () => {
    const attachments = source('src/lib/support/attachments.ts');
    expect(attachments).toContain("'image/png'");
    expect(attachments).not.toContain('image/svg');
    expect(MAX_ATTACHMENT_BYTES).toBe(5 * 1024 * 1024);
    expect(SUPPORT_ATTACHMENT_BUCKET).toBe('support-attachments');
    // The same allowlist again as a check constraint.
    expect(migration).toContain("'image/png', 'image/jpeg', 'image/webp', 'image/gif'");
    expect(migration).toContain('size_bytes > 0 and size_bytes <= 5242880');
  });

  it('derives the storage path on the server and never takes a filename', () => {
    const attachments = source('src/lib/support/attachments.ts');
    expect(attachments).toContain('randomUUID()');
    expect(attachments).not.toContain('file.name');
  });

  it('serves attachments only through a short-lived signed URL', () => {
    const attachments = source('src/lib/support/attachments.ts');
    expect(attachments).toContain('createSignedUrl');
    expect(attachments).toContain('ATTACHMENT_URL_TTL_SECONDS');
    // The action looks the path up through the caller's own session, so the
    // row-level policy is the authorization.
    const actions = source('app/support/actions.ts');
    expect(actions).toContain("from('support_attachments')");
    expect(actions).toContain("select('storage_path')");
  });
});

describe('internal notes stay internal', () => {
  it('excludes them from the query as well as from the policy', () => {
    const ticketRepository = source('src/lib/support/ticket-repository.ts');
    expect(ticketRepository).toContain("messageRequest.eq('is_internal', false)");
    const refundRepository = source('src/lib/support/refund-repository.ts');
    expect(refundRepository).toContain("messageRequest.eq('is_internal', false)");
  });

  it('is only ever requested by the operator console', () => {
    expect(source('app/admin/support/[id]/page.tsx')).toContain('includeInternal: true');
    expect(source('app/admin/refunds/[id]/page.tsx')).toContain('includeInternal: true');
    // The reader's pages may *mention* the flag in a comment; they must never
    // pass it, which is what actually widens the query.
    expect(source('app/support/tickets/[id]/page.tsx')).not.toContain('includeInternal:');
    expect(source('app/settings/refunds/[id]/page.tsx')).not.toContain('includeInternal:');
  });

  it('hides them in the policy for everybody who is not an operator', () => {
    expect(migration).toContain('is_internal = false');
    expect(migration).toContain('public.is_platform_admin((select auth.uid()))');
  });
});

describe('the operator console discloses nothing it should not', () => {
  it('returns no provider identifier from any admin projection', () => {
    for (const routine of ['admin_search_accounts', 'admin_account_invoices', 'admin_account_webhook_history']) {
      const start = migration.indexOf(`function public.${routine}(`);
      const returnsBlock = migration.slice(start, migration.indexOf('language plpgsql', start));
      expect(returnsBlock).not.toContain('customer_id');
      expect(returnsBlock).not.toContain('invoice_id text');
      expect(returnsBlock).not.toContain('subscription_id');
      expect(returnsBlock).not.toContain('provider_event_id');
    }
  });

  it('reads the reader’s own purchases through the sanitized projection only', () => {
    const start = migration.indexOf('function public.list_my_billing_invoices()');
    const block = migration.slice(start, start + 1_500);
    expect(block).toContain('invoice_ref uuid');
    expect(block).not.toContain('invoice_id text');
  });
});
