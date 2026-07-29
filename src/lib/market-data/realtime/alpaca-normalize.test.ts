import { describe, expect, it } from 'vitest';
import {
  classifyAlpacaControl,
  isHaltCode,
  normalizeAlpacaMessage,
  rfc3339ToMillis,
} from './alpaca-normalize';

describe('rfc3339ToMillis', () => {
  it('parses millisecond precision', () => {
    expect(rfc3339ToMillis('2024-01-02T15:04:05.123Z')).toBe(Date.parse('2024-01-02T15:04:05.123Z'));
  });

  it('truncates nanosecond precision to milliseconds', () => {
    expect(rfc3339ToMillis('2024-01-02T15:04:05.123456789Z')).toBe(Date.parse('2024-01-02T15:04:05.123Z'));
  });

  it('returns null for garbage', () => {
    expect(rfc3339ToMillis('not-a-date')).toBeNull();
  });
});

describe('normalizeAlpacaMessage', () => {
  it('maps a trade (t) and upper-cases the symbol', () => {
    const event = normalizeAlpacaMessage({ T: 't', S: 'aapl', p: 190.25, s: 100, t: '2024-01-02T15:04:05.5Z', z: 'C', c: ['@'] });
    expect(event).toMatchObject({ kind: 'trade', symbol: 'AAPL', price: 190.25, size: 100, tape: 'C', conditions: ['@'] });
  });

  it('maps a quote (q) with separate bid/ask', () => {
    const event = normalizeAlpacaMessage({ T: 'q', S: 'AAPL', bp: 190.1, bs: 2, ap: 190.2, as: 3, t: '2024-01-02T15:04:05Z' });
    expect(event).toMatchObject({ kind: 'quote', bidPrice: 190.1, askPrice: 190.2, bidSize: 2, askSize: 3 });
  });

  it('maps an official bar (b) as updated:false and an updated bar (u) as updated:true', () => {
    const base = { S: 'AAPL', o: 1, h: 2, l: 0.5, c: 1.5, v: 1000, t: '2024-01-02T15:04:00Z' };
    expect(normalizeAlpacaMessage({ T: 'b', ...base })).toMatchObject({ kind: 'bar', updated: false, volume: 1000 });
    expect(normalizeAlpacaMessage({ T: 'u', ...base })).toMatchObject({ kind: 'bar', updated: true });
  });

  it('maps a trading status (s) and derives halted from the code', () => {
    const halted = normalizeAlpacaMessage({ T: 's', S: 'AAPL', sc: 'H', sm: 'Trading Halt', rc: 'T12', rm: 'News Pending', t: '2024-01-02T15:04:05Z' });
    expect(halted).toMatchObject({ kind: 'status', halted: true, statusCode: 'H', reasonCode: 'T12' });
    const resumed = normalizeAlpacaMessage({ T: 's', S: 'AAPL', sc: 'T', sm: 'Trading Resumption', t: '2024-01-02T15:04:05Z' });
    expect(resumed).toMatchObject({ kind: 'status', halted: false });
  });

  it('rejects a non-positive trade price', () => {
    expect(normalizeAlpacaMessage({ T: 't', S: 'AAPL', p: 0, s: 100, t: '2024-01-02T15:04:05Z' })).toBeNull();
  });

  it('returns null for missing fields or non-market frames', () => {
    expect(normalizeAlpacaMessage({ T: 't', S: 'AAPL', s: 100, t: '2024-01-02T15:04:05Z' })).toBeNull();
    expect(normalizeAlpacaMessage({ T: 'success', msg: 'connected' })).toBeNull();
    expect(normalizeAlpacaMessage(null)).toBeNull();
    expect(normalizeAlpacaMessage('nope')).toBeNull();
  });
});

describe('classifyAlpacaControl', () => {
  it('classifies success and error frames', () => {
    expect(classifyAlpacaControl({ T: 'success', msg: 'authenticated' })).toEqual({ kind: 'success', message: 'authenticated' });
    expect(classifyAlpacaControl({ T: 'error', code: 402, msg: 'auth failed' })).toEqual({ kind: 'error', code: 402, message: 'auth failed' });
    expect(classifyAlpacaControl({ T: 't', S: 'AAPL' })).toBeNull();
  });

  it('surfaces the subscription ack: the union of symbols and per-channel lists', () => {
    const control = classifyAlpacaControl({
      T: 'subscription',
      trades: ['AAPL'],
      quotes: ['AAPL', 'msft'],
      bars: [],
      statuses: ['AAPL'],
    });
    expect(control).toEqual({
      kind: 'subscription',
      symbols: ['AAPL', 'MSFT'],
      channels: { trades: ['AAPL'], quotes: ['AAPL', 'msft'], statuses: ['AAPL'] },
    });
  });

  it('reports an empty subscription (feed subscribed to nothing) honestly', () => {
    expect(classifyAlpacaControl({ T: 'subscription', trades: [], quotes: [] })).toEqual({
      kind: 'subscription',
      symbols: [],
      channels: {},
    });
  });
});

/**
 * Session tagging on priced events — the origin of the Stock Price Header defect.
 *
 * Alpaca states no session on the wire. With the field absent, the browser source
 * fell back to the CHART SELECTION's session (`regular`, a request parameter), so
 * every after-hours print was labelled a regular-session price and could overwrite
 * the official regular close in the main price row: NVTS showed 10.42 against a real
 * close of 9.735. Each priced event now carries the session its own exchange
 * timestamp falls in, in America/New_York.
 */
describe('normalizeAlpacaMessage session tagging', () => {
  it.each([
    // 2026-07-29 is a Wednesday. Times below are the ET equivalents.
    ['2026-07-29T12:25:00Z', 'pre-market'], //  08:25 ET
    ['2026-07-29T15:00:00Z', 'regular'], //     11:00 ET
    ['2026-07-29T20:41:12Z', 'after-hours'], // 16:41 ET
    ['2026-07-30T01:00:00Z', 'closed'], //      21:00 ET
    ['2026-07-25T15:00:00Z', 'closed'], //      Saturday
  ] as const)('tags a trade at %s as %s', (timestamp, session) => {
    const event = normalizeAlpacaMessage({ T: 't', S: 'NVTS', p: 10.42, s: 100, t: timestamp });
    expect(event?.kind).toBe('trade');
    expect(event && 'session' in event ? event.session : null).toBe(session);
  });

  it('tags an official 1m bar by its bucket start', () => {
    const event = normalizeAlpacaMessage({
      T: 'b', S: 'NVTS', o: 10.4, h: 10.5, l: 10.3, c: 10.42, v: 1_000,
      t: '2026-07-29T20:41:00Z',
    });
    expect(event?.kind).toBe('bar');
    expect(event && 'session' in event ? event.session : null).toBe('after-hours');
  });

  it('never leaves a priced event without a session', () => {
    for (const timestamp of ['2026-07-29T12:25:00Z', '2026-07-29T15:00:00Z', '2026-07-29T20:41:12Z']) {
      const trade = normalizeAlpacaMessage({ T: 't', S: 'NVTS', p: 10.42, s: 100, t: timestamp });
      expect(trade && 'session' in trade ? trade.session : undefined).toBeDefined();
    }
  });
});

describe('isHaltCode', () => {
  it('flags halt/pause codes and not resumption', () => {
    expect(isHaltCode('H')).toBe(true);
    expect(isHaltCode('luds')).toBe(true);
    expect(isHaltCode('MWC1')).toBe(true);
    expect(isHaltCode('T')).toBe(false);
    expect(isHaltCode('Q')).toBe(false);
  });
});
