import { describe, expect, it } from 'vitest';
import {
  OVERVIEW_PREVIEW_LIMIT,
  comparePreviewCandidates,
  overviewPreview,
  previewHasMore,
  resolveOverviewWatchlist,
} from './overview-preview';

const row = (symbol: string, createdAt: string, pinned = false) => ({ symbol, createdAt, pinned });

describe('Overview preview — the cut', () => {
  it('shows at most five, whatever the screen', () => {
    const rows = Array.from({ length: 12 }, (_, index) =>
      row(`SYM${index}`, `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`));
    expect(overviewPreview(rows)).toHaveLength(OVERVIEW_PREVIEW_LIMIT);
    expect(OVERVIEW_PREVIEW_LIMIT).toBe(5);
  });

  it('cuts the data rather than leaving the tail to be hidden', () => {
    const rows = Array.from({ length: 9 }, (_, index) =>
      row(`SYM${index}`, `2026-01-0${index + 1}T00:00:00.000Z`));
    const preview = overviewPreview(rows);
    // The symbols beyond the limit are absent, not merely unrendered.
    expect(preview.map((item) => item.symbol)).not.toContain('SYM5');
    expect(preview.map((item) => item.symbol)).not.toContain('SYM8');
  });

  it('shows everything when there is less than a full preview', () => {
    const rows = [row('AAPL', '2026-01-02T00:00:00.000Z'), row('MSFT', '2026-01-01T00:00:00.000Z')];
    expect(overviewPreview(rows)).toHaveLength(2);
  });

  it('reports whether the link has more to show', () => {
    expect(previewHasMore(5)).toBe(false);
    expect(previewHasMore(6)).toBe(true);
    expect(previewHasMore(0)).toBe(false);
  });

  it('does not mutate the caller array', () => {
    const rows = [row('ZZZ', '2026-01-09T00:00:00.000Z'), row('AAA', '2026-01-01T00:00:00.000Z')];
    const before = rows.map((item) => item.symbol);
    overviewPreview(rows);
    expect(rows.map((item) => item.symbol)).toEqual(before);
  });
});

describe('Overview preview — the stated order', () => {
  it('puts pinned rows first, whatever their age', () => {
    const rows = [
      row('OLD', '2020-01-01T00:00:00.000Z'),
      row('NEW', '2026-08-01T00:00:00.000Z', true),
    ];
    expect(overviewPreview(rows).map((item) => item.symbol)).toEqual(['NEW', 'OLD']);
  });

  it('orders within each group by age, oldest first', () => {
    const rows = [
      row('C', '2026-03-01T00:00:00.000Z'),
      row('A', '2026-01-01T00:00:00.000Z'),
      row('B', '2026-02-01T00:00:00.000Z'),
    ];
    expect(overviewPreview(rows).map((item) => item.symbol)).toEqual(['A', 'B', 'C']);
  });

  it('breaks a same-instant tie by symbol so the order is total', () => {
    const rows = [
      row('MSFT', '2026-01-01T00:00:00.000Z'),
      row('AAPL', '2026-01-01T00:00:00.000Z'),
    ];
    expect(overviewPreview(rows).map((item) => item.symbol)).toEqual(['AAPL', 'MSFT']);
    expect(comparePreviewCandidates(rows[0]!, rows[1]!)).toBeGreaterThan(0);
  });

  /*
   * The property the rule is actually for. The same list, handed in in any
   * order, produces the same five rows in the same order — which is what makes
   * the card explicable to the person looking at it.
   */
  it('is independent of the order it is given', () => {
    const rows = [
      row('E', '2026-05-01T00:00:00.000Z'),
      row('A', '2026-01-01T00:00:00.000Z', true),
      row('D', '2026-04-01T00:00:00.000Z'),
      row('B', '2026-02-01T00:00:00.000Z'),
      row('F', '2026-06-01T00:00:00.000Z', true),
      row('C', '2026-03-01T00:00:00.000Z'),
    ];
    const expected = overviewPreview(rows).map((item) => item.symbol);
    for (const shuffled of [[...rows].reverse(), [...rows].sort((l, r) => l.symbol.localeCompare(r.symbol))]) {
      expect(overviewPreview(shuffled).map((item) => item.symbol)).toEqual(expected);
    }
    expect(expected.slice(0, 2)).toEqual(['A', 'F']);
  });

  /*
   * Nothing about price or trend may reach the ordering. The preview carries no
   * such field, so this asserts the rule by construction: two rows identical in
   * the three fields it reads must compare equal, whatever else is on them.
   */
  it('reads nothing but pin, age and symbol', () => {
    const left = { ...row('AAPL', '2026-01-01T00:00:00.000Z'), changePercent: 12, trend: 'good' };
    const right = { ...row('AAPL', '2026-01-01T00:00:00.000Z'), changePercent: -40, trend: 'bad' };
    expect(comparePreviewCandidates(left, right)).toBe(0);
  });
});

describe('Overview preview — which list it draws from', () => {
  const lists = [
    { id: 'b', createdAt: '2026-02-01T00:00:00.000Z' },
    { id: 'a', createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'c', createdAt: '2026-03-01T00:00:00.000Z' },
  ];

  it('uses the chosen list when it is still there', () => {
    expect(resolveOverviewWatchlist(lists, 'c')?.id).toBe('c');
  });

  it('falls back to the oldest when nothing is chosen', () => {
    expect(resolveOverviewWatchlist(lists, null)?.id).toBe('a');
  });

  it('falls back rather than blanking when the chosen list is gone', () => {
    expect(resolveOverviewWatchlist(lists, 'deleted')?.id).toBe('a');
  });

  it('has no answer for an account with no lists', () => {
    expect(resolveOverviewWatchlist([], null)).toBeNull();
  });

  it('breaks a same-instant tie by id, matching the SQL order by created_at, id', () => {
    const tied = [
      { id: 'z', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'y', createdAt: '2026-01-01T00:00:00.000Z' },
    ];
    expect(resolveOverviewWatchlist(tied, null)?.id).toBe('y');
  });
});
