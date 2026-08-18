import Link from 'next/link';
import { AlertTriangle, Search } from 'lucide-react';
import Header from '@/src/components/layout/Header';
import { StatusChip } from '@/src/components/support/StatusChip';
import { Input } from '@/src/components/ui/Input';
import { Button } from '@/src/components/ui/Button';
import { createClient } from '@/src/lib/supabase/server';
import { withinAdminSearchLimit } from '@/src/lib/admin/admin-repository';
import { maskEmail } from '@/src/lib/admin/masking';
import { billingPlans } from '@/src/lib/billing/billing-plans';
import { displayBaht } from '@/src/lib/support/presentation';
import type { Database } from '@/src/types/database';
import { requireAdminPage } from '@/src/lib/admin/admin-guard';

type AccountRow = Database['public']['Functions']['admin_search_accounts']['Returns'][number];
type IssueRow = Database['public']['Functions']['admin_open_billing_issues']['Returns'][number];

/**
 * Billing operations — **read only**.
 *
 * There is no control on this page that changes a tier, a status, a period or a
 * price, and no action file behind it. Everything an operator can see here comes
 * from four `security definer` projections that check `is_platform_admin` inside
 * the database and return product facts only:
 *
 *   * no provider customer, subscription, price, invoice or event identifier;
 *   * no card number, brand, expiry or holder — none is stored anywhere;
 *   * no secret, and no other account's records except the one searched for.
 *
 * The mailbox *is* shown, because an operator answering "why was I charged"
 * needs to know whose account they are looking at, and it is the only piece of
 * personal data on the page.
 *
 * The search is a server-rendered form with a `q` parameter rather than a client
 * fetch: it keeps the whole surface inside the admin layout's gate, and a
 * shareable URL is genuinely useful when two operators are looking at the same
 * account.
 */
export const dynamic = 'force-dynamic';

const DATE_FORMAT = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Bangkok',
});

function when(value: string | null): string {
  if (!value) return '—';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? DATE_FORMAT.format(new Date(timestamp)) : '—';
}

const RAIL_LABEL: Readonly<Record<string, string>> = {
  charge_automatically: 'บัตร (ต่ออายุอัตโนมัติ)',
  send_invoice: 'PromptPay (ชำระรายรอบ)',
};

const ISSUE_LABEL: Readonly<Record<string, string>> = {
  paid_invoice_without_active_tier: 'ชำระเงินแล้วแต่สิทธิ์ไม่เปิด',
  active_tier_without_confirmed_payment: 'สิทธิ์เปิดอยู่แต่ไม่พบการชำระเงินที่ยืนยันแล้ว',
  tier_period_mismatch: 'รอบสิทธิ์ไม่ตรงกับใบแจ้งหนี้',
  orphan_customer: 'มีลูกค้าค้างไว้แต่ไม่มีการสมัคร',
  orphan_subscription: 'มีการสมัครแต่ไม่มีลูกค้า',
  revoked_access_still_active: 'ถูกเพิกถอน/คืนเงินแล้วแต่สิทธิ์ยังเปิด',
  dead_letter_event: 'Webhook ล้มเหลวถาวร (dead letter)',
};

/**
 * The trial, said out loud.
 *
 * A lapsed trial is never rewritten — the row still says `trialing · elite` a
 * month after the week ended, deliberately, because the record of the free week
 * is what stops a second one being taken. So the stored status is shown as
 * stored, and this adds the half of the sentence the operator would otherwise
 * have to work out from the chip beside it: whether it is still running, and
 * when it ended if it is not.
 */
function trialLine(account: {
  trial_active: boolean;
  trial_started_at: string | null;
  trial_ends_at: string | null;
}): string {
  /*
   * A deployment whose database is a migration behind returns none of these
   * columns. "Never trialled" would then be a claim about a reader made out of a
   * missing column, so the absent case says nothing instead.
   */
  if (typeof account.trial_active !== 'boolean') return '—';
  if (account.trial_active) return `กำลังทดลองใช้ · สิ้นสุด ${when(account.trial_ends_at)}`;
  if (!account.trial_started_at && !account.trial_ends_at) return 'ไม่เคยทดลองใช้';
  return `หมดอายุแล้ว · สิ้นสุดเมื่อ ${when(account.trial_ends_at)}`;
}

