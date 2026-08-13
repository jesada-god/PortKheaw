import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Abuse control at the edge, as middleware actually runs it.
 *
 * The property under test is an **ordering** one, and it is the reason this gate
 * exists at all. Everything else in `middleware.ts` begins by asking Supabase who
 * is calling. Without this gate in front, a flood of anonymous requests at
 * `/auth/sign-in` is a flood of auth-server round trips — paid for by us, rate
 * limited by the platform, and shared with every legitimate reader on the same
 * project. A limiter that runs *after* the session lookup bounds the response
 * and not the cost, which is the wrong half.
 *
 * So the assertions here are: refused traffic never reaches `getUser()`, the
 * refusal carries a `Retry-After`, and nothing an ordinary reader does comes
 * close to the bounds.
 */

let getUserCalls = 0;
let currentUser: { id: string } | null = null;

vi.mock('@/src/config/env/client', () => ({
  isSupabaseConfigured: true,
  clientEnv: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
  },
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => {
        getUserCalls += 1;
        return { data: { user: currentUser } };
      },
      getSession: async () => ({ data: { session: null } }),
    },
    rpc: async (name: string) => {
      if (name === 'resolve_maintenance_state') {
        return { data: [{ maintenance_enabled: false, is_admin: false }], error: null };
      }
      if (name === 'get_my_account_access') return { data: [{ role: 'user' }], error: null };
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
  }),
}));

let middleware: typeof import('./middleware').middleware;
let resetEdgeAbuseLimiter: typeof import('./src/lib/security/edge-abuse').resetEdgeAbuseLimiter;
let resetRuntimePostureCache: typeof import('./src/lib/security/posture-edge').resetRuntimePostureCache;

beforeEach(async () => {
  vi.resetModules();
  getUserCalls = 0;
  currentUser = null;
  ({ middleware } = await import('./middleware'));
  ({ resetEdgeAbuseLimiter } = await import('./src/lib/security/edge-abuse'));
  ({ resetRuntimePostureCache } = await import('./src/lib/security/posture-edge'));
  resetEdgeAbuseLimiter();
  resetRuntimePostureCache();
});

function hit(path: string, options: { address?: string; method?: string; accept?: string } = {}) {
  const headers = new Headers();
  headers.set('x-forwarded-for', options.address ?? '203.0.113.9');
  if (options.accept) headers.set('accept', options.accept);
  return middleware(new NextRequest(`https://portkheaw.app${path}`, {
    method: options.method ?? 'GET',
    headers,
  }));
}

/** Hammer one path until it refuses, or give up after `attempts`. */
async function floodUntilRefused(path: string, attempts: number, options: { method?: string; address?: string } = {}) {
  for (let index = 0; index < attempts; index += 1) {
    const response = await hit(path, options);
    if (response.status === 429) return { refusedAt: index, response };
  }
  return { refusedAt: null, response: null };
}

