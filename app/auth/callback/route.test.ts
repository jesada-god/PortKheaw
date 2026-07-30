import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let client: FakeCallbackClient | null = null;

vi.mock('@/src/lib/supabase/server', () => ({
  createClient: async () => client,
}));

class FakeCallbackClient {
  exchanges: string[] = [];
  exchangeError: { code?: string; status?: number; message?: string } | null = null;
  user: unknown = null;
  /** Anything that would write a row. Must stay at zero on a repeated callback. */
  writes = 0;

  auth = {
    exchangeCodeForSession: async (code: string) => {
      this.exchanges.push(code);
      if (this.exchangeError) return { data: null, error: this.exchangeError };
      this.user = { id: 'user-1' };
      return { data: { session: {} }, error: null };
    },
    getUser: async () => ({ data: { user: this.user } }),
  };

  from = () => {
    this.writes += 1;
    return { insert: async () => ({ error: null }), upsert: async () => ({ error: null }) };
  };
}

let route: typeof import('./route');

beforeEach(async () => {
  client = new FakeCallbackClient();
  route = await import('./route');
});

function request(query: string): NextRequest {
  return new NextRequest(`https://portkheaw.app/auth/callback${query}`);
}

function locationOf(response: Response): URL {
  return new URL(response.headers.get('location') ?? '', 'https://portkheaw.app');
}

describe('auth callback', () => {
  it('exchanges the code and continues to the sanitised return path', async () => {
    const response = await route.GET(request('?code=one-time-code&next=%2Fportfolio'));
    expect(client!.exchanges).toEqual(['one-time-code']);
    expect(locationOf(response).pathname).toBe('/portfolio');
  });

  it('never leaves the one-time code in the URL the visitor ends up on', async () => {
    const response = await route.GET(request('?code=one-time-code&next=%2Fwatchlist'));
    const location = locationOf(response);
    expect(location.searchParams.has('code')).toBe(false);
    expect(location.toString()).not.toContain('one-time-code');
  });

  it('refuses an off-site return path and keeps the visitor on this origin', async () => {
    for (const hostile of ['https%3A%2F%2Fevil.com', '%2F%2Fevil.com', '%2F%5Cevil.com']) {
      client = new FakeCallbackClient();
      const response = await route.GET(request(`?code=abc&next=${hostile}`));
      expect(locationOf(response).origin).toBe('https://portkheaw.app');
      expect(locationOf(response).hostname).toBe('portkheaw.app');
    }
  });

  /*
   * A code can only be spent once, so a reload — or a second tab racing the
   * first — arrives with the exchange already done. That is success arriving
   * twice: it must land on the destination, and it must not create anything a
   * second time.
   */
  it('treats a repeated callback as success and writes nothing a second time', async () => {
    await route.GET(request('?code=one-time-code&next=%2Fportfolio'));
    client!.exchangeError = { code: 'flow_state_not_found', status: 404 };
    const response = await route.GET(request('?code=one-time-code&next=%2Fportfolio'));
    expect(locationOf(response).pathname).toBe('/portfolio');
    expect(client!.writes).toBe(0);
  });

  it('sends a genuinely failed exchange back to sign-in with a localised message', async () => {
    client!.exchangeError = { code: 'bad_code_verifier', status: 401, message: 'code verifier does not match' };
    const response = await route.GET(request('?code=stale&next=%2Fportfolio'));
    const location = locationOf(response);
    expect(location.pathname).toBe('/auth/sign-in');
    expect(location.searchParams.get('error')).not.toContain('verifier');
    expect(location.searchParams.get('error')).toBeTruthy();
  });

  it('reports a cancelled Google consent screen as a cancellation', async () => {
    const response = await route.GET(request('?error=access_denied&error_description=The+user+denied+the+request'));
    const location = locationOf(response);
    expect(location.pathname).toBe('/auth/sign-in');
    expect(location.searchParams.get('error')).toContain('ยกเลิก');
    expect(location.searchParams.get('error')).not.toContain('denied');
    expect(client!.exchanges).toHaveLength(0);
  });

  it('does not echo an attacker-supplied error description', async () => {
    const response = await route.GET(request('?error=server_error&error_description=%3Cscript%3Ealert(1)%3C%2Fscript%3E'));
    expect(locationOf(response).searchParams.get('error')).not.toContain('script');
  });

  it('sends a bare visit with no session back to sign-in', async () => {
    const response = await route.GET(request(''));
    expect(locationOf(response).pathname).toBe('/auth/sign-in');
  });

  it('lets an already-signed-in visitor through a codeless reload', async () => {
    client!.user = { id: 'user-1' };
    const response = await route.GET(request('?next=%2Fportfolio'));
    expect(locationOf(response).pathname).toBe('/portfolio');
  });
});
