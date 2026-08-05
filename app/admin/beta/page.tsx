import Link from 'next/link';
import { AlertTriangle, Search } from 'lucide-react';
import Header from '@/src/components/layout/Header';
import { StatCard } from '@/src/components/admin/StatCard';
import { StatusChip } from '@/src/components/support/StatusChip';
import { AddBetaInvite, RevokeBetaInvite } from '@/src/components/admin/BetaInviteControls';
import { BetaStageControl } from '@/src/components/admin/BetaStageControl';
import { Input } from '@/src/components/ui/Input';
import { Button } from '@/src/components/ui/Button';
import { createClient } from '@/src/lib/supabase/server';
import {
  loadBetaFeatureReport, loadBetaInvites, loadBetaProgramState, loadBetaReport, totalFrom,
} from '@/src/lib/admin/admin-repository';
import { formatCount, resolvePagination, totalPages } from '@/src/lib/admin/dashboard-presentation';
import { maskEmail } from '@/src/lib/admin/masking';
import { BETA_STAGE_LABEL, normalizeBetaStage, stageAcceptsCap } from '@/src/lib/beta/beta-stages';

/**
 * The rollout console.
 *
 * Three things live here and nowhere else: the stage, the invitation list, and
 * the report that says whether the cohort is converting.
 *
 * The report is aggregate by default and stays that way. A funnel answers "did
 * this cohort convert, and where did it stop?" — a question about a group. The
 * per-account drill-down an operator sometimes needs during support already
 * exists as the billing console's account search, which is separately gated and
 * separately audited; duplicating it here would mean a second, less careful path
 * to the same personal data.
 */
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

const DATE_FORMAT = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok',
});

function when(value: string | null): string {
  if (!value) return '—';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? DATE_FORMAT.format(new Date(timestamp)) : '—';
}

/** A conversion rate, or `—` when the denominator is zero. Never `NaN%`. */
function rate(numerator: number, denominator: number): string {
  if (!denominator) return '—';
  return `${Math.round((numerator / denominator) * 1000) / 10}%`;
}

const FUNNEL_STEPS = [
  { key: 'signup_completed', label: 'สมัครสมาชิกสำเร็จ' },
  { key: 'subscription_viewed', label: 'เปิดหน้าแพ็กเกจ' },
  { key: 'checkout_started', label: 'เริ่มชำระเงิน' },
  { key: 'checkout_returned', label: 'กลับจากหน้าชำระเงิน' },
  { key: 'checkout_canceled', label: 'ยกเลิกกลางทาง' },
  { key: 'payment_succeeded', label: 'ชำระเงินสำเร็จ' },
  { key: 'promptpay_help_viewed', label: 'เปิดวิธีต่ออายุ PromptPay' },
  { key: 'promptpay_renewal_paid', label: 'ต่ออายุ PromptPay สำเร็จ' },
] as const;

