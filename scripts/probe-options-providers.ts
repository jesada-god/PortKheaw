/**
 * Options provider capability probe.
 *
 * Answers one question for every provider Nexora is already configured with:
 * does the CURRENT key/plan actually return usable options data? It exists
 * because the production Options failure was misdiagnosed for several cycles as
 * a rate limit when it was in fact a permanent entitlement refusal — the kind of
 * fact that must be measured against the live upstream, never assumed.
 *
 * It is intentionally self-contained (imports nothing from the app) so it runs
 * under `node --experimental-strip-types` without the `@/` alias or the
 * `server-only` guard, mirroring probe-polygon-ws.ts / probe-options-chain.ts.
 *
 * Safety: never prints an API key, an authenticated URL, raw headers, or a raw
 * provider payload. Every emitted string passes through sanitize(), which
 * redacts any configured secret that appears in it.
 *
 * Run: npm run probe:options-providers
 */

export {};

const SYMBOL = process.argv[2]?.toUpperCase() ?? 'AAPL';
const TIMEOUT_MS = 15_000;

const secrets = [
  process.env.ALPHA_VANTAGE_API_KEY, process.env.POLYGON_API_KEY,
  process.env.FINNHUB_API_KEY, process.env.FMP_API_KEY,
  process.env.ALPACA_API_KEY_ID, process.env.ALPACA_API_SECRET_KEY,
].map((value) => value?.trim()).filter((value): value is string => Boolean(value));

/** Redact every configured secret and cap length; used on all emitted text. */
function sanitize(value: unknown): string {
  let text = typeof value === 'string' ? value : '';
  for (const secret of secrets) if (text.includes(secret)) text = text.split(secret).join('[redacted]');
  return text.slice(0, 180);
}

type Status =
  | 'entitled'
  | 'provider-entitlement'
  | 'rate-limit-temporary'
  | 'invalid-key'
  | 'no-data'
  | 'provider-unavailable'
  | 'not-configured';

interface Capability {
  provider: string;
  expirations: number | null;
  chain: boolean;
  openInterest: boolean;
  impliedVolatility: boolean;
  greeks: boolean;
  freshness: 'realtime' | 'delayed' | 'unknown';
  status: Status;
  http: number | null;
  detail: string;
}

const EMPTY = {
  expirations: null, chain: false, openInterest: false,
  impliedVolatility: false, greeks: false, freshness: 'unknown' as const,
};

interface Fetched { http: number | null; payload: unknown; text: string; failed: boolean }

async function request(url: string, headers: Record<string, string> = {}): Promise<Fetched> {
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json', ...headers },
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    let payload: unknown = null;
    try { payload = JSON.parse(text); } catch { /* non-JSON upstream */ }
    return { http: response.status, payload, text, failed: false };
  } catch {
    return { http: null, payload: null, text: '', failed: true };
  }
}

function messageOf(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  for (const key of ['Note', 'Information', 'Error Message', 'message', 'error', 'detail']) {
    if (typeof record[key] === 'string') return record[key];
  }
  return '';
}

/**
 * Classify one upstream answer. Entitlement is tested before quota on purpose:
 * providers advertise paid tiers inside a refusal ("subscribe to the 600
 * requests per minute plan"), and reading that as a quota is precisely what
 * turned a permanent block into an infinite retry loop in production.
 */
function classify(result: Fetched): Status {
  if (result.failed) return 'provider-unavailable';
  const message = messageOf(result.payload);
  if (/this is a premium endpoint|sample data schema below is artificial|(are|is) not entitled|not authorized|have access to this resource|only available for legacy users|agreement is not signed|upgrade (your|to a|the) .{0,24}plan/i.test(message)) {
    return 'provider-entitlement';
  }
  if (result.http === 402 || result.http === 403) return 'provider-entitlement';
  if (result.http === 429 || /call frequency|rate limit|call volume|requests per day|calls per/i.test(message)) return 'rate-limit-temporary';
  if (result.http === 401 || /invalid api key|apikey is invalid/i.test(message)) return 'invalid-key';
  if (result.http !== null && result.http >= 500) return 'provider-unavailable';
  return 'entitled';
}

