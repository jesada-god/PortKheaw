'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Pencil, Plus } from 'lucide-react';
import { Button } from '@/src/components/ui/Button';
import { Input } from '@/src/components/ui/Input';
import { Select } from '@/src/components/ui/Select';
import { saveReleaseNoteAction } from '@/app/admin/system/actions';
import {
  RELEASE_IMPORTANCE_LABEL, RELEASE_PROBLEM_MESSAGE, releaseImportances,
  validateReleaseDraft, type ReleaseImportance,
} from '@/src/lib/release-notes/release-notes';

/**
 * Writing an announcement.
 *
 * Deliberately a textarea and not a rich-text editor. The body reaches every
 * signed-in reader's session, so it is plain text end to end — bullets are a
 * line prefix the renderer recognises, never markup that has to be sanitised.
 * A toolbar here would be the first step towards a field that can carry script.
 *
 * Two distinct saves, because they are two distinct intentions: "บันทึกร่าง"
 * leaves the publication state exactly as it is, and "เผยแพร่" is the only thing
 * that shows an announcement to anybody. Editing a published note therefore
 * cannot silently re-announce it, and saving a draft cannot accidentally publish.
 */

export interface EditableRelease {
  id: string;
  version: string | null;
  title: string;
  content: string;
  importance: ReleaseImportance;
  isPublished: boolean;
}

const EMPTY = {
  id: '',
  version: '',
  title: 'PortKheaw Update',
  content: '• เพิ่ม \n• ปรับปรุง \n• แก้ไข ',
  importance: 'normal' as ReleaseImportance,
  isPublished: false,
};

export function ReleaseNoteEditor({
  editing,
  autoOpen = false,
}: {
  /**
   * The row the URL selected, or `null` for a new note. The page gives this
   * component a `key` derived from the same id, so selecting a different row
   * remounts the form with that row's values — which is why there is no effect
   * here syncing props into state, and no window in which the form shows one
   * note while the operator is editing another.
   */
  editing: EditableRelease | null;
  /** The console arrives here with `?compose=1` after a maintenance window ends. */
  autoOpen?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(autoOpen || editing !== null);
  const [draft, setDraft] = useState(() => (editing ? {
    id: editing.id,
    version: editing.version ?? '',
    title: editing.title,
    content: editing.content,
    importance: editing.importance,
    isPublished: editing.isPublished,
  } : EMPTY));
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(publish: boolean | null) {
    const problem = validateReleaseDraft(draft);
    if (problem) {
      setResult({ ok: false, message: RELEASE_PROBLEM_MESSAGE[problem] });
      return;
    }

    setResult(null);
    const formData = new FormData();
    if (draft.id) formData.set('id', draft.id);
    formData.set('version', draft.version);
    formData.set('title', draft.title);
    formData.set('content', draft.content);
    formData.set('importance', draft.importance);
    if (publish !== null) formData.set('publish', String(publish));

    startTransition(async () => {
      const outcome = await saveReleaseNoteAction(formData);
      setResult(outcome);
      if (outcome.ok) {
        if (!draft.id && outcome.releaseId) setDraft((current) => ({ ...current, id: outcome.releaseId as string }));
        router.refresh();
      }
    });
  }

  if (!open) {
    return (
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" size={16} />
        เขียนประกาศใหม่
      </Button>
    );
  }

  return (
    <div className="min-w-0 space-y-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--text)]">
          <Pencil aria-hidden="true" size={15} />
          {draft.id ? 'แก้ไขประกาศ' : 'ประกาศใหม่'}
        </h3>
        {draft.id && (
          <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--text-muted)]">
            {draft.isPublished ? 'เผยแพร่แล้ว' : 'ร่าง'}
          </span>
        )}
      </div>

      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-1.5">
          <label htmlFor="release-version" className="block text-sm font-medium text-[var(--text)]">
            เวอร์ชัน (ไม่บังคับ)
          </label>
          <Input
            id="release-version"
            value={draft.version}
            maxLength={40}
            disabled={pending}
            placeholder="1.4.0"
            onChange={(event) => setDraft((current) => ({ ...current, version: event.target.value }))}
          />
        </div>
        <div className="min-w-0 space-y-1.5">
          <label htmlFor="release-importance" className="block text-sm font-medium text-[var(--text)]">
            ระดับประกาศ
          </label>
          <Select
            id="release-importance"
            value={draft.importance}
            disabled={pending}
            onChange={(event) => setDraft((current) => ({
              ...current, importance: event.target.value as ReleaseImportance,
            }))}
          >
            {releaseImportances.map((value) => (
              <option key={value} value={value}>{RELEASE_IMPORTANCE_LABEL[value]}</option>
            ))}
          </Select>
        </div>
      </div>

      <div className="min-w-0 space-y-1.5">
        <label htmlFor="release-title" className="block text-sm font-medium text-[var(--text)]">
          หัวข้อ
        </label>
        <Input
          id="release-title"
          value={draft.title}
          maxLength={120}
          disabled={pending}
          onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
        />
      </div>

      <div className="min-w-0 space-y-1.5">
        <label htmlFor="release-content" className="block text-sm font-medium text-[var(--text)]">
          รายละเอียดอัปเดต
        </label>
        <textarea
          id="release-content"
          value={draft.content}
          maxLength={4000}
          rows={7}
          disabled={pending}
          onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))}
          className="w-full min-w-0 rounded-xl border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-60"
        />
        <p className="text-xs text-[var(--text-muted)]">
          ข้อความล้วนเท่านั้น ขึ้นบรรทัดใหม่ด้วย • หรือ - เพื่อให้แสดงเป็นหัวข้อย่อย
          (ไม่รองรับ HTML และเครื่องหมาย &lt; &gt;)
        </p>
      </div>

      <div className="flex min-w-0 flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={pending} onClick={() => submit(null)}>
          บันทึกร่าง
        </Button>
        <Button type="button" isLoading={pending} onClick={() => submit(true)}>
          เผยแพร่
        </Button>
        {draft.id && draft.isPublished && (
          <Button type="button" variant="ghost" disabled={pending} onClick={() => submit(false)}>
            ย้ายกลับเป็นร่าง
          </Button>
        )}
        <Button type="button" variant="ghost" disabled={pending} onClick={() => { setOpen(false); setResult(null); }}>
          ปิด
        </Button>
      </div>

      {result && (
        <p role="alert" className={`text-sm ${result.ok ? 'text-[var(--positive)]' : 'text-[var(--negative)]'}`}>
          {result.message}
        </p>
      )}
    </div>
  );
}
