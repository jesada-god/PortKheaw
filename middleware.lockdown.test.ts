import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The security lockdown, as middleware actually runs it.
 *
 * `authorization-matrix.test.ts` proves `decideLockdown` decides correctly on
 * its own. This proves the decision is reached *through the real middleware* —
 * that the posture read happens, that the refusal carries the product's error
 * envelope and its security headers, and that the paths an incident makes more
 * necessary still get through. Those are the parts a wiring mistake breaks
 * without any pure test noticing.
 *
 * The property that gets its own case below, because it is the one somebody will
 * eventually try to "fix": **an operator is refused too.** Maintenance mode lets
 * an operator through, and the reflex is to make lockdown match. It must not.
 * The incident this switch exists for is a compromised operator session, so an
 * operator exemption would hand the switch to exactly the person it is aimed at.
 */

type Posture = { maintenance: boolean; lockdown: boolean; admin: boolean };

let posture: Posture = { maintenance: false, lockdown: false, admin: false };
let postureCalls = 0;
let securityEventCalls: Array<{ event: string; target: string }> = [];

function tokenWithAal(aal: 'aal1' | 'aal2'): string {
  const payload = Buffer.from(JSON.stringify({ aal, sub: 'operator-1' })).toString('base64url');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;
}

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
      getUser: async () => ({ data: { user: { id: 'operator-1', factors: [{ id: 'f1', status: 'verified' }] } } }),
      getSession: async () => ({ data: { session: { access_token: tokenWithAal('aal2') } } }),
    },
    rpc: async (name: string, args?: Record<string, unknown>) => {
      if (name === 'resolve_runtime_posture') {
        postureCalls += 1;
        return {
          data: [{
            maintenance_enabled: posture.maintenance,
            security_lockdown_enabled: posture.lockdown,
            is_admin: posture.admin,
            database_now: '2026-08-14T00:00:00.000Z',
          }],
          error: null,
        };
      }
      if (name === 'get_my_account_access') {
        return { data: [{ role: posture.admin ? 'admin' : 'user' }], error: null };
      }
      if (name === 'record_security_event') {
        securityEventCalls.push({
          event: String(args?.input_event_key),
          target: String(args?.input_target_ref),
        });
        return { data: 'recorded', error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
  }),
}));

let middleware: typeof import('./middleware').middleware;
let resetRuntimePostureCache: typeof import('./src/lib/security/posture-edge').resetRuntimePostureCache;
let resetEdgeSecurityCounter: typeof import('./src/lib/security/security-audit-edge').resetEdgeSecurityCounter;

beforeEach(async () => {
  vi.resetModules();
  posture = { maintenance: false, lockdown: false, admin: true };
  postureCalls = 0;
  securityEventCalls = [];
  ({ middleware } = await import('./middleware'));
  ({ resetRuntimePostureCache } = await import('./src/lib/security/posture-edge'));
  ({ resetEdgeSecurityCounter } = await import('./src/lib/security/security-audit-edge'));
  resetRuntimePostureCache();
  resetEdgeSecurityCounter();
});

function hit(path: string, method = 'POST') {
  const headers = new Headers();
  headers.set('x-forwarded-for', '203.0.113.7');
  headers.set('cookie', 'sb-access-token=whatever');
  return middleware(new NextRequest(`https://portkheaw.app${path}`, { method, headers }));
}

describe('while the lockdown is off', () => {
  it('lets an operator mutation through untouched', async () => {
    const response = await hit('/admin/system');
    expect(response.status).not.toBe(423);
  });
});