const finite = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : null;
};

async function probeAlphaVantage(): Promise<Capability> {
  const key = process.env.ALPHA_VANTAGE_API_KEY?.trim();
  if (!key) return { provider: 'alpha-vantage', ...EMPTY, status: 'not-configured', http: null, detail: 'ALPHA_VANTAGE_API_KEY is not set' };
  const result = await request(`https://www.alphavantage.co/query?function=REALTIME_OPTIONS&symbol=${SYMBOL}&require_greeks=true&apikey=${key}`);
  const status = classify(result);
  if (status !== 'entitled') {
    return { provider: 'alpha-vantage', ...EMPTY, status, http: result.http, detail: sanitize(messageOf(result.payload)) };
  }
  const rows = Array.isArray((result.payload as Record<string, unknown>)?.data)
    ? ((result.payload as Record<string, unknown>).data as Record<string, unknown>[]) : [];
  return {
    provider: 'alpha-vantage',
    expirations: new Set(rows.map((row) => row.expiration)).size,
    chain: rows.some((row) => row.type === 'call') && rows.some((row) => row.type === 'put'),
    openInterest: rows.some((row) => finite(row.open_interest) !== null),
    impliedVolatility: rows.some((row) => finite(row.implied_volatility) !== null),
    greeks: rows.some((row) => finite(row.delta) !== null && finite(row.gamma) !== null),
    freshness: 'delayed',
    status,
    http: result.http,
    detail: `${rows.length} contracts returned`,
  };
}

async function probePolygon(): Promise<Capability[]> {
  const key = process.env.POLYGON_API_KEY?.trim();
  if (!key) return [{ provider: 'polygon', ...EMPTY, status: 'not-configured', http: null, detail: 'POLYGON_API_KEY is not set' }];

  const snapshot = await request(`https://api.polygon.io/v3/snapshot/options/${SYMBOL}?limit=10&apiKey=${key}`);
  const snapshotStatus = classify(snapshot);
  const reference = await request(`https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${SYMBOL}&limit=1000&apiKey=${key}`);
  const referenceStatus = classify(reference);
  const referenceRows = Array.isArray((reference.payload as Record<string, unknown>)?.results)
    ? ((reference.payload as Record<string, unknown>).results as Record<string, unknown>[]) : [];

  return [
    {
      provider: 'polygon:options-snapshot',
      ...EMPTY,
      status: snapshotStatus,
      http: snapshot.http,
      detail: sanitize(messageOf(snapshot.payload)) || 'snapshot carries OI/IV/Greeks when entitled',
    },
    {
      provider: 'polygon:reference-contracts',
      expirations: referenceStatus === 'entitled' ? new Set(referenceRows.map((row) => row.expiration_date)).size : null,
      chain: referenceRows.some((row) => row.contract_type === 'call') && referenceRows.some((row) => row.contract_type === 'put'),
      // Reference data is a contract catalogue: strikes and expirations only.
      openInterest: false, impliedVolatility: false, greeks: false,
      freshness: 'delayed',
      status: referenceStatus,
      http: reference.http,
      detail: sanitize(messageOf(reference.payload)) || `${referenceRows.length} reference contracts (no OI/IV/Greeks)`,
    },
  ];
}

async function probeFinnhub(): Promise<Capability> {
  const key = process.env.FINNHUB_API_KEY?.trim();
  if (!key) return { provider: 'finnhub', ...EMPTY, status: 'not-configured', http: null, detail: 'FINNHUB_API_KEY is not set' };
  const result = await request(`https://finnhub.io/api/v1/stock/option-chain?symbol=${SYMBOL}&token=${key}`);
  const status = classify(result);
  const chain = Array.isArray((result.payload as Record<string, unknown>)?.data)
    ? ((result.payload as Record<string, unknown>).data as Record<string, unknown>[]) : [];
  return {
    provider: 'finnhub',
    expirations: status === 'entitled' ? chain.length : null,
    chain: status === 'entitled' && chain.length > 0,
    openInterest: false, impliedVolatility: false, greeks: false,
    freshness: status === 'entitled' ? 'delayed' : 'unknown',
    status,
    http: result.http,
    detail: sanitize(messageOf(result.payload)) || `${chain.length} expiration groups`,
  };
}

