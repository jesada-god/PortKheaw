import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The operator console, as middleware sees it.
 *
 * These cases exist because of a specific production failure. Authorization for
 * `/admin` lived in `app/admin/layout.tsx`, which called `notFound()` — and in
 * the App Router a layout and the page beneath it render **concurrently**. By
 * the time the layout refused, the console had already run and its rendered tree
 * was serialised into the response beside the 404 marker, under a 200, because
 * the shell had been flushed before either finished. Any signed-in reader could
 * `curl /admin` and read the console out of the payload.
 *
 * So the first refusal now happens before a renderer exists. What is asserted
 * here is the shape of that refusal:
 *
 *   * a non-operator with a valid session gets a 404 and *no* console;
 *   * an operator is not touched;
 *   * an unreadable role is not an operator — the check fails closed;
 *   * nothing outside `/admin` changed.
 *
 * This is one layer of three. `requireAdminPage()` refuses the render and the
 * database refuses the data; the contract tests assert both are still in place.
 */

type Role = 'admin' | 'user' | 'error';

let currentUser: { id: string } | null = null;
let currentRole: Role = 'user';
let accountAccessCalls = 0;

vi.mock('@/src/config/env/client', () => ({
  isSupabaseConfigured: true,
  clientEnv: {
    NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
  },
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: currentUser } }) },
    rpc: async (name: string) => {
      if (name === 'resolve_maintenance_state') {
        return { data: [{ maintenance_enabled: false, is_admin: currentRole === 'admin' }], error: null };
      }
      if (name === 'get_my_account_access') {
        accountAccessCalls += 1;
        if (currentRole === 'error') return { data: null, error: { message: 'connection reset' } };
        return { data: [{ role: currentRole }], error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
  }),
}));

let middleware: typeof import('./middleware').middleware;
let resetMaintenanceEdgeCache: typeof import('./src/lib/maintenance/maintenance-edge').resetMaintenanceEdgeCache;

beforeEach(async () => {
  vi.resetModules();
  currentUser = null;
  currentRole = 'user';
  accountAccessCalls = 0;
  ({ middleware } = await import('./middleware'));
  ({ resetMaintenanceEdgeCache } = await import('./src/lib/maintenance/maintenance-edge'));
  resetMaintenanceEdgeCache();
});

afterEach(() => {
  currentUser = null;
});

const CONSOLE_PATHS = [
  '/admin',
  '/admin/billing',
  '/admin/support',
  '/admin/support/2b0d5c9e-0000-4000-8000-000000000000',
  '/admin/refunds',
  '/admin/refunds/2b0d5c9e-0000-4000-8000-000000000000',
  '/admin/beta',
  '/admin/system',
] as const;

function request(path: string, options: { role?: Role; signedIn?: boolean; method?: string } = {}) {
  currentUser = options.signedIn === false ? null : { id: 'reader-1' };
  currentRole = options.role ?? 'user';
  return middleware(new NextRequest(`https://portkheaw.app${path}`, { method: options.method ?? 'GET' }));
}

async function bodyOf(response: Response): Promise<string> {
  return response.body ? await response.text() : '';
}

describe('a signed-in non-operator and the console', () => {
  it('refuses every console URL with a 404', async () => {
    for (const path of CONSOLE_PATHS) {
      const response = await request(path);
      expect(`${path} -> ${response.status}`).toBe(`${path} -> 404`);
    }
  });

  /*
   * The whole incident, as one assertion. The refusal body must not carry the
   * console's markup, its data, or the names of the things it controls.
   */
  it('returns no operator markup, data or vocabulary in the refusal', async () => {
    const body = await bodyOf(await request('/admin'));
    for (const leak of [
      'ศูนย์ปฏิบัติการ', 'ปฏิบัติการบิลลิ่ง', 'ผู้ใช้งานทั้งหมด', 'เฉพาะผู้ดูแลระบบ',
      'admin_dashboard_overview', 'admin_audit_feed', 'self.__next_f',
      '/admin/billing', '/admin/system', '/admin/beta',
    ]) {
      expect(body).not.toContain(leak);
    }
  });

  it('says nothing about why — no 403, no redirect, no location', async () => {
    const response = await request('/admin/system');
    expect(response.status).not.toBe(403);
    expect(response.headers.get('location')).toBeNull();
  });

  it('never lets the answer be cached and handed to the next reader', async () => {
    const response = await request('/admin');
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('Cache-Control')).toContain('private');
  });

  it('carries the security headers the rest of the product carries', async () => {
    const response = await request('/admin');
    expect(response.headers.get('Content-Security-Policy')).toContain(`default-src 'self'`);
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('refuses a mutation to a console URL as well as a read', async () => {
    // A server action posts to the URL of the page that rendered its form.
    const response = await request('/admin/system', { method: 'POST' });
    expect(response.status).toBe(404);
  });

  it('resolves the role from the database on every request, never from a cache', async () => {
    await request('/admin');
    await request('/admin');
    expect(accountAccessCalls).toBe(2);
  });
});

describe('fail closed', () => {
  it('treats an unreadable role as not an operator', async () => {
    for (const path of CONSOLE_PATHS) {
      expect((await request(path, { role: 'error' })).status).toBe(404);
    }
  });

  /*
   * A session cookie that no longer resolves to a user is a signed-out visitor,
   * and the protected-path rule sends them to sign-in before the role is ever
   * asked for. What must not happen is a 200.
   */
  it('never serves the console to a request with no resolvable user', async () => {
    const response = await request('/admin', { signedIn: false });
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/auth/sign-in');
    expect(accountAccessCalls).toBe(0);
  });
});

describe('an operator', () => {
  it('is passed through to every console URL untouched', async () => {
    for (const path of CONSOLE_PATHS) {
      const response = await request(path, { role: 'admin' });
      expect(`${path} -> ${response.status}`).toBe(`${path} -> 200`);
      expect(response.headers.get('location')).toBeNull();
    }
  });
});

describe('everything that is not the console', () => {
  it('is left alone for an ordinary reader', async () => {
    for (const path of [
      '/', '/portfolio', '/watchlist', '/settings', '/settings/subscription',
      '/support', '/notifications', '/stock/AAPL', '/api/market/quote/AAPL',
    ]) {
      const response = await request(path);
      expect(`${path} -> ${response.status}`).toBe(`${path} -> 200`);
    }
  });

  it('does not spend a role lookup on a path outside the console', async () => {
    await request('/portfolio');
    expect(accountAccessCalls).toBe(0);
  });

  /*
   * Prefix matching is on a path segment. `/administrators` is somebody else's
   * route, not a console URL, and must not be refused as one.
   */
  it('does not mistake a lookalike path for the console', async () => {
    expect((await request('/administrators')).status).toBe(200);
    expect((await request('/adminx')).status).toBe(200);
  });
});
