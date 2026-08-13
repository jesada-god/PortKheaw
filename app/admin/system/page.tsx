import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import Header from '@/src/components/layout/Header';
import { MaintenanceControl } from '@/src/components/admin/MaintenanceControl';
import { ReleaseNoteEditor, type EditableRelease } from '@/src/components/admin/ReleaseNoteEditor';
import { createClient } from '@/src/lib/supabase/server';
import {
  loadMaintenanceAudit, loadMaintenanceState, loadReleaseNotes, totalFrom,
} from '@/src/lib/admin/admin-repository';
import { maskAccountRef } from '@/src/lib/admin/masking';
import { resolvePagination, totalPages } from '@/src/lib/admin/dashboard-presentation';
import {
  normalizeReleaseImportance, parseReleaseBody, RELEASE_IMPORTANCE_LABEL,
} from '@/src/lib/release-notes/release-notes';
import { requireAdminPage } from '@/src/lib/admin/admin-guard';

/**
 * The system console: the switch, and the announcement that follows it.
 *
 * They share a page because they share a moment — an operator here is either
 * about to take the product down or has just brought it back — and they share
 * nothing else. Neither write touches the other's table, and switching the
 * product back on never depends on an announcement saving.
 *
 * Everything on it comes from `security definer` routines that check
 * `is_platform_admin` inside the database, called through the operator's own
 * session. The layout above already refused a non-operator; the database refuses
 * again, which is the boundary.
 */
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

const DATE_FORMAT = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok',
});

function when(value: string | null): string {
  if (!value) return '—';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? DATE_FORMAT.format(new Date(timestamp)) : '—';
}

/** The audit row's `after_summary` is `jsonb`; read one flag out of it safely. */
function auditEnabled(summary: unknown): boolean | null {
  if (!summary || typeof summary !== 'object') return null;
  const value = (summary as Record<string, unknown>).maintenance_enabled;
  return typeof value === 'boolean' ? value : null;
}

