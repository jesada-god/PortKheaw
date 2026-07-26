import { normalizedTradeSchema, type NormalizedTrade } from './events';
import { classifyUsEquityTimestamp } from './session';

interface FinnhubTradeRow {
  s?: unknown;
  p?: unknown;
  v?: unknown;
  t?: unknown;
  c?: unknown;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Normalize one Finnhub WebSocket envelope. Invalid rows are rejected
 * independently so a malformed item cannot discard valid siblings in `data`.
 */
export function normalizeFinnhubMessage(message: unknown): NormalizedTrade[] {
  if (typeof message !== 'object' || message === null) return [];
  const envelope = message as { type?: unknown; data?: unknown };
  if (envelope.type !== 'trade' || !Array.isArray(envelope.data)) return [];
  const trades: NormalizedTrade[] = [];
  for (const raw of envelope.data) {
    if (typeof raw !== 'object' || raw === null) continue;
    const row = raw as FinnhubTradeRow;
    const symbol = typeof row.s === 'string' ? row.s.trim().toUpperCase() : '';
    const price = finite(row.p);
    const size = finite(row.v);
    const timestampMs = finite(row.t);
    if (!symbol || price === null || size === null || timestampMs === null) continue;
    const conditions = Array.isArray(row.c)
      ? row.c.filter((condition): condition is string => typeof condition === 'string')
      : undefined;
    const tradeId = `${symbol}:${timestampMs}:${price}:${size}:${conditions?.join(',') ?? ''}`;
    const parsed = normalizedTradeSchema.safeParse({
      kind: 'trade',
      symbol,
      price,
      size,
      timestampMs,
      provider: 'finnhub',
      tradeId,
      session: classifyUsEquityTimestamp(timestampMs),
      ...(conditions && conditions.length > 0 ? { conditions } : {}),
    });
    if (parsed.success) trades.push(parsed.data);
  }
  return trades;
}

export function buildFinnhubSubscriptionFrame(action: 'subscribe' | 'unsubscribe', symbol: string): string {
  return JSON.stringify({ type: action, symbol: symbol.trim().toUpperCase() });
}
