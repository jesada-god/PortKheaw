import { describe, expect, it } from 'vitest';
import { beginWatchlistChange, rollbackWatchlistChange } from './optimistic';

describe('optimistic Watchlist state', () => {
  it('updates immediately and restores the exact prior membership on failure', () => {
    const added = beginWatchlistChange(new Set(['AAPL']), 'NVDA');
    expect([...added.next].sort()).toEqual(['AAPL', 'NVDA']);
    expect([...rollbackWatchlistChange(added.next, added)]).toEqual(['AAPL']);

    const removed = beginWatchlistChange(new Set(['AAPL', 'NVDA']), 'NVDA');
    expect([...removed.next]).toEqual(['AAPL']);
    expect([...rollbackWatchlistChange(removed.next, removed)].sort()).toEqual(['AAPL', 'NVDA']);
  });
});