describe('while the lockdown is engaged', () => {
  beforeEach(() => {
    posture = { maintenance: false, lockdown: true, admin: true };
  });

  it('refuses a console mutation with 423 and the product´s error envelope', async () => {
    const response = await hit('/admin/system');
    expect(response.status).toBe(423);
    const body = await response.json();
    expect(body.error.code).toBe('security-lockdown');
    // It says the operation is closed and does not say why. Somebody probing
    // should not learn that an incident is in progress.
    expect(JSON.stringify(body)).not.toMatch(/incident|compromis|attack/i);
  });

  it('refuses an operator, which is the whole point of the switch', async () => {
    posture.admin = true;
    const response = await hit('/admin/beta');
    expect(response.status).toBe(423);
  });

  it('refuses the operator API as well as the operator page', async () => {
    const response = await hit('/api/admin/anything', 'DELETE');
    expect(response.status).toBe(423);
  });

  it('still serves console reads, so an operator can see what is happening', async () => {
    const response = await hit('/admin/system', 'GET');
    expect(response.status).not.toBe(423);
  });

  it('leaves the page that releases the switch reachable for a mutation', async () => {
    // A control that cannot be released while engaged is a lockout.
    const response = await hit('/admin/security');
    expect(response.status).not.toBe(423);
  });

  it('never refuses the billing webhook', async () => {
    // A refused delivery is a retry storm and eventually a paid subscription
    // that silently did not renew.
    const response = await hit('/api/billing/webhook');
    expect(response.status).not.toBe(423);
  });

  it('leaves an ordinary reader writing their own data alone', async () => {
    const response = await hit('/portfolio');
    expect(response.status).not.toBe(423);
  });

  it('carries the security headers on the refusal itself', async () => {
    const response = await hit('/admin/system');
    expect(response.status).toBe(423);
    // A refusal served without a CSP is a refusal with a hole in it.
    expect(response.headers.get('Content-Security-Policy')).toContain(`default-src 'self'`);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin-allow-popups');
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });
});

describe('the posture read', () => {
  it('answers both switches in one round trip', async () => {
    posture = { maintenance: false, lockdown: true, admin: true };
    await hit('/admin/system', 'GET');
    // One call, not one per switch: this runs on every request, and a second
    // round trip here is a permanent latency tax on the whole product.
    expect(postureCalls).toBe(1);
  });

  it('costs nothing on a path both gates exempt', async () => {
    await hit('/api/billing/webhook');
    expect(postureCalls).toBe(0);
  });

  it('does not cache a positive answer between requests', async () => {
    posture = { maintenance: false, lockdown: true, admin: true };
    await hit('/admin/system', 'GET');
    await hit('/admin/system', 'GET');
    // The other half of the answer — whether this caller is an operator — is
    // per-reader, so a shared positive would be one reader's role reused.
    expect(postureCalls).toBe(2);
  });
});

describe('the audit trail at the edge', () => {
  it('records a non-operator reaching the console, by class and never by path', async () => {
    posture = { maintenance: false, lockdown: false, admin: false };
    const response = await hit('/admin/system', 'GET');
    expect(response.status).toBe(404);
    // The recorder is fired without being awaited, so let the microtask run.
    await new Promise((settle) => setTimeout(settle, 0));

    expect(securityEventCalls).toHaveLength(1);
    expect(securityEventCalls[0].event).toBe('admin.authorization.denied');
    // An attacker-chosen path in an append-only table is a string nobody can
    // delete afterwards.
    expect(securityEventCalls[0].target).toBe('admin-console');
    expect(securityEventCalls[0].target).not.toContain('/');
  });

  it('writes at most one row per identity per window, so it is not an amplifier', async () => {
    posture = { maintenance: false, lockdown: false, admin: false };
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await hit(`/admin/probe-${attempt}`, 'GET');
    }
    await new Promise((settle) => setTimeout(settle, 0));

    // Four refusals, one row: the first in the window. The fifth would cross
    // the `adminProbing` threshold and earn a second.
    expect(securityEventCalls).toHaveLength(1);
  });

  it('records the fifth attempt, which is where the rule trips', async () => {
    posture = { maintenance: false, lockdown: false, admin: false };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await hit(`/admin/probe-${attempt}`, 'GET');
    }
    await new Promise((settle) => setTimeout(settle, 0));

    expect(securityEventCalls).toHaveLength(2);
    expect(securityEventCalls[1].event).toBe('admin.authorization.denied');
  });
});
