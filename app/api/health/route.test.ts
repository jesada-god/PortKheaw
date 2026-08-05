import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The readiness endpoint is public and unauthenticated, so what it *refuses* to
 * say matters as much as what it reports.
 */

const createClient = vi.fn();
const billingConfigResult = vi.fn();

vi.mock('@/src/lib/supabase/server', () => ({ createClient: () => createClient() }));
vi.mock('@/src/lib/billing/billing-server', () => ({
  billingConfigResult: () => billingConfigResult(),
}));

function supabaseAnswering(row: unknown, error: unknown = null) {
  return { rpc: vi.fn().mockResolvedValue({ data: row ? [row] : [], error }) };
}

beforeEach(() => {
  createClient.mockResolvedValue(supabaseAnswering({ database_ready: true, scheduler_status: 'ok' }));
  billingConfigResult.mockReturnValue({
    enabled: true,
    availablePlanKeys: ['pro_monthly'],
    config: { providerMode: 'live' },
  });
});

afterEach(() => vi.clearAllMocks());

async function get() {
  const { GET } = await import('./route');
  const response = await GET();
  return { response, body: await response.json() };
}

describe('a healthy deployment', () => {
  it('answers 200 and ok on every check', async () => {
    const { response, body } = await get();
    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: 'ok',
      checks: { app: 'ok', database: 'ok', billing: 'ok', scheduler: 'ok' },
    });
  });

  it('is never cached, by us or by an intermediary', async () => {
    const { response } = await get();
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('CDN-Cache-Control')).toContain('no-store');
  });
});

describe('a degraded deployment still serves readers', () => {
  it('reports a stale scheduler without declaring the site down', async () => {
    // An uptime provider paging at 03:00 because a background job lagged, while
    // every reader is served perfectly, is a worse outcome than the lag.
    createClient.mockResolvedValue(
      supabaseAnswering({ database_ready: true, scheduler_status: 'stale' }),
    );
    const { response, body } = await get();
    expect(response.status).toBe(200);
    expect(body.status).toBe('degraded');
    expect(body.checks.scheduler).toBe('unavailable');
  });

  it('reports incomplete billing configuration the same way', async () => {
    billingConfigResult.mockReturnValue({ enabled: false, reason: 'switched-off', missing: ['STRIPE_SECRET_KEY'] });
    const { response, body } = await get();
    expect(response.status).toBe(200);
    expect(body.status).toBe('degraded');
    expect(body.checks.billing).toBe('unavailable');
  });

  it('calls billing degraded when it is configured but sells nothing', async () => {
    billingConfigResult.mockReturnValue({
      enabled: true, availablePlanKeys: [], config: { providerMode: 'live' },
    });
    const { body } = await get();
    expect(body.checks.billing).toBe('degraded');
  });
});

describe('a schema one migration behind is not an outage', () => {
  it.each(['PGRST202', 'PGRST100', '42883'])(
    'reports degraded, not down, when the readiness routine is missing (%s)',
    async (code) => {
      // A deploy that lands ahead of its migration must not page somebody for a
      // product that is serving every reader perfectly.
      createClient.mockResolvedValue(
        supabaseAnswering(null, { code, message: 'Could not find the function' }),
      );
      const { response, body } = await get();
      expect(response.status).toBe(200);
      expect(body.status).toBe('degraded');
      expect(body.checks.database).toBe('degraded');
      expect(body.checks.scheduler).toBe('unavailable');
    },
  );
});

describe('an unreachable database is the one thing that fails the check', () => {
  it('answers 503 when the database does not answer at all', async () => {
    createClient.mockResolvedValue(supabaseAnswering(null, { message: 'connection refused' }));
    const { response, body } = await get();
    expect(response.status).toBe(503);
    expect(body.status).toBe('unavailable');
    expect(body.checks.database).toBe('unavailable');
  });

  it('answers 503 when Supabase is not configured at all', async () => {
    createClient.mockResolvedValue(null);
    const { response, body } = await get();
    expect(response.status).toBe(503);
    expect(body.checks.database).toBe('unavailable');
  });

  it('answers 503 rather than throwing when the client itself blows up', async () => {
    createClient.mockRejectedValue(new Error('boom'));
    const { response } = await get();
    expect(response.status).toBe(503);
  });
});

describe('what it will not say', () => {
  it('never names a variable, a provider, an error or a timestamp', async () => {
    billingConfigResult.mockReturnValue({
      enabled: false, reason: 'incomplete-config', missing: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
    });
    createClient.mockResolvedValue(supabaseAnswering(null, { message: 'password authentication failed for user "postgres"' }));

    const { body } = await get();
    const serialized = JSON.stringify(body);

    for (const leak of ['STRIPE', 'SUPABASE', 'stripe', 'supabase', 'postgres', 'password', 'sk_', 'Error', 'connection']) {
      expect(serialized).not.toContain(leak);
    }
    // No clock either: a readiness endpoint that reports timestamps hands an
    // unauthenticated caller a view of the scheduler's cadence.
    expect(serialized).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('answers with a fixed shape and nothing else', async () => {
    const { body } = await get();
    expect(Object.keys(body).sort()).toEqual(['checks', 'status']);
    expect(Object.keys(body.checks).sort()).toEqual(['app', 'billing', 'database', 'scheduler']);
    for (const value of Object.values(body.checks)) {
      expect(['ok', 'degraded', 'unavailable']).toContain(value);
    }
  });
});
