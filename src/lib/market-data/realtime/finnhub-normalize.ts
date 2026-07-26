import { normalizedTradeSchema, type NormalizedTrade } from './events';
import { classifyUsEquityTimestamp } from './session';

interface FinnhubTradeRow {
  s?: unknown;
  p?: unknown;
  v?: unknown;
  t?: unknown;
  c?: unknown;
}

export interface FinnhubNormalizationResult {
  trades: NormalizedTrade[];
  rejected: Array<{ symbol: string; reason: 'invalid' }>;
  /** One entry per provider trade row, used to classify stale-generation rows. */
  observedSymbols: string[];
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Normalize one Finnhub WebSocket envelope. Invalid rows are rejected
 * independently so a malformed item cannot discard valid siblings in `data`.
 */
export function normalizeFinnhubMessageWithDiagnostics(message: unknown): FinnhubNormalizationResult {
  const result: FinnhubNormalizationResult = { trades: [], rejected: [], observedSymbols: [] };
  if (typeof message !== 'object' || message === null) return result;
  const envelope = message as { type?: unknown; data?: unknown };
  if (envelope.type !== 'trade' || !Array.isArray(envelope.data)) return result;
  for (const raw of envelope.data) {
    if (typeof raw !== 'object' || raw === null) {
      result.observedSymbols.push('(unknown)');
      result.rejected.push({ symbol: '(unknown)', reason: 'invalid' });
      continue;
    }
    const row = raw as FinnhubTradeRow;
    const symbol = typeof row.s === 'string' ? row.s.trim().toUpperCase() : '';
    const observedSymbol = symbol || '(unknown)';
    result.observedSymbols.push(observedSymbol);
    const price = finite(row.p);
    const size = finite(row.v);
    const timestampMs = finite(row.t);
    if (!symbol || price === null || size === null || timestampMs === null) {
      result.rejected.push({ symbol: observedSymbol, reason: 'invalid' });
      continue;
    }
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
    if (parsed.success) result.trades.push(parsed.data);
    else result.rejected.push({ symbol: observedSymbol, reason: 'invalid' });
  }
  return result;
}

export function normalizeFinnhubMessage(message: unknown): NormalizedTrade[] {
  return normalizeFinnhubMessageWithDiagnostics(message).trades;
}

export function buildFinnhubSubscriptionFrame(action: 'subscribe' | 'unsubscribe', symbol: string): string {
  return JSON.stringify({ type: action, symbol: symbol.trim().toUpperCase() });
}
