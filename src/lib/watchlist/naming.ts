/**
 * What a watchlist may be called.
 *
 * The database is the authority — `char_length(trim(name)) between 1 and 80` on
 * the table, and `watchlists_owner_normalized_name_key` for uniqueness — and
 * this file exists so a reader finds out BEFORE a round trip, not instead of
 * one. A name that gets past this and is rejected by the database is a bug in
 * this file; a name that gets past this and is ACCEPTED is the normal case.
 *
 * Uniqueness is deliberately NOT checked here. It cannot be: another tab, or
 * the same reader on a phone, can take the name between the check and the
 * insert, so a client-side "that name is free" is a claim with a race inside
 * it. The unique index answers it atomically and the action turns 23505 into a
 * sentence — which is also why `create_watchlist` refuses to swallow the
 * conflict.
 */

/** Matches the table's own `char_length(trim(name)) between 1 and 80`. */
export const WATCHLIST_NAME_MAX = 80;

export type WatchlistNameProblem = 'empty' | 'too-long';

export interface WatchlistNameCheck {
  ok: boolean;
  /** The name as it would be stored: trimmed, never re-cased. */
  normalized: string;
  problem: WatchlistNameProblem | null;
  /** What to tell the reader, or null when there is nothing to tell them. */
  message: string | null;
}

/**
 * Trimmed the way `btrim` trims, so the client and the database agree on what
 * "empty" means.
 *
 * A name of spaces is empty — it is stored trimmed, so accepting it would
 * create a list whose tab has no label. Case is left exactly as typed: the
 * uniqueness rule folds case to COMPARE names, which is not the same as
 * changing what the reader wrote.
 */
export function normalizeWatchlistName(raw: string): string {
  return raw.trim();
}

export function checkWatchlistName(raw: string): WatchlistNameCheck {
  const normalized = normalizeWatchlistName(raw);
  if (normalized.length === 0) {
    return {
      ok: false,
      normalized,
      problem: 'empty',
      message: 'ตั้งชื่อรายการก่อนบันทึก',
    };
  }
  if (normalized.length > WATCHLIST_NAME_MAX) {
    return {
      ok: false,
      normalized,
      problem: 'too-long',
      message: `ชื่อยาวได้ไม่เกิน ${WATCHLIST_NAME_MAX} ตัวอักษร`,
    };
  }
  return { ok: true, normalized, problem: null, message: null };
}

/**
 * Whether two names are the same list to a reader.
 *
 * The client-side mirror of `lower(btrim(name))`, used to warn in the rename
 * field before submitting — never to decide the outcome, which is the index's
 * job. `toLowerCase` rather than `toLocaleLowerCase`: the index folds with
 * Postgres's `lower()` under the database's collation, and matching that
 * exactly matters more here than being right about any one locale's casing.
 */
export function sameWatchlistName(left: string, right: string): boolean {
  return normalizeWatchlistName(left).toLowerCase() === normalizeWatchlistName(right).toLowerCase();
}
