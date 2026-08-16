import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  Activity, AlertTriangle, ChevronRight, ExternalLink, FlaskConical, LifeBuoy, ReceiptText, Search,
  Wallet, Wrench,
} from 'lucide-react';
import Header from '@/src/components/layout/Header';
import { StatCard } from '@/src/components/admin/StatCard';
import { StatusChip } from '@/src/components/support/StatusChip';
import { Input } from '@/src/components/ui/Input';
import { Button } from '@/src/components/ui/Button';
import { Select } from '@/src/components/ui/Select';
import { createClient } from '@/src/lib/supabase/server';
import { billingPlans, isBillingPlanKey } from '@/src/lib/billing/billing-plans';
import { getBillingConfig } from '@/src/lib/billing/billing-server';
import { clientEnv } from '@/src/config/env/client';
import {
  loadAuditFeed, loadDashboardOverview, loadMaintenanceState, loadRecentActivity, totalFrom,
  withinAdminSearchLimit,
} from '@/src/lib/admin/admin-repository';
import {
  ACTIVITY_KIND_LABEL, DASHBOARD_RANGE_LABEL, activityKinds, dashboardRanges,
  formatCount, formatMinorAsBaht, normalizeActivityKind, resolveDashboardPeriod,
  resolvePagination, totalPages,
} from '@/src/lib/admin/dashboard-presentation';
import { maskAccountRef, maskEmail, maskIdentifier } from '@/src/lib/admin/masking';
import {
  stripeInvoiceUrl, supabaseAccountUrl, supabaseProjectRef,
} from '@/src/lib/admin/console-links';
import { requireAdminPage } from '@/src/lib/admin/admin-guard';

/**
 * The operator dashboard.
 *
 * This is the console's landing page and its only overview — the destinations
 * below it are the same three that were here before, plus the rollout. Adding a
 * second "dashboard" route beside this one would have meant two pages competing
 * to be the place an operator starts.
 *
 * Everything on it comes from `security definer` projections that check
 * `is_platform_admin` inside the database, called through the operator's own
 * session. The layout above already refused a non-operator; the database refuses
 * again, which is the boundary.
 *
 * Two rules about what is rendered:
 *
 *   * **Mailboxes are masked by default.** `?reveal=1` un-masks them for one
 *     page view, because an operator matching a support ticket to a payment
 *     genuinely needs the address. It is a deliberate act, and it is visible on
 *     screen while it is in force.
 *   * **Provider identifiers are masked always** — there is no reveal. The full
 *     value exists only inside an `href` to the provider's own dashboard, which
 *     grants nothing without the operator's own session there.
 */
export const dynamic = 'force-dynamic';

const DESTINATIONS = [
  {
    href: '/admin/billing',
    icon: Wallet,
    title: 'ปฏิบัติการบิลลิ่ง',
    description: 'ค้นหาบัญชี ดูสิทธิ์ ใบแจ้งหนี้ ประวัติ webhook และรายการที่ต้องตรวจสอบ',
    countKey: 'issues',
  },
  {
    href: '/admin/support',
    icon: LifeBuoy,
    title: 'เรื่องที่ผู้ใช้แจ้ง',
    description: 'ตอบกลับ เปลี่ยนสถานะ และบันทึกภายใน',
    countKey: 'tickets',
  },
  {
    href: '/admin/refunds',
    icon: ReceiptText,
    title: 'คำขอคืนเงิน',
    description: 'ตรวจสอบคำขอ บันทึกภายใน และบันทึกผลการคืนเงิน',
    countKey: 'refunds',
  },
  {
    href: '/admin/beta',
    icon: FlaskConical,
    title: 'การเปิดใช้งานแบบควบคุม',
    description: 'สถานะรอบทดลอง โควตา รายชื่อผู้ได้รับเชิญ และรายงาน Funnel',
    countKey: 'none',
  },
  {
    href: '/admin/reliability',
    icon: Activity,
    title: 'ความพร้อมของระบบ',
    description: 'สถานะแอป ข้อมูลตลาด งานเบื้องหลัง การชำระเงิน และเวอร์ชันที่ deploy อยู่',
    countKey: 'none',
  },
  {
    href: '/admin/system',
    icon: Wrench,
    title: 'สถานะระบบและประกาศ',
    description: 'เปิด/ปิดแอปเพื่ออัปเดต และเขียนประกาศ “มีอะไรใหม่” ให้ผู้ใช้',
    countKey: 'none',
  },
] as const;