export default async function AdminSystemPage({
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

  const { page, offset } = resolvePagination({ page: single('page'), pageSize: PAGE_SIZE });
  const editId = single('edit');
  const compose = single('compose') === '1';

  const supabase = await createClient();
  if (!supabase) return <Shell><ReadFailed what="ข้อมูล" /></Shell>;

  const [state, audit, notes] = await Promise.all([
    loadMaintenanceState(supabase),
    loadMaintenanceAudit(supabase, 8),
    loadReleaseNotes(supabase, { limit: PAGE_SIZE, offset }),
  ]);

  const total = totalFrom(notes.data);
  const pages = totalPages(total, PAGE_SIZE);
  const selected = editId ? notes.data.find((row) => row.id === editId) ?? null : null;
  const editing: EditableRelease | null = selected ? {
    id: selected.id,
    version: selected.version,
    title: selected.title,
    content: selected.content,
    importance: normalizeReleaseImportance(selected.importance),
    isPublished: selected.is_published,
  } : null;

  return (
    <Shell>
      <section className="min-w-0 space-y-3">
        {state.unavailable && <ReadFailed what="สถานะระบบ" />}
        <MaintenanceControl
          enabled={state.data?.maintenance_enabled ?? false}
          message={state.data?.maintenance_message ?? null}
          expectedResumeAt={state.data?.expected_resume_at ?? null}
          startedAt={state.data?.maintenance_started_at ?? null}
          // Masked, like every other account reference on the console. The
          // operator who threw the switch is identified, not exposed.
          startedByLabel={state.data?.maintenance_started_by
            ? maskAccountRef(state.data.maintenance_started_by)
            : null}
          audit={audit.data.map((row) => ({
            id: Number(row.id),
            action: row.action,
            at: row.created_at,
            enabled: auditEnabled(row.after_summary),
          }))}
          releaseNotesHref="/admin/system?compose=1#release-notes"
        />
      </section>

      <section id="release-notes" className="min-w-0 space-y-3">
        <h2 className="text-base font-semibold text-[var(--text)]">ประกาศหลังอัปเดต</h2>
        <p className="text-xs text-[var(--text-muted)]">
          ประกาศที่เผยแพร่จะแสดงเป็น popup “มีอะไรใหม่” ให้ผู้ใช้ที่ยังไม่เคยเห็น หนึ่งครั้งต่อหนึ่งประกาศ
          ระบบนี้แยกจากสถานะปรับปรุงระบบ จึงเผยแพร่ได้แม้ไม่ได้ปิดแอป
        </p>

        <ReleaseNoteEditor key={editing?.id ?? 'new'} editing={editing} autoOpen={compose} />

        {notes.unavailable && <ReadFailed what="ประวัติประกาศ" />}
        {!notes.unavailable && notes.data.length === 0 && (
          <p className="rounded-xl border border-dashed border-[var(--border-strong)] p-4 text-sm text-[var(--text-muted)]">
            ยังไม่มีประกาศ
          </p>
        )}

        {notes.data.length > 0 && (
          <ul className="min-w-0 divide-y divide-[var(--border)] rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
            {notes.data.map((row) => (
              <li key={row.id} className="min-w-0 space-y-1.5 px-4 py-3">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                    row.is_published
                      ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                      : 'border border-[var(--border)] text-[var(--text-muted)]'
                  }`}
                  >
                    {row.is_published ? 'เผยแพร่แล้ว' : 'ร่าง'}
                  </span>
                  {row.version && (
                    <span className="text-[11px] text-[var(--text-muted)]">v{row.version}</span>
                  )}
                  <span className="text-[11px] text-[var(--text-muted)]">
                    {RELEASE_IMPORTANCE_LABEL[normalizeReleaseImportance(row.importance)]}
                  </span>
                  <span className="text-[11px] text-[var(--text-muted)]">
                    {when(row.published_at ?? row.created_at)}
                  </span>
                </div>
                <p className="min-w-0 break-words text-sm font-medium text-[var(--text)] [overflow-wrap:anywhere]">
                  {row.title}
                </p>
                {/*
                  Rendered as React children, so the body is escaped by the
                  renderer exactly as it is in the reader-facing popup. There is
                  no markup path for this string on either surface.
                */}
                <ul className="min-w-0 space-y-0.5">
                  {parseReleaseBody(row.content).slice(0, 3).map((line, index) => (
                    <li
                      key={`${row.id}-${index}`}
                      className="min-w-0 break-words text-xs text-[var(--text-muted)] [overflow-wrap:anywhere]"
                    >
                      {line.kind === 'bullet' ? `• ${line.text}` : line.text}
                    </li>
                  ))}
                </ul>
                <Link
                  href={`/admin/system?edit=${row.id}#release-notes`}
                  className="inline-flex min-h-11 items-center text-xs font-medium text-[var(--accent)] underline underline-offset-4"
                >
                  แก้ไข
                </Link>
              </li>
            ))}
          </ul>
        )}

        {pages > 1 && (
          <nav className="flex min-w-0 items-center justify-between gap-2 text-sm" aria-label="หน้าประกาศ">
            <Link
              href={`/admin/system?page=${Math.max(1, page - 1)}`}
              aria-disabled={page <= 1}
              className={`inline-flex min-h-11 items-center rounded-xl border border-[var(--border-strong)] px-4 ${page <= 1 ? 'pointer-events-none opacity-40' : 'hover:bg-[var(--surface-hover)]'}`}
            >
              ก่อนหน้า
            </Link>
            <span className="text-xs text-[var(--text-muted)]">หน้า {page} จาก {pages}</span>
            <Link
              href={`/admin/system?page=${Math.min(pages, page + 1)}`}
              aria-disabled={page >= pages}
              className={`inline-flex min-h-11 items-center rounded-xl border border-[var(--border-strong)] px-4 ${page >= pages ? 'pointer-events-none opacity-40' : 'hover:bg-[var(--surface-hover)]'}`}
            >
              ถัดไป
            </Link>
          </nav>
        )}
      </section>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <Header title="สถานะระบบและประกาศ" subtitle="เฉพาะผู้ดูแลระบบ" backFallbackHref="/admin" />
      <main className="mx-auto w-full min-w-0 max-w-3xl space-y-6 p-4 md:p-8">{children}</main>
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
