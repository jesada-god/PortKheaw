import { describe, expect, it } from 'vitest';
import {
  WATCHLIST_NAME_MAX,
  checkWatchlistName,
  normalizeWatchlistName,
  sameWatchlistName,
} from './naming';

describe('watchlist names', () => {
  it('refuses an empty name', () => {
    const result = checkWatchlistName('');
    expect(result.ok).toBe(false);
    expect(result.problem).toBe('empty');
    expect(result.message).toBeTruthy();
  });

  it('refuses a name that is only whitespace, because it is stored trimmed', () => {
    const result = checkWatchlistName('    ');
    expect(result.ok).toBe(false);
    expect(result.problem).toBe('empty');
  });

  it('refuses a name past the length the table accepts', () => {
    const result = checkWatchlistName('ก'.repeat(WATCHLIST_NAME_MAX + 1));
    expect(result.ok).toBe(false);
    expect(result.problem).toBe('too-long');
  });

  it('accepts a name exactly at the limit', () => {
    expect(checkWatchlistName('ก'.repeat(WATCHLIST_NAME_MAX)).ok).toBe(true);
  });

  it('measures the length after trimming, as the table check does', () => {
    const padded = `  ${'ก'.repeat(WATCHLIST_NAME_MAX)}  `;
    const result = checkWatchlistName(padded);
    expect(result.ok).toBe(true);
    expect(result.normalized).toHaveLength(WATCHLIST_NAME_MAX);
  });

  it('stores the name trimmed but never re-cased', () => {
    expect(normalizeWatchlistName('  Growth Ideas  ')).toBe('Growth Ideas');
    expect(checkWatchlistName('  Growth Ideas  ').normalized).toBe('Growth Ideas');
  });

  it('treats names differing only by case or padding as the same list', () => {
    expect(sameWatchlistName('ระยะยาว', 'ระยะยาว ')).toBe(true);
    expect(sameWatchlistName('growth', 'GROWTH')).toBe(true);
    expect(sameWatchlistName('growth', 'growth ideas')).toBe(false);
  });

  /*
   * The client check is a courtesy, not the decision. Uniqueness has a race in
   * it — another tab can take the name between the check and the insert — so it
   * is the unique index that answers, and this file must not pretend otherwise
   * by growing a "name is free" call.
   */
  it('does not claim to answer uniqueness', () => {
    expect(checkWatchlistName('anything').ok).toBe(true);
  });
});