const INVOICE_STATUS_LABEL: Readonly<Record<string, string>> = {
  open: 'รอชำระ',
  paid: 'ชำระแล้ว',
  void: 'ยกเลิก',
  uncollectible: 'เก็บเงินไม่ได้',
  refunded: 'คืนเงินแล้ว',
  partially_refunded: 'คืนเงินบางส่วน',
  disputed: 'อยู่ระหว่างโต้แย้ง',
};

export default async function AdminBillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The gate, before anything is read. See `admin-guard.ts`: a layout cannot
  // stop this page from rendering, so the page stops itself.
  await requireAdminPage();
  const params = await searchParams;
  const query = typeof params.q === 'string' ? params.q.trim() : '';
  const supabase = await createClient();

  let accounts: AccountRow[] | null = null;
  let issues: IssueRow[] = [];
  let unavailable = false;
  let searchAllowed = true;

  if (supabase) {
    try {
      const openIssues = await supabase.rpc('admin_open_billing_issues', {
        input_user_id: null,
        input_limit: 50,
      });
      if (openIssues.error) throw openIssues.error;
      issues = openIssues.data ?? [];

      if (query) {
        /*
         * The account search joins `auth.users` and is the one query on this page
         * a caller can point anywhere, so it is bounded. The issue list above is
         * not: it is a fixed projection, and an operator refreshing it during an
         * incident must never be turned away.
         */
        const { data: { user } } = await supabase.auth.getUser();
        searchAllowed = await withinAdminSearchLimit(supabase, user?.id ?? null);
        if (searchAllowed) {
          const search = await supabase.rpc('admin_search_accounts', {
            input_query: query,
            input_limit: 20,
          });
          if (search.error) throw search.error;
          accounts = search.data ?? [];
        }
      }
    } catch {
      unavailable = true;
    }
  }

  const selected = accounts?.length === 1 ? accounts[0] : null;
  const detail = selected && supabase ? await loadAccountDetail(supabase, selected.user_id) : null;

  return (
    <div className="min-w-0">
      <Header
        title="ปฏิบัติการบิลลิ่ง"
        subtitle="ดูอย่างเดียว · ไม่มีตัวระบุของผู้ให้บริการชำระเงินและไม่มีข้อมูลบัตร"
        backFallbackHref="/admin"
      />
      <main className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-6 p-4 md:p-8">
        <form method="get" className="flex min-w-0 flex-col gap-2 sm:flex-row">
          <Input
            name="q"
            defaultValue={query}
            placeholder="ค้นหาด้วยอีเมล ชื่อ หรือ user id"
            aria-label="ค้นหาบัญชี"
            className="min-w-0 flex-1"
          />
          <Button type="submit" className="shrink-0">
            <Search aria-hidden="true" size={16} className="mr-2" />
            ค้นหา
          </Button>
        </form>

        {unavailable && (
          <p className="flex items-start gap-2 rounded-xl border border-[var(--border)] p-4 text-sm text-[var(--negative)]">
            <AlertTriangle aria-hidden="true" size={16} className="mt-0.5 shrink-0" />
            <span className="min-w-0">อ่านข้อมูลบิลลิ่งไม่สำเร็จ กรุณาลองใหม่อีกครั้ง</span>
          </p>
        )}

        {Array.isArray(accounts) && accounts.length > 0 && (
          <section className="min-w-0 space-y-3">
            <h2 className="text-base font-semibold text-[var(--text)]">ผลการค้นหา</h2>
            <ul className="min-w-0 space-y-2">
              {accounts.map((account) => (
                <li
                  key={account.user_id}
                  className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    {/* Masked, like everywhere else in the console. An operator
                        who searched by address still recognises the result, and a
                        screenshot of this page carries no full mailbox. */}
                    <span className="min-w-0 flex-1 truncate font-medium text-[var(--text)]">
                      {account.email ? maskEmail(account.email) : account.user_id}
                    </span>
                    <StatusChip
                      label={`สิทธิ์ปัจจุบัน: ${account.effective_tier}`}
                      tone={account.effective_tier === 'basic' ? 'neutral' : 'active'}
                    />
                    {account.access_revoked_at && (
                      <StatusChip
                        label={account.access_revoked_reason === 'dispute' ? 'พักสิทธิ์จากการโต้แย้ง' : 'เพิกถอนจากการคืนเงิน'}
                        tone="negative"
                      />
                    )}
                  </div>
                  <dl className="mt-3 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
                    <Row label="แพ็กเกจที่บันทึกไว้" value={account.billing_plan_key ? billingPlans[account.billing_plan_key]?.name ?? account.billing_plan_key : '—'} />
                    <Row label="สถานะที่บันทึกไว้" value={`${account.status} · ${account.tier}`} />
                    <Row label="ทดลองใช้" value={trialLine(account)} />
                    <Row label="ช่องทางชำระ" value={account.billing_collection_method ? RAIL_LABEL[account.billing_collection_method] ?? account.billing_collection_method : '—'} />
                    <Row label="โหมดผู้ให้บริการ" value={account.billing_provider_mode ?? '—'} />
                    <Row label="สิ้นสุดรอบปัจจุบัน" value={when(account.current_period_end)} />
                    <Row label="ตั้งค่ายกเลิกเมื่อครบรอบ" value={account.cancel_at_period_end ? 'ใช่' : 'ไม่'} />
                    <Row label="เรื่องที่ยังไม่ปิด" value={String(account.open_ticket_count)} />
                    <Row label="คำขอคืนเงินที่ค้าง" value={String(account.open_refund_count)} />
                  </dl>
                </li>
              ))}
            </ul>
          </section>
        )}

        {!searchAllowed && (
          <p className="rounded-xl border border-[var(--border-strong)] p-4 text-sm text-[var(--text)]">
            ค้นหาถี่เกินไป กรุณารอสักครู่แล้วค้นหาอีกครั้ง
          </p>
        )}

        {searchAllowed && query && Array.isArray(accounts) && accounts.length === 0 && !unavailable && (
          <p className="rounded-xl border border-dashed border-[var(--border-strong)] p-4 text-sm text-[var(--text-muted)]">
            ไม่พบบัญชีที่ตรงกับคำค้นนี้
          </p>
        )}

        {detail && (
          <>
            <section className="min-w-0 space-y-3">
              <h2 className="text-base font-semibold text-[var(--text)]">ใบแจ้งหนี้ของบัญชีนี้</h2>
              {detail.invoices.length === 0 ? (
                <p className="text-sm text-[var(--text-muted)]">ยังไม่มีใบแจ้งหนี้ที่บันทึกไว้</p>
              ) : (
                <div className="-mx-1 overflow-x-auto px-1">
                  <table className="w-full min-w-[38rem] border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-[var(--border)] text-left text-[var(--text)]">
                        <th scope="col" className="px-3 py-2 font-medium">แพ็กเกจ</th>
                        <th scope="col" className="px-3 py-2 font-medium">สถานะ</th>
                        <th scope="col" className="px-3 py-2 font-medium">ชำระแล้ว</th>
                        <th scope="col" className="px-3 py-2 font-medium">คืนเงิน</th>
                        <th scope="col" className="px-3 py-2 font-medium">รอบ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.invoices.map((invoice) => (
                        <tr key={invoice.invoice_ref} className="border-b border-[var(--border)] last:border-0">
                          <td className="px-3 py-2 text-[var(--text)]">
                            {invoice.plan_key ? billingPlans[invoice.plan_key]?.name ?? invoice.plan_key : '—'}
                          </td>
                          <td className="px-3 py-2 text-[var(--text-muted)]">
                            {INVOICE_STATUS_LABEL[invoice.status] ?? invoice.status}
                          </td>
                          <td className="px-3 py-2 tabular-nums text-[var(--text-muted)]">
                            {displayBaht(invoice.amount_paid_minor, invoice.currency) ?? '—'}
                          </td>
                          <td className="px-3 py-2 tabular-nums text-[var(--text-muted)]">
                            {displayBaht(invoice.amount_refunded_minor, invoice.currency) ?? '—'}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-[var(--text-muted)]">
                            {when(invoice.period_end)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="min-w-0 space-y-3">
              <h2 className="text-base font-semibold text-[var(--text)]">ประวัติ webhook</h2>
              {detail.webhooks.length === 0 ? (
                <p className="text-sm text-[var(--text-muted)]">ยังไม่มีเหตุการณ์ที่บันทึกไว้</p>
              ) : (
                <ul className="min-w-0 divide-y divide-[var(--border)] rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
                  {detail.webhooks.map((event, index) => (
                    <li key={`${event.event_type}-${event.received_at}-${index}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                      <span className="min-w-0 flex-1 truncate text-[var(--text)]">{event.event_type}</span>
                      <span className="shrink-0 text-xs text-[var(--text-muted)]">
                        {event.status}{event.error_code ? ` · ${event.error_code}` : ''}
                      </span>
                      <span className="shrink-0 text-xs text-[var(--text-muted)]">{when(event.received_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}

        <section className="min-w-0 space-y-3">
          <h2 className="text-base font-semibold text-[var(--text)]">
            รายการที่ต้องตรวจสอบ ({issues.length})
          </h2>
          {issues.length === 0 ? (
            <p className="rounded-xl border border-dashed border-[var(--border-strong)] p-4 text-sm text-[var(--text-muted)]">
              การตรวจสอบประจำวันไม่พบความไม่สอดคล้องที่ค้างอยู่
            </p>
          ) : (
            <ul className="min-w-0 space-y-2">
              {issues.map((issue) => (
                <li
                  key={issue.issue_id}
                  className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm shadow-[var(--shadow)]"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusChip
                      label={issue.severity === 'critical' ? 'วิกฤต' : issue.severity === 'warning' ? 'ควรตรวจสอบ' : 'ข้อมูล'}
                      tone={issue.severity === 'critical' ? 'negative' : issue.severity === 'warning' ? 'waiting' : 'neutral'}
                    />
                    <span className="min-w-0 flex-1 font-medium text-[var(--text)]">
                      {ISSUE_LABEL[issue.issue_type] ?? issue.issue_type}
                    </span>
                    <span className="shrink-0 text-xs text-[var(--text-muted)]">
                      พบ {issue.occurrences} ครั้ง · ล่าสุด {when(issue.last_seen_at)}
                    </span>
                  </div>
                  {issue.user_id && (
                    <p className="mt-2 text-xs text-[var(--text-muted)]">
                      บัญชี:{' '}
                      <Link
                        href={`/admin/billing?q=${encodeURIComponent(issue.user_id)}`}
                        className="underline underline-offset-4 hover:text-[var(--text)]"
                      >
                        {issue.user_id}
                      </Link>
                    </p>
                  )}
                  {/* The detail object is sanitized where it is produced: plan
                      keys, statuses, timestamps and amounts only. */}
                  <pre className="mt-2 overflow-x-auto rounded-lg bg-[var(--surface-hover)] p-3 text-xs text-[var(--text-muted)]">
                    {JSON.stringify(issue.detail, null, 2)}
                  </pre>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-[var(--text-muted)]">{label}</dt>
      <dd className="truncate text-[var(--text)]">{value}</dd>
    </div>
  );
}

async function loadAccountDetail(
  supabase: NonNullable<Awaited<ReturnType<typeof createClient>>>,
  userId: string,
) {
  try {
    const [invoices, webhooks] = await Promise.all([
      supabase.rpc('admin_account_invoices', { input_user_id: userId }),
      supabase.rpc('admin_account_webhook_history', { input_user_id: userId }),
    ]);
    return {
      invoices: invoices.data ?? [],
      webhooks: webhooks.data ?? [],
    };
  } catch {
    return { invoices: [], webhooks: [] };
  }
}