async function probeFmp(): Promise<Capability> {
  const key = process.env.FMP_API_KEY?.trim();
  if (!key) return { provider: 'financial-modeling-prep', ...EMPTY, status: 'not-configured', http: null, detail: 'FMP_API_KEY is not set' };
  const result = await request(`https://financialmodelingprep.com/stable/options-chain?symbol=${SYMBOL}&apikey=${key}`);
  const status = result.http === 404 ? 'no-data' : classify(result);
  return {
    provider: 'financial-modeling-prep',
    ...EMPTY,
    status,
    http: result.http,
    detail: sanitize(messageOf(result.payload)) || 'no documented options endpoint answered for this plan',
  };
}

async function probeAlpaca(): Promise<Capability> {
  const keyId = process.env.ALPACA_API_KEY_ID?.trim();
  const secretKey = process.env.ALPACA_API_SECRET_KEY?.trim();
  if (!keyId || !secretKey) {
    return { provider: 'alpaca', ...EMPTY, status: 'not-configured', http: null, detail: 'ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY are not set' };
  }
  const base = (process.env.ALPACA_TRADING_BASE_URL?.trim() || 'https://paper-api.alpaca.markets').replace(/\/+$/, '');
  const dataBase = (process.env.ALPACA_DATA_BASE_URL?.trim() || 'https://data.alpaca.markets').replace(/\/+$/, '');
  const marketFeed = process.env.ALPACA_OPTIONS_FEED?.trim() || 'indicative';
  const headers = { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secretKey };
  const today = new Date().toISOString().slice(0, 10);

  const result = await request(`${base}/v2/options/contracts?underlying_symbols=${SYMBOL}&type=call&expiration_date_gte=${today}&limit=10000`, headers);
  const status = classify(result);
  if (status !== 'entitled') {
    return { provider: 'alpaca', ...EMPTY, status, http: result.http, detail: sanitize(messageOf(result.payload)) };
  }
  const rows = Array.isArray((result.payload as Record<string, unknown>)?.option_contracts)
    ? ((result.payload as Record<string, unknown>).option_contracts as Record<string, unknown>[]) : [];
  const expirations = [...new Set(rows.map((row) => String(row.expiration_date)))].sort();
  if (!rows.length) {
    return { provider: 'alpaca', ...EMPTY, status: 'no-data', http: result.http, detail: 'catalogue returned no contracts' };
  }

  // Verify one real expiration-scoped chain, which is what the app actually renders.
  const nearest = expirations[0];
  const scoped = await request(`${base}/v2/options/contracts?underlying_symbols=${SYMBOL}&expiration_date=${nearest}&limit=10000`, headers);
  const scopedRows = Array.isArray((scoped.payload as Record<string, unknown>)?.option_contracts)
    ? ((scoped.payload as Record<string, unknown>).option_contracts as Record<string, unknown>[]) : [];
  const settled = [...new Set(scopedRows.map((row) => row.open_interest_date).filter(Boolean))].sort().at(-1);

  // The catalogue cannot answer price/IV/Greeks entitlement. Probe the exact
  // bulk endpoint the app uses, scoped to this expiration. This remains one
  // logical request and never loops contract-by-contract.
  const marketUrl = new URL(`${dataBase}/v1beta1/options/snapshots/${SYMBOL}`);
  marketUrl.searchParams.set('feed', marketFeed);
  marketUrl.searchParams.set('expiration_date', nearest);
  marketUrl.searchParams.set('limit', '1000');
  const market = await request(String(marketUrl), headers);
  const marketRows = market.payload && typeof market.payload === 'object'
    ? Object.values(((market.payload as Record<string, unknown>).snapshots as Record<string, unknown>) ?? {})
        .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object'))
    : [];
  const hasIv = marketRows.some((row) => finite(row.impliedVolatility) !== null);
  const hasGreeks = marketRows.some((row) => {
    const greeks = row.greeks;
    return Boolean(greeks && typeof greeks === 'object'
      && Object.values(greeks as Record<string, unknown>).some((item) => finite(item) !== null));
  });

  // Measure OPRA separately when production is using indicative. This records
  // the current entitlement fact without ever switching production to a feed
  // that the account may not be licensed to read.
  let opraDetail = '';
  if (marketFeed !== 'opra') {
    const opraUrl = new URL(marketUrl);
    opraUrl.searchParams.set('feed', 'opra');
    const opra = await request(String(opraUrl), headers);
    opraDetail = `; opra HTTP ${opra.http ?? 'network'} ${classify(opra)}`;
  }

  return {
    provider: 'alpaca',
    expirations: expirations.length,
    chain: scopedRows.some((row) => row.type === 'call') && scopedRows.some((row) => row.type === 'put'),
    openInterest: scopedRows.some((row) => finite(row.open_interest) !== null),
    impliedVolatility: hasIv,
    greeks: hasGreeks,
    freshness: marketFeed === 'opra' && market.http === 200 ? 'realtime' : 'delayed',
    status: 'entitled',
    http: market.http ?? result.http,
    detail: `${scopedRows.length} contracts on ${nearest}; open interest settled ${sanitize(String(settled ?? 'unknown'))}; ${marketFeed} market HTTP ${market.http ?? 'network'} with ${marketRows.length} snapshots${opraDetail}`,
  };
}

