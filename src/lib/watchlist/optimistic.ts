export interface OptimisticWatchlistChange {
  symbol: string;
  wasWatched: boolean;
  next: Set<string>;
}

export function beginWatchlistChange(
  current: ReadonlySet<string>,
  symbol: string,
): OptimisticWatchlistChange {
  const wasWatched = current.has(symbol);
  const next = new Set(current);
  if (wasWatched) next.delete(symbol);
  else next.add(symbol);
  return { symbol, wasWatched, next };
}

export function rollbackWatchlistChange(
  current: ReadonlySet<string>,
  change: Pick<OptimisticWatchlistChange, 'symbol' | 'wasWatched'>,
): Set<string> {
  const next = new Set(current);
  if (change.wasWatched) next.add(change.symbol);
  else next.delete(change.symbol);
  return next;
}
