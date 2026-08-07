/**
 * Release note content, as text and only as text.
 *
 * The announcement popup is shown to every signed-in reader, which makes the
 * body of a release note the single widest-reaching string an operator account
 * can write. So it is never markup: the database refuses angle brackets, this
 * module turns the stored text into a list of lines, and the components render
 * those lines as React children — escaped by construction, with no
 * `dangerouslySetInnerHTML` anywhere on the path.
 *
 * A bullet is a line that starts with one of the usual bullet marks. That is a
 * *display* convention, not a parser: a line that does not start with one is
 * still rendered, as a paragraph. Nothing an operator types can fail to appear.
 */

export const releaseImportances = ['normal', 'important'] as const;
export type ReleaseImportance = typeof releaseImportances[number];

export const RELEASE_IMPORTANCE_LABEL: Readonly<Record<ReleaseImportance, string>> = {
  normal: 'ทั่วไป',
  important: 'สำคัญ',
};

export const RELEASE_TITLE_MAX = 120;
export const RELEASE_CONTENT_MAX = 4000;
export const RELEASE_VERSION_MAX = 40;

/** Anything not on the allowlist is `normal`. Fail to the quieter presentation. */
export function normalizeReleaseImportance(value: unknown): ReleaseImportance {
  return value === 'important' ? 'important' : 'normal';
}

export interface ReleaseNoteLine {
  kind: 'bullet' | 'paragraph';
  text: string;
}

const BULLET_PREFIX = /^\s*(?:[-*•‣·]|\d+[.)])\s+/;

/**
 * Split a stored body into renderable lines.
 *
 * Blank lines are dropped rather than preserved: they are how a person spaces a
 * textarea, not content, and an empty `<li>` in a popup is just a gap nobody
 * asked for.
 */
export function parseReleaseBody(content: string): ReleaseNoteLine[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => (
      BULLET_PREFIX.test(line)
        ? { kind: 'bullet' as const, text: line.replace(BULLET_PREFIX, '').trim() }
        : { kind: 'paragraph' as const, text: line }
    ))
    .filter((line) => line.text.length > 0);
}

export interface ReleaseNoteDraft {
  version: string;
  title: string;
  content: string;
  importance: ReleaseImportance;
}

export type ReleaseDraftProblem = 'title' | 'content' | 'version' | 'markup';

/**
 * The same refusals the database makes, so the console can explain a problem
 * before a round trip rather than surfacing a constraint violation. The database
 * checks all of them again — this is the convenience, never the boundary.
 */
export function validateReleaseDraft(draft: ReleaseNoteDraft): ReleaseDraftProblem | null {
  const title = draft.title.trim();
  const content = draft.content.trim();
  const version = draft.version.trim();

  if (!title || title.length > RELEASE_TITLE_MAX) return 'title';
  if (!content || content.length > RELEASE_CONTENT_MAX) return 'content';
  if (version.length > RELEASE_VERSION_MAX) return 'version';
  if (/[<>]/.test(title) || /[<>]/.test(content) || /[<>]/.test(version)) return 'markup';
  return null;
}

export const RELEASE_PROBLEM_MESSAGE: Readonly<Record<ReleaseDraftProblem, string>> = {
  title: 'กรุณากรอกหัวข้อประกาศ (ไม่เกิน 120 ตัวอักษร)',
  content: 'กรุณากรอกรายละเอียดอัปเดต (ไม่เกิน 4,000 ตัวอักษร)',
  version: 'เวอร์ชันต้องไม่เกิน 40 ตัวอักษร',
  markup: 'ประกาศรองรับข้อความล้วนเท่านั้น กรุณานำเครื่องหมาย < และ > ออก',
};

export const RELEASE_OUTCOME_MESSAGE: Readonly<Record<string, string>> = {
  created: 'บันทึกร่างประกาศแล้ว',
  created_published: 'เผยแพร่ประกาศแล้ว',
  updated: 'บันทึกการแก้ไขแล้ว',
  published: 'เผยแพร่ประกาศแล้ว',
  unpublished: 'ย้ายกลับเป็นร่างแล้ว',
  not_found: 'ไม่พบประกาศที่ต้องการแก้ไข',
  invalid_title: RELEASE_PROBLEM_MESSAGE.title,
  invalid_content: RELEASE_PROBLEM_MESSAGE.content,
};