function render(rows: readonly Capability[]): string {
  const mark = (value: boolean) => (value ? 'yes' : 'no');
  const header = ['Provider', 'Expirations', 'Chain', 'OI', 'IV', 'Greeks', 'Freshness', 'HTTP', 'Status'];
  const body = rows.map((row) => [
    row.provider,
    row.expirations === null ? '-' : String(row.expirations),
    mark(row.chain), mark(row.openInterest), mark(row.impliedVolatility), mark(row.greeks),
    row.freshness, row.http === null ? '-' : String(row.http), row.status,
  ]);
  const widths = header.map((_, index) => Math.max(...[header, ...body].map((cells) => cells[index].length)));
  const line = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index])).join('  ');
  return [line(header), widths.map((width) => '-'.repeat(width)).join('  '), ...body.map(line)].join('\n');
}

async function main(): Promise<void> {
  const rows = [
    await probeAlpaca(),
    ...(await probePolygon()),
    await probeAlphaVantage(),
    await probeFinnhub(),
    await probeFmp(),
  ];

  process.stdout.write(`\nOptions provider capability — ${SYMBOL} — ${new Date().toISOString()}\n\n`);
  process.stdout.write(`${render(rows)}\n\n`);
  for (const row of rows) {
    if (row.detail) process.stdout.write(`  ${row.provider}: ${row.detail}\n`);
  }

  const usable = rows.filter((row) => row.status === 'entitled' && row.chain && row.openInterest);
  process.stdout.write('\n');
  if (usable.length) {
    process.stdout.write(`OPTIONS AVAILABLE via: ${usable.map((row) => row.provider).join(', ')}\n`);
    const gaps = usable.every((row) => !row.greeks) ? ' Greeks/IV are not supplied by any entitled provider and stay null.' : '';
    process.stdout.write(`Levels (Call Wall / Put Wall / Max Pain) derive from real open interest.${gaps}\n`);
    process.exitCode = 0;
  } else {
    process.stdout.write('OPTIONS BLOCKED BY PROVIDER ENTITLEMENT — no configured provider returns a real chain with open interest.\n');
    process.exitCode = 1;
  }
}

void main();