export default async function AdminBetaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const single = (key: string): string | undefined =>
    typeof params[key] === 'string' ? params[key] : undefined;

  const query = single('q')?.trim() ?? '';
  const { page, offset } = resolvePagination({ page: single('page'), pageSize: PAGE_SIZE });

  const supabase = await createClient();
  if (!supabase) return <Shell><ReadFailed what="ข้อมูล" /></Shell>;

  const [state, report, features, invites] = await Promise.all([
    loadBetaProgramState(supabase),
    loadBetaReport(supabase),
    loadBetaFeatureReport(supabase, 15),
    loadBetaInvites(supabase, { query: query || null, limit: PAGE_SIZE, offset }),
  ]);

  const program = state.data;
  const stage = normalizeBetaStage(program?.stage);
  const inviteTotal = totalFrom(invites.data);
  const pages = totalPages(inviteTotal, PAGE_SIZE);
  const running = report.data.find((row) => row.stage === stage);
  const cap = program?.effective_cap ?? 0;
  const capLabel = cap < 0 ? 'ไม่จำกัด' : formatCount(cap);
  const overCap = cap >= 0 && (program?.active_invites ?? 0) > cap;

  const link = (next: Record<string, string | undefined>): string => {
    const search = new URLSearchParams();
    const merged: Record<string, string | undefined> = {
      q: query || undefined, page: String(page), ...next,
    };
    for (const [key, value] of Object.entries(merged)) {
      if (value && !(key === 'page' && value === '1')) search.set(key, value);
    }
    const encoded = search.toString();
    return encoded ? `/admin/beta?${encoded}` : '/admin/beta';
  };

  return (
    <Shell>
      {state.unavailable && <ReadFailed what="สถานะการเปิดใช้งาน" />}

      <section className="min-w-0 space-y-3">
        <h2 className="text-base font-semibold text-[var(--text)]">สถานะปัจจุบัน</h2>
        <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4">
          <StatCard label="สถานะ" value={BETA_STAGE_LABEL[stage]} />
          <StatCard label="โควตา" value={capLabel} />
          <StatCard
            label="คำเชิญที่ใช้งานอยู่"
            value={formatCount(program?.active_invites ?? 0)}
            tone={overCap ? 'attention' : 'neutral'}
            hint={overCap ? 'มากกว่าโควตาของสถานะนี้' : undefined}
          />
          <StatCard label="สมัครแล้วและชำระเงิน" value={formatCount(running?.paid ?? 0)} />
        </div>
        <p className="text-xs text-[var(--text-muted)]">
          สถานะนี้ควบคุมเฉพาะ “การสมัครแพ็กเกจใหม่” เท่านั้น
          ผู้ที่ชำระเงินแล้วและบัญชีที่มีอยู่ก่อนเริ่มโปรแกรมยังใช้งาน ต่ออายุ ขอคืนเงิน
          และติดต่อทีมงานได้ตามปกติในทุกสถานะ
          {program?.enforced_from ? ` เริ่มบังคับใช้ ${when(program.enforced_from)}` : ''}
        </p>

        <BetaStageControl currentStage={stage} currentCap={program?.participant_cap ?? null} />
      </section>

      <section className="min-w-0 space-y-3">
        <h2 className="text-base font-semibold text-[var(--text)]">
          รายชื่อผู้ได้รับเชิญ{inviteTotal > 0 ? ` (${formatCount(inviteTotal)})` : ''}
        </h2>

        <AddBetaInvite disabled={!stageAcceptsCap(stage)} />

        <form method="get" className="flex min-w-0 flex-col gap-2 sm:flex-row">
          <Input
            name="q"
            defaultValue={query}
            placeholder="ค้นหาอีเมลผู้ได้รับเชิญ"
            aria-label="ค้นหาผู้ได้รับเชิญ"
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="outline" className="shrink-0">
            <Search aria-hidden="true" size={16} className="mr-2" />
            ค้นหา
          </Button>
        </form>

        {invites.unavailable && <ReadFailed what="รายชื่อผู้ได้รับเชิญ" />}

        {!invites.unavailable && invites.data.length === 0 && (
          <p className="rounded-xl border border-dashed border-[var(--border-strong)] p-4 text-sm text-[var(--text-muted)]">
            {query ? 'ไม่พบผู้ได้รับเชิญที่ตรงกับคำค้นนี้' : 'ยังไม่มีผู้ได้รับเชิญ'}
          </p>
        )}

        {invites.data.length > 0 && (
          <ul className="min-w-0 divide-y divide-[var(--border)] rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
            {invites.data.map((invite) => (
              <li key={invite.invite_id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                {/* Masked, like everywhere else in the console. An operator
                    searching for an address they already know still finds it. */}
                <span className="min-w-0 flex-1 truncate text-sm text-[var(--text)]">
                  {maskEmail(invite.email)}
                </span>
                {invite.revoked_at
                  ? <StatusChip label="ยกเลิกแล้ว" tone="neutral" />
                  : <StatusChip label="ใช้งานอยู่" tone="active" />}
                {invite.has_account && <StatusChip label="สมัครสมาชิกแล้ว" tone="waiting" />}
                {invite.has_paid && <StatusChip label="ชำระเงินแล้ว" tone="positive" />}
                <span className="shrink-0 text-xs text-[var(--text-muted)]">{when(invite.invited_at)}</span>
                {!invite.revoked_at && <RevokeBetaInvite inviteId={invite.invite_id} />}
              </li>
            ))}
          </ul>
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
        <h2 className="text-base font-semibold text-[var(--text)]">Funnel ของรอบที่กำลังใช้งาน</h2>
        {report.unavailable && <ReadFailed what="รายงาน Funnel" />}
        {running && (
          <>
            <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4">
              <StatCard label="เชิญแล้ว" value={formatCount(running.invited)} />
              <StatCard
                label="สมัครสมาชิกแล้ว"
                value={formatCount(running.signed_up)}
                hint={`จากคำเชิญ ${rate(running.signed_up, running.invited)}`}
              />
              <StatCard
                label="เริ่มชำระเงิน"
                value={formatCount(running.checkout_started)}
                hint={`จากผู้เปิดหน้าแพ็กเกจ ${rate(running.checkout_started, running.subscription_viewed)}`}
              />
              <StatCard
                label="ชำระเงินสำเร็จ"
                value={formatCount(running.payment_succeeded)}
                hint={`จากผู้เริ่มชำระ ${rate(running.payment_succeeded, running.checkout_started)}`}
              />
            </div>

            <div className="-mx-1 overflow-x-auto px-1">
              <table className="w-full min-w-[34rem] border-collapse text-sm">
                <caption className="sr-only">จำนวนบัญชีที่ไม่ซ้ำกันในแต่ละขั้นของ Funnel</caption>
                <thead>
                  <tr className="border-b border-[var(--border)] text-left text-[var(--text)]">
                    <th scope="col" className="px-3 py-2 font-medium">ขั้นตอน</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">บัญชี (ไม่ซ้ำ)</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">เทียบกับขั้นก่อนหน้า</th>
                  </tr>
                </thead>
                <tbody>
                  {FUNNEL_STEPS.map((step, index) => {
                    const value = running[step.key];
                    const previous = index > 0 ? running[FUNNEL_STEPS[index - 1].key] : null;
                    return (
                      <tr key={step.key} className="border-b border-[var(--border)] last:border-0">
                        <td className="px-3 py-2 text-[var(--text)]">{step.label}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-[var(--text)]">
                          {formatCount(value)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-[var(--text-muted)]">
                          {previous === null ? '—' : rate(value, previous)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <p className="text-xs text-[var(--text-muted)]">
              ตัวเลขนับ “จำนวนบัญชีที่ไม่ซ้ำกัน” ต่อวัน ไม่ใช่จำนวนคลิก
              จึงไม่พองขึ้นจากการกดซ้ำหรือรีเฟรชหน้า
              และไม่มีการเก็บข้อความ ยอดเงิน หรือรหัสอ้างอิงของผู้ให้บริการชำระเงิน
            </p>
          </>
        )}
      </section>

      <section className="min-w-0 space-y-3">
        <h2 className="text-base font-semibold text-[var(--text)]">
          ฟีเจอร์ที่ถูกกั้น และฟีเจอร์ที่ใช้ก่อนซื้อ
        </h2>
        {features.unavailable && <ReadFailed what="รายงานฟีเจอร์" />}
        {!features.unavailable && features.data.length === 0 && (
          <p className="rounded-xl border border-dashed border-[var(--border-strong)] p-4 text-sm text-[var(--text-muted)]">
            ยังไม่มีข้อมูลในช่วงนี้
          </p>
        )}
        {features.data.length > 0 && (
          <div className="-mx-1 overflow-x-auto px-1">
            <table className="w-full min-w-[32rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-[var(--text)]">
                  <th scope="col" className="px-3 py-2 font-medium">ประเภท</th>
                  <th scope="col" className="px-3 py-2 font-medium">ฟีเจอร์</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">บัญชี</th>
                  <th scope="col" className="px-3 py-2 font-medium">ล่าสุด</th>
                </tr>
              </thead>
              <tbody>
                {features.data.map((row) => (
                  <tr key={`${row.event_key}-${row.feature_key}`} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-3 py-2">
                      <StatusChip
                        label={row.event_key === 'paywall_blocked' ? 'ถูกกั้น' : 'ใช้ก่อนซื้อ'}
                        tone={row.event_key === 'paywall_blocked' ? 'waiting' : 'neutral'}
                      />
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-[var(--text)]">{row.feature_key}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[var(--text-muted)]">
                      {formatCount(row.accounts)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-[var(--text-muted)]">
                      {when(row.last_seen_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="min-w-0 space-y-3">
        <h2 className="text-base font-semibold text-[var(--text)]">เปรียบเทียบระหว่างรอบ</h2>
        <div className="-mx-1 overflow-x-auto px-1">
          <table className="w-full min-w-[36rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-[var(--text)]">
                <th scope="col" className="px-3 py-2 font-medium">รอบ</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">เปิดหน้าแพ็กเกจ</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">เริ่มชำระ</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">ชำระสำเร็จ</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">ถูกกั้น</th>
              </tr>
            </thead>
            <tbody>
              {report.data.map((row) => (
                <tr key={row.stage} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-3 py-2 text-[var(--text)]">
                    {row.stage === 'unknown' ? 'ไม่ระบุ' : BETA_STAGE_LABEL[row.stage]}
                    {row.stage === stage && (
                      <span className="ml-2 text-xs text-[var(--accent)]">กำลังใช้งาน</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--text-muted)]">{formatCount(row.subscription_viewed)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--text-muted)]">{formatCount(row.checkout_started)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--text-muted)]">{formatCount(row.payment_succeeded)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--text-muted)]">{formatCount(row.paywall_blocked)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <Header
        title="การเปิดใช้งานแบบควบคุม"
        subtitle="สถานะรอบทดลอง โควตา และรายงานการใช้งาน"
        backFallbackHref="/admin"
      />
      <main className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-6 p-4 md:p-8">
        {children}
      </main>
    </div>
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