const DATE_FORMAT = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok',
});

function when(value: string | null): string {
  if (!value) return '—';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? DATE_FORMAT.format(new Date(timestamp)) : '—';
}

const ACTIVITY_TONE = {
  payment: 'positive', cancellation: 'neutral', refund: 'waiting', dispute: 'negative',
} as const;

const PAGE_SIZE = 20;

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The gate, before anything is read. See `admin-guard.ts`: a layout cannot
  // stop this page from rendering, so the page stops itself.
  await requireAdminPage();
  const params = await searchParams;
  const single = (key: string): string | undefined =>
    typeof params[key] === 'string' ? params[key] : undefined;

  const period = resolveDashboardPeriod({
    range: single('range'),
    from: single('from'),
    to: single('to'),
    now: new Date(),
  });
  const kind = normalizeActivityKind(single('kind'));
  const query = single('q')?.trim() ?? '';
  const { page, offset } = resolvePagination({ page: single('page'), pageSize: PAGE_SIZE });
  const reveal = single('reveal') === '1';

  const supabase = await createClient();
  if (!supabase) return <Unavailable />;

  /*
   * Searches are bounded; a plain dashboard render is not. An operator
   * refreshing the overview must never be rate limited out of the incident they
   * came to look at, and the overview is a fixed set of aggregates rather than a
   * query somebody can point anywhere.
   */
  const { data: { user } } = await supabase.auth.getUser();
  const searchAllowed = query
    ? await withinAdminSearchLimit(supabase, user?.id ?? null)
    : true;

  const [overview, activity, audit, maintenance] = await Promise.all([
    loadDashboardOverview(supabase, period),
    searchAllowed
      ? loadRecentActivity(supabase, { kind, query: query || null, limit: PAGE_SIZE, offset })
      : Promise.resolve({ data: [], unavailable: false }),
    loadAuditFeed(supabase, { limit: 8, offset: 0 }),
    loadMaintenanceState(supabase),
  ]);

  const stats = overview.data;
  const providerMode = getBillingConfig()?.providerMode === 'live' ? 'live' : 'test';
  const projectRef = supabaseProjectRef(clientEnv.NEXT_PUBLIC_SUPABASE_URL);
  const activityTotal = totalFrom(activity.data);
  const pages = totalPages(activityTotal, PAGE_SIZE);

  /** Keeps the other filters intact while one of them changes. */
  const link = (next: Record<string, string | undefined>): string => {
    const search = new URLSearchParams();
    const merged: Record<string, string | undefined> = {
      range: period.range,
      from: period.range === 'custom' ? period.from : undefined,
      to: period.range === 'custom' ? period.to : undefined,
      kind,
      q: query || undefined,
      page: String(page),
      reveal: reveal ? '1' : undefined,
      ...next,
    };
    for (const [key, value] of Object.entries(merged)) {
      if (value && !(key === 'page' && value === '1')) search.set(key, value);
    }
    const encoded = search.toString();
    return encoded ? `/admin?${encoded}` : '/admin';
  };

  return (
    <div className="min-w-0">
      <Header title="ศูนย์ปฏิบัติการ" subtitle="เฉพาะผู้ดูแลระบบ" backFallbackHref="/" />
      <main className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-6 p-4 md:p-8">
        <p className="text-sm text-[var(--text-muted)]">
          ตัวเลขทั้งหมดอ่านจากฐานข้อมูลจริงตามเวลาไทย ไม่มีข้อมูลจำลอง
          หน้านี้ไม่แสดงเลขบัตร รหัสลับ หรือข้อมูลการชำระเงินของผู้ให้บริการ
        </p>

        {/*
          The switch, summarised. The controls live on `/admin/system` rather
          than here so that the thing which takes the product away from every
          reader is never one stray tap away from a dashboard somebody refreshes
          all day — but its *state* belongs on the landing page, because "is the
          product up?" is the first question an operator opens this console with.
        */}
        <section className="min-w-0">
          <Link
            href="/admin/system"
            className="flex min-w-0 items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            <span aria-hidden="true" className="text-lg">
              {maintenance.data?.maintenance_enabled ? '🟠' : '🟢'}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-[var(--text)]">
                สถานะระบบ · {maintenance.data?.maintenance_enabled ? 'กำลังปรับปรุงระบบ' : 'เปิดใช้งาน'}
              </span>
              <span className="block text-xs text-[var(--text-muted)]">
                {maintenance.unavailable
                  ? 'อ่านสถานะไม่สำเร็จ กดเพื่อเปิดหน้าจัดการ'
                  : maintenance.data?.maintenance_enabled
                    ? 'ผู้ใช้ทั่วไปถูกพาไปหน้าแจ้งปรับปรุง บัญชี Admin ยังใช้งานได้'
                    : 'ผู้ใช้ทุกคนเข้าใช้งานได้ตามปกติ'}
              </span>
            </span>
            <ChevronRight aria-hidden="true" size={18} className="shrink-0 text-[var(--text-muted)]" />
          </Link>
        </section>

        <nav aria-label="ส่วนงานผู้ดูแลระบบ">
          <ul className="grid min-w-0 gap-2 sm:grid-cols-2">
            {DESTINATIONS.map((destination) => {
              const Icon = destination.icon;
              const count = destination.countKey === 'issues' ? stats?.open_reconciliation_issues
                : destination.countKey === 'tickets' ? stats?.open_tickets
                  : destination.countKey === 'refunds' ? stats?.open_refund_requests : 0;
              return (
                <li key={destination.href} className="min-w-0">
                  <Link
                    href={destination.href}
                    className="flex h-full min-w-0 items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
                      <Icon aria-hidden="true" size={20} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-[var(--text)]">{destination.title}</span>
                      <span className="block text-xs text-[var(--text-muted)]">{destination.description}</span>
                    </span>
                    {Boolean(count) && (
                      <span className="shrink-0 rounded-full bg-[var(--accent)] px-2 py-0.5 text-xs font-medium tabular-nums text-[var(--accent-fg)]">
                        {count}
                      </span>
                    )}
                    <ChevronRight aria-hidden="true" size={18} className="shrink-0 text-[var(--text-muted)]" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <section className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="flex-1 text-base font-semibold text-[var(--text)]">ภาพรวม</h2>
            <form method="get" className="flex shrink-0 flex-wrap items-center gap-2">
              <input type="hidden" name="kind" value={kind} />
              {query && <input type="hidden" name="q" value={query} />}
              <label htmlFor="range" className="text-xs text-[var(--text-muted)]">ช่วงเวลา</label>
              <Select id="range" name="range" defaultValue={period.range} className="h-9 w-40">
                {dashboardRanges.map((value) => (
                  <option key={value} value={value}>{DASHBOARD_RANGE_LABEL[value]}</option>
                ))}
              </Select>
              <Input type="date" name="from" defaultValue={period.from} aria-label="ตั้งแต่วันที่" className="h-9 w-36" />
              <Input type="date" name="to" defaultValue={period.to} aria-label="ถึงวันที่" className="h-9 w-36" />
              <Button type="submit" variant="outline" size="sm">ใช้ช่วงนี้</Button>
            </form>
          </div>

          {overview.unavailable && <ReadFailed what="ภาพรวม" />}

          {!overview.unavailable && !stats && (
            <p className="rounded-xl border border-dashed border-[var(--border-strong)] p-4 text-sm text-[var(--text-muted)]">
              ยังไม่มีข้อมูลสรุปสำหรับช่วงเวลานี้
            </p>
          )}

          {stats && (
            <div className="flex min-w-0 flex-col gap-5">
              {/*
                Four groups, in the order an operator asks the questions: who is
                here *now*, what moved in the last week, what did they pay, is
                anything broken.

                The split at the top is the point. "ตอนนี้" and "ช่วงที่ผ่านมา"
                were previously one band called "ผู้ใช้", so a count of accounts
                holding a tier sat beside a count of signups in a window and the
                two read as the same kind of fact. They are not: one is a
                statement about this instant, the other about seven days, and
                only the second kind can be a movement.

                Each group's column count is chosen so its last row is full.
                Ragged tails are what made the old three-grid stack read as empty
                space rather than as structure.
              */}
              <StatGroup
                title="ตอนนี้"
                columns="sm:grid-cols-3 lg:grid-cols-3"
                featureFirst
                note="สถานะปัจจุบัน ณ เวลาที่เปิดหน้านี้ ไม่ขึ้นกับช่วงเวลาที่เลือก ผู้ที่อยู่ระหว่างทดลองใช้ถูกนับในช่อง “กำลังทดลองใช้” เท่านั้น ไม่ถูกนับซ้ำใน Elite ทั้งสี่ช่องล่างรวมกันเท่ากับผู้ใช้งานทั้งหมด"
              >
                <StatCard
                  label="ผู้ใช้งานทั้งหมด"
                  value={formatCount(stats.total_users)}
                  hint="บัญชีที่ยังมีอยู่ ณ ตอนนี้"
                  emphasis="hero"
                />
                {/*
                  Decided by the database clock on every read: a trial whose end
                  has passed is not counted here from that moment on, with no job
                  to run and nothing deleted — the record that the free week was
                  spent is kept for as long as the retention policy says.
                */}
                <StatCard
                  label="กำลังทดลองใช้"
                  value={formatCount(stats.trial_members)}
                  hint="Trial ที่ยังไม่หมดอายุ ณ ตอนนี้"
                />
                <StatCard
                  label="Basic"
                  value={formatCount(stats.basic_members)}
                  hint="สิทธิ์ที่ใช้ได้จริงตอนนี้"
                />
                <StatCard
                  label="Pro"
                  value={formatCount(stats.pro_members)}
                  hint="สิทธิ์ที่ใช้ได้จริงตอนนี้"
                />
                <StatCard
                  label="Elite"
                  value={formatCount(stats.elite_members)}
                  hint="แพ็กเกจเสียเงิน ไม่รวม Trial"
                />
              </StatGroup>

              {/*
                Movement, and only movement. The window is the trailing seven days
                for all three, so they can be read against one another; it is not
                the range control above, which governs the revenue figures and
                says so there.
              */}
              <StatGroup
                title="ช่วงที่ผ่านมา (7 วันล่าสุด)"
                columns="sm:grid-cols-4 lg:grid-cols-4"
                featureFirst
                note="นับ 7 วันล่าสุดตามเวลาไทย ไม่ขึ้นกับช่วงเวลาที่เลือกด้านบน"
              >
                <StatCard
                  label="สมาชิกใหม่ 7 วัน"
                  value={formatCount(stats.new_members_7d)}
                  hint={`วันนี้: ${formatCount(stats.new_members_today)} · 30 วัน: ${formatCount(stats.new_members_30d)}`}
                  emphasis="hero"
                />
                <StatCard
                  label="เริ่ม Trial 7 วัน"
                  value={formatCount(stats.trial_starts_7d)}
                  hint="รวมรายที่หมดอายุไปแล้ว"
                />
                <StatCard
                  label="เปลี่ยนเป็นแพ็กเกจเสียเงิน 7 วัน"
                  value={formatCount(stats.paid_conversions_7d)}
                  hint="บัญชีที่ชำระเงินสำเร็จครั้งแรกในช่วงนี้"
                />
              </StatGroup>

              <StatGroup
                title="รายได้"
                columns="sm:grid-cols-3 lg:grid-cols-3"
                note="ช่วงเวลาที่เลือกด้านบนมีผลกับตัวเลขรายได้กลุ่มนี้เท่านั้น รายได้คำนวณจากใบแจ้งหนี้ที่ชำระแล้วเท่านั้น หักด้วยยอดที่คืนเงินแล้ว ใบแจ้งหนี้ที่ยังไม่ชำระและคำขอคืนเงินที่ยังไม่จ่ายจริงไม่ถูกนับ"
              >
                <StatCard label="รายได้วันนี้ (บาท)" value={formatMinorAsBaht(stats.revenue_today_minor)} />
                <StatCard label="รายได้เดือนนี้ (บาท)" value={formatMinorAsBaht(stats.revenue_month_minor)} />
                <StatCard
                  label="รายได้ช่วงที่เลือก (บาท)"
                  value={formatMinorAsBaht(stats.revenue_period_minor)}
                  hint={`${stats.period_from} → ${stats.period_to}`}
                />
                <StatCard
                  label="คืนเงินช่วงที่เลือก (บาท)"
                  value={formatMinorAsBaht(stats.refunds_period_minor)}
                />
                <StatCard
                  label="ค้างชำระ (Past due)"
                  value={formatCount(stats.past_due_members)}
                  tone={stats.past_due_members > 0 ? 'attention' : 'neutral'}
                />
                <StatCard
                  label="PromptPay รอชำระ"
                  value={formatCount(stats.promptpay_pending)}
                  tone={stats.promptpay_pending > 0 ? 'attention' : 'neutral'}
                />
              </StatGroup>

              <StatGroup title="ระบบ" columns="sm:grid-cols-2 lg:grid-cols-4">
                <StatCard
                  label="Webhook ที่ยังลองใหม่อยู่"
                  value={formatCount(stats.failed_webhooks)}
                  tone={stats.failed_webhooks > 0 ? 'attention' : 'neutral'}
                />
                <StatCard
                  label="Webhook ล้มเหลวถาวร"
                  value={formatCount(stats.dead_letter_webhooks)}
                  tone={stats.dead_letter_webhooks > 0 ? 'critical' : 'neutral'}
                />
                <StatCard
                  label="รายการที่ยังไม่กระทบยอด"
                  value={formatCount(stats.open_reconciliation_issues)}
                  tone={stats.open_reconciliation_issues > 0 ? 'attention' : 'neutral'}
                />
                <StatCard
                  label="ระดับวิกฤต"
                  value={formatCount(stats.critical_reconciliation_issues)}
                  tone={stats.critical_reconciliation_issues > 0 ? 'critical' : 'neutral'}
                />
              </StatGroup>
            </div>
          )}
        </section>

        <section className="min-w-0 space-y-3">
          <h2 className="text-base font-semibold text-[var(--text)]">
            ความเคลื่อนไหวล่าสุด{activityTotal > 0 ? ` (${formatCount(activityTotal)})` : ''}
          </h2>

          <form method="get" className="flex min-w-0 flex-col gap-2 sm:flex-row">
            <input type="hidden" name="range" value={period.range} />
            {period.range === 'custom' && (
              <>
                <input type="hidden" name="from" value={period.from} />
                <input type="hidden" name="to" value={period.to} />
              </>
            )}
            {reveal && <input type="hidden" name="reveal" value="1" />}
            <Select name="kind" defaultValue={kind} aria-label="ประเภทรายการ" className="shrink-0 sm:w-44">
              {activityKinds.map((value) => (
                <option key={value} value={value}>{ACTIVITY_KIND_LABEL[value]}</option>
              ))}
            </Select>
            <Input
              name="q"
              defaultValue={query}
              placeholder="ค้นหาด้วยอีเมล user id หรือแพ็กเกจ"
              aria-label="ค้นหารายการ"
              className="min-w-0 flex-1"
            />
            <Button type="submit" className="shrink-0">
              <Search aria-hidden="true" size={16} className="mr-2" />
              ค้นหา
            </Button>
          </form>

          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
            <span>อีเมลถูกปิดบังไว้เป็นค่าเริ่มต้น</span>
            <Link
              href={link({ reveal: reveal ? undefined : '1' })}
              className="underline underline-offset-4 hover:text-[var(--text)]"
            >
              {reveal ? 'ปิดบังอีเมลอีกครั้ง' : 'แสดงอีเมลเต็มชั่วคราว'}
            </Link>
            {reveal && <StatusChip label="กำลังแสดงอีเมลเต็ม" tone="waiting" />}
          </div>

          {activity.unavailable && <ReadFailed what="ความเคลื่อนไหว" />}

          {!searchAllowed && (
            <p className="rounded-xl border border-[var(--border-strong)] p-4 text-sm text-[var(--text)]">
              ค้นหาถี่เกินไป กรุณารอสักครู่แล้วค้นหาอีกครั้ง (ตัวเลขสรุปด้านบนยังเป็นข้อมูลล่าสุด)
            </p>
          )}

          {searchAllowed && !activity.unavailable && activity.data.length === 0 && (
            <p className="rounded-xl border border-dashed border-[var(--border-strong)] p-4 text-sm text-[var(--text-muted)]">
              {query ? 'ไม่พบรายการที่ตรงกับคำค้นนี้' : 'ยังไม่มีความเคลื่อนไหวที่บันทึกไว้'}
            </p>
          )}

          {activity.data.length > 0 && (
            <div className="-mx-1 overflow-x-auto px-1">
              <table className="w-full min-w-[44rem] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-left text-[var(--text)]">
                    <th scope="col" className="px-3 py-2 font-medium">ประเภท</th>
                    <th scope="col" className="px-3 py-2 font-medium">บัญชี</th>
                    <th scope="col" className="px-3 py-2 font-medium">แพ็กเกจ</th>
                    <th scope="col" className="px-3 py-2 font-medium">สถานะ</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">จำนวน (บาท)</th>
                    <th scope="col" className="px-3 py-2 font-medium">เวลา</th>
                    <th scope="col" className="px-3 py-2 font-medium">อ้างอิง</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.data.map((row, index) => {
                    const invoiceUrl = stripeInvoiceUrl(providerMode, row.provider_ref);
                    const accountUrl = supabaseAccountUrl(projectRef, row.user_id);
                    return (
                      <tr
                        key={`${row.activity_kind}-${row.user_id}-${row.occurred_at}-${index}`}
                        className="border-b border-[var(--border)] last:border-0"
                      >
                        <td className="px-3 py-2">
                          <StatusChip
                            label={ACTIVITY_KIND_LABEL[row.activity_kind]}
                            tone={ACTIVITY_TONE[row.activity_kind]}
                          />
                        </td>
                        <td className="max-w-[14rem] px-3 py-2">
                          <span className="block truncate text-[var(--text)]">
                            {reveal ? row.email ?? maskAccountRef(row.user_id) : maskEmail(row.email)}
                          </span>
                          {accountUrl && (
                            <a
                              href={accountUrl}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] underline underline-offset-4 hover:text-[var(--text)]"
                            >
                              {maskAccountRef(row.user_id)}
                              <ExternalLink aria-hidden="true" size={11} />
                            </a>
                          )}
                        </td>
                        <td className="px-3 py-2 text-[var(--text-muted)]">
                          {isBillingPlanKey(row.plan_key)
                            ? billingPlans[row.plan_key].name
                            : row.plan_key ?? '—'}
                        </td>
                        <td className="px-3 py-2 text-[var(--text-muted)]">{row.status}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-[var(--text-muted)]">
                          {row.amount_minor ? formatMinorAsBaht(row.amount_minor, row.currency) : '—'}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-[var(--text-muted)]">
                          {when(row.occurred_at)}
                        </td>
                        <td className="px-3 py-2 text-[var(--text-muted)]">
                          {/*
                            The label is always masked. The full identifier exists
                            only inside this href, which opens the provider's own
                            dashboard and grants nothing without a session there.
                          */}
                          {invoiceUrl ? (
                            <a
                              href={invoiceUrl}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="inline-flex items-center gap-1 underline underline-offset-4 hover:text-[var(--text)]"
                            >
                              {maskIdentifier(row.provider_ref)}
                              <ExternalLink aria-hidden="true" size={11} />
                            </a>
                          ) : (
                            maskIdentifier(row.provider_ref)
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {pages > 1 && (
            <nav className="flex items-center justify-between gap-2 text-sm" aria-label="แบ่งหน้า">
              <Link
                href={link({ page: String(Math.max(1, page - 1)) })}
                aria-disabled={page <= 1}
                className={`min-h-11 inline-flex items-center rounded-xl border border-[var(--border-strong)] px-4 ${page <= 1 ? 'pointer-events-none opacity-40' : 'hover:bg-[var(--surface-hover)]'}`}
              >
                ก่อนหน้า
              </Link>
              <span className="text-xs text-[var(--text-muted)]">หน้า {page} จาก {pages}</span>
              <Link
                href={link({ page: String(Math.min(pages, page + 1)) })}
                aria-disabled={page >= pages}
                className={`min-h-11 inline-flex items-center rounded-xl border border-[var(--border-strong)] px-4 ${page >= pages ? 'pointer-events-none opacity-40' : 'hover:bg-[var(--surface-hover)]'}`}
              >
                ถัดไป
              </Link>
            </nav>
          )}
        </section>

        <section className="min-w-0 space-y-3">
          <h2 className="text-base font-semibold text-[var(--text)]">การกระทำล่าสุดของผู้ดูแลระบบ</h2>
          {audit.unavailable && <ReadFailed what="บันทึกการตรวจสอบ" />}
          {!audit.unavailable && audit.data.length === 0 && (
            <p className="rounded-xl border border-dashed border-[var(--border-strong)] p-4 text-sm text-[var(--text-muted)]">
              ยังไม่มีการกระทำที่บันทึกไว้
            </p>
          )}
          {audit.data.length > 0 && (
            <ul className="min-w-0 divide-y divide-[var(--border)] rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
              {audit.data.map((row, index) => (
                <li
                  key={`${row.source}-${row.created_at}-${index}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate text-[var(--text)]">{row.action}</span>
                  <span className="shrink-0 text-xs text-[var(--text-muted)]">
                    {row.target_type}
                    {row.target_ref ? ` · ${maskAccountRef(row.target_ref)}` : ''}
                  </span>
                  <span className="shrink-0 text-xs text-[var(--text-muted)]">{when(row.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

/**
 * One labelled band of figures.
 *
 * The heading is what turns nineteen cards into three answers, and it is a real
 * `h3` under the section's `h2` so the outline a screen reader announces matches
 * the one an eye follows.
 *
 * Two columns is the floor at every size, so a handset never shows a column of
 * full-width cards; `columns` sets the wider breakpoints per group so each one
 * lands on a full last row, which is what the old flat stack of three grids did
 * not. `featureFirst` widens the first card to two columns — the group's own
 * headline figure, sized to say so at every breakpoint, and on a 320px handset
 * that simply means the full width.
 */
function StatGroup({
  title,
  children,
  columns = 'sm:grid-cols-3 lg:grid-cols-4',
  featureFirst = false,
  note,
}: {
  title: string;
  children: ReactNode;
  columns?: string;
  featureFirst?: boolean;
  note?: string;
}) {
  return (
    <section className="min-w-0 space-y-2">
      <h3 className="text-sm font-semibold text-[var(--text-muted)]">{title}</h3>
      <div
        className={`grid min-w-0 grid-cols-2 gap-3 ${columns} ${
          featureFirst ? '[&>*:first-child]:col-span-2' : ''
        }`}
      >
        {children}
      </div>
      {note && <p className="text-xs text-[var(--text-muted)]">{note}</p>}
    </section>
  );
}

function ReadFailed({ what }: { what: string }) {
  return (
    <p className="flex items-start gap-2 rounded-xl border border-[var(--border)] p-4 text-sm text-[var(--negative)]">
      <AlertTriangle aria-hidden="true" size={16} className="mt-0.5 shrink-0" />
      <span className="min-w-0">อ่าน{what}ไม่สำเร็จ ส่วนอื่นของหน้านี้ยังใช้งานได้ตามปกติ</span>
    </p>
  );
}

function Unavailable() {
  return (
    <div className="min-w-0">
      <Header title="ศูนย์ปฏิบัติการ" subtitle="เฉพาะผู้ดูแลระบบ" backFallbackHref="/" />
      <main className="mx-auto w-full max-w-3xl p-4 md:p-8">
        <ReadFailed what="ข้อมูล" />
      </main>
    </div>
  );
}
