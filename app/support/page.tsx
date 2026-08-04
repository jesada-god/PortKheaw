import type { Metadata } from 'next';
import Link from 'next/link';
import Header from '@/src/components/layout/Header';
import { LegalFooterLinks } from '@/src/components/legal/LegalFooterLinks';
import { SupportContactCard } from '@/src/components/support/SupportContactCard';
import { SupportFaq } from '@/src/components/support/SupportFaq';
import { TicketForm } from '@/src/components/support/TicketForm';
import { TicketList } from '@/src/components/support/TicketList';
import { createClient } from '@/src/lib/supabase/server';
import { listMyTickets } from '@/src/lib/support/ticket-repository';

/**
 * The help desk.
 *
 * Deliberately **not** a protected route. The FAQ and the two direct channels
 * have to be readable by somebody who cannot sign in — which is precisely the
 * reader with the most urgent problem — so the page renders for everyone and
 * only the ticket section asks for a session.
 *
 * Per-reader, so never prerendered into shared HTML.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'ช่วยเหลือ',
  description: 'คำถามที่พบบ่อย ติดต่อทีมงาน และรายงานปัญหา',
};

export default async function SupportPage() {
  const supabase = await createClient();
  const { data } = supabase ? await supabase.auth.getUser() : { data: { user: null } };
  const user = data?.user ?? null;

  /*
   * A ticket list that could not be read is rendered as an empty list rather
   * than as an error page. The reason matters: this is the page somebody lands
   * on *because* something is broken, and it has to keep working — the FAQ, the
   * contacts and the form are all still useful without the history.
   */
  let tickets: Awaited<ReturnType<typeof listMyTickets>> = [];
  if (supabase && user) {
    try {
      tickets = await listMyTickets(supabase);
    } catch {
      tickets = [];
    }
  }

  return (
    <div className="min-w-0">
      <Header title="ช่วยเหลือ" subtitle="คำถามที่พบบ่อย ติดต่อทีมงาน และรายงานปัญหา" />
      <main className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-8 p-4 md:p-8">
        <SupportFaq />
        <SupportContactCard />

        <section id="report" className="min-w-0 space-y-4 scroll-mt-20">
          <div className="min-w-0 space-y-1">
            <h2 className="text-base font-semibold text-[var(--text)]">รายงานปัญหา</h2>
            <p className="text-sm text-[var(--text-muted)]">
              แจ้งเรื่องผ่านระบบเพื่อให้ทีมงานตอบกลับและติดตามสถานะได้ในที่เดียว
            </p>
          </div>

          <div className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)] sm:p-6">
            {user ? (
              <TicketForm />
            ) : (
              <div className="min-w-0 space-y-3">
                <p className="text-sm text-[var(--text-muted)]">
                  เข้าสู่ระบบเพื่อแจ้งเรื่องและติดตามสถานะได้ในหน้านี้
                  หากเข้าสู่ระบบไม่ได้ ติดต่อทีมงานผ่าน Facebook หรือ LINE ด้านบนได้เลย
                </p>
                <Link
                  href="/auth/sign-in?next=/support"
                  className="inline-flex min-h-11 items-center justify-center rounded-md bg-[var(--accent)] px-4 text-sm font-medium text-[var(--accent-fg)] transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                >
                  เข้าสู่ระบบ
                </Link>
              </div>
            )}
          </div>
        </section>

        {user && (
          <section className="min-w-0 space-y-3">
            <h2 className="text-base font-semibold text-[var(--text)]">เรื่องที่คุณแจ้งไว้</h2>
            <TicketList
              tickets={tickets}
              hrefBase="/support/tickets"
              emptyMessage="ยังไม่มีเรื่องที่แจ้งไว้ เมื่อส่งเรื่องแล้วจะแสดงที่นี่พร้อมสถานะล่าสุด"
            />
          </section>
        )}

        <LegalFooterLinks includeSupport={false} />
      </main>
    </div>
  );
}