describe('a flood at the sign-in form', () => {
  it('is refused, and stops costing an auth round trip once it is', async () => {
    const { refusedAt, response } = await floodUntilRefused('/auth/sign-in', 200, { method: 'POST' });

    expect(refusedAt).not.toBeNull();
    expect(response?.status).toBe(429);

    /*
     * The whole point, in one assertion. The number of auth-server round trips
     * is bounded by the burst policy, not by how many requests the attacker
     * sent — so the flood costs them everything and costs us a map lookup.
     */
    const callsAtRefusal = getUserCalls;
    for (let index = 0; index < 100; index += 1) await hit('/auth/sign-in', { method: 'POST' });
    expect(getUserCalls).toBe(callsAtRefusal);
  });

  it('always says when to come back', async () => {
    const { response } = await floodUntilRefused('/auth/sign-in', 200, { method: 'POST' });
    const retryAfter = Number(response?.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(response?.headers.get('cache-control')).toContain('no-store');
  });

  it('refuses the flooder without refusing anybody else', async () => {
    await floodUntilRefused('/auth/sign-in', 200, { method: 'POST', address: '198.51.100.7' });

    const bystander = await hit('/auth/sign-in', { method: 'POST', address: '203.0.113.42' });
    expect(bystander.status).not.toBe(429);
  });

  it('answers a browser with a page and an API client with the error envelope', async () => {
    const { response } = await floodUntilRefused('/auth/sign-in', 200, { method: 'POST' });
    expect(response?.headers.get('content-type')).toContain('application/json');
    expect(await response!.json()).toMatchObject({ error: { code: 'rate-limited', retryable: true } });

    resetEdgeAbuseLimiter();
    for (let index = 0; index < 200; index += 1) {
      const page = await hit('/auth/sign-in', { method: 'POST', accept: 'text/html' });
      if (page.status === 429) {
        expect(page.headers.get('content-type')).toContain('text/html');
        const body = await page.text();
        // A refusal names no rule and no bound — only how long to wait.
        expect(body).toContain('คำขอถี่เกินไป');
        expect(body).not.toMatch(/limit|policy|bucket/i);
        return;
      }
    }
    throw new Error('the html path was never refused');
  });
});

describe('a flood at the console', () => {
  it('is bounded before the operator role is even looked up', async () => {
    const { refusedAt } = await floodUntilRefused('/admin', 400);
    expect(refusedAt).not.toBeNull();

    const callsAtRefusal = getUserCalls;
    for (let index = 0; index < 50; index += 1) await hit('/admin');
    expect(getUserCalls).toBe(callsAtRefusal);
  });

  it('bounds console writes harder than console reads', async () => {
    const writes = await floodUntilRefused('/admin/system', 400, { method: 'POST' });
    resetEdgeAbuseLimiter();
    const reads = await floodUntilRefused('/admin/system', 400);

    expect(writes.refusedAt).not.toBeNull();
    expect(reads.refusedAt).not.toBeNull();
    expect(writes.refusedAt!).toBeLessThan(reads.refusedAt!);
  });
});

describe('a flood at an expensive endpoint', () => {
  it('is refused well before an ordinary API flood would be', async () => {
    const expensive = await floodUntilRefused('/api/option-simulations/compute/monte-carlo', 500, { method: 'POST' });
    resetEdgeAbuseLimiter();
    const ordinary = await floodUntilRefused('/api/market/quote/AAPL', 500);

    expect(expensive.refusedAt).not.toBeNull();
    expect(ordinary.refusedAt).not.toBeNull();
    expect(expensive.refusedAt!).toBeLessThan(ordinary.refusedAt!);
  });
});

describe('what the gate must never touch', () => {
  /*
   * The failure mode that would be worse than the attack: refusing readers. A
   * page render is not a guarded class, and a reader clicking around the product
   * must never meet a 429 no matter how fast they click.
   */
  it('never bounds an ordinary page, however fast it is requested', async () => {
    for (const path of ['/', '/portfolio', '/watchlist', '/stock/AAPL', '/settings']) {
      for (let index = 0; index < 300; index += 1) {
        const response = await hit(path);
        if (response.status === 429) throw new Error(`${path} was rate limited at request ${index}`);
      }
    }
  });

  it('never bounds the callback that finishes a sign-in', async () => {
    for (let index = 0; index < 200; index += 1) {
      const response = await hit('/auth/callback?code=abc');
      expect(`#${index}: ${response.status === 429}`).toBe(`#${index}: false`);
    }
  });

  it('admits a stock page opening its whole fan-out at once', async () => {
    const paths = [
      '/api/market/quote/AAPL', '/api/market/chart', '/api/market/history/AAPL',
      '/api/market/session/AAPL', '/api/market/profile/AAPL', '/api/notifications/unread-count',
    ];
    // Ten full page loads back to back, from one reader.
    for (let round = 0; round < 10; round += 1) {
      for (const path of paths) {
        const response = await hit(path);
        expect(`${path} round ${round}: ${response.status === 429}`).toBe(`${path} round ${round}: false`);
      }
    }
  });
});
