import Image from 'next/image';
import Link from 'next/link';
import type { Metadata } from 'next';
import { ShieldCheck, Wrench } from 'lucide-react';
import { MaintenanceRecovery } from '@/src/components/maintenance/MaintenanceRecovery';
import { resolveMaintenanceState } from '@/src/lib/maintenance/maintenance-server';

/**
 * The notice.
 *
 * It is never gated — that would be a redirect loop — so it has to be correct in
 * both directions: it renders the live switch, so an operator who has already
 * switched the product back on and a reader who arrived here by bookmark both
 * see the truth rather than a page that insists the site is down.
 *
 * The mascot is the existing loading asset at its intrinsic size, not a new one.
 * A maintenance page is served during the worst minute a product has; adding an
 * image to the bundle for it would be paying for that minute twice.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'กำลังปรับปรุงระบบ',
  robots: { index: false, follow: false },
};

const TIME_FORMAT = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok',
});

function when(value: string | null): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? TIME_FORMAT.format(new Date(timestamp)) : null;
}

export default async function MaintenancePage() {
  const state = await resolveMaintenanceState();
  const resumeAt = when(state.expectedResumeAt);

  return (
    <div className="flex min-h-dvh w-full items-center justify-center px-4 py-10">
      <main className="flex w-full min-w-0 max-w-md flex-col items-center gap-5 text-center">
        <Image
          src="/brand/kheaw-loading.webp"
          alt=""
          width={160}
          height={160}
          priority
          className="h-auto w-[clamp(110px,34vw,160px)] select-none"
        />

        {state.enabled ? (
          <>
            <div className="min-w-0 space-y-2">
              <p className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-xs font-medium text-[var(--text-muted)]">
                <Wrench aria-hidden="true" size={13} />
                กำลังปรับปรุงระบบ
              </p>
              <h1 className="text-xl font-semibold text-[var(--text)] sm:text-2xl">
                PortKheaw กำลังอัปเดตระบบ
              </h1>
              <p className="text-sm leading-relaxed text-[var(--text-muted)] [overflow-wrap:anywhere]">
                {state.message?.trim()
                  || 'ทีมงานกำลังอัปเดตระบบเพื่อให้ใช้งานได้ดีขึ้น จะกลับมาให้บริการอีกครั้งเร็ว ๆ นี้'}
              </p>
              {resumeAt && (
                <p className="text-sm font-medium text-[var(--text)]">
                  คาดว่าจะกลับมาให้บริการ {resumeAt} น.
                </p>
              )}
            </div>

            <p className="flex min-w-0 items-start gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-3 text-left text-xs leading-relaxed text-[var(--text-muted)]">
              <ShieldCheck aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-[var(--positive)]" />
              <span className="min-w-0">
                ข้อมูลบัญชีและพอร์ตการลงทุนของคุณยังถูกเก็บรักษาไว้ตามปกติ
                การปรับปรุงนี้ไม่มีผลกับรายการที่คุณบันทึกไว้
              </span>
            </p>
          </>
        ) : (
          <div className="min-w-0 space-y-2">
            <h1 className="text-xl font-semibold text-[var(--text)] sm:text-2xl">
              PortKheaw พร้อมใช้งานแล้ว
            </h1>
            <p className="text-sm text-[var(--text-muted)]">
              การปรับปรุงระบบเสร็จสิ้นแล้ว กลับเข้าใช้งานได้ทันที
            </p>
          </div>
        )}

        <MaintenanceRecovery />

        <p className="text-xs text-[var(--text-muted)]">
          <Link
            href="/auth/sign-in"
            className="rounded underline underline-offset-4 transition-colors hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            เข้าสู่ระบบสำหรับทีมงาน
          </Link>
        </p>
      </main>
    </div>
  );
}
