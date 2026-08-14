import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCKDOWN_CLASSES } from '@/src/lib/security/lockdown';
import { SECURITY_EVENT_KEYS } from '@/src/lib/security/security-events';

/**
 * The security regression suite: the properties that must survive every future
 * change, asserted against the source and the migrations.
 *
 * `authorization-matrix.test.ts` proves the decisions are *right*. This proves
 * they are *reached* — that every surface which can answer a privileged question
 * asks a gate first, and that the six ways into this product agree with each
 * other. Those are different failures. A perfect decision function nothing calls
 * protects nothing, and it is the one a refactor removes without any test going
 * red.
 *
 * The six surfaces, and where each is gated:
 *
 *   page          `requireAdminPage()`, inside the page, before its first read.
 *   API route     the route's own guard.
 *   server action `requireAdminMutation()`.
 *   RPC           `is_platform_admin` inside the `security definer` routine.
 *   direct DB     row-level security, plus grants revoked from every client role.
 *   WebSocket     the Gateway's own identity check and connection caps.
 *
 * Every one of them re-checks. None is trusted to be the only one, and this file
 * is what keeps that true.
 */

const root = process.cwd();

function source(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

const LOCKDOWN_MIGRATION = source('supabase/migrations/202608140001_security_lockdown_and_audit.sql');
const PHASE6_MIGRATION = source('supabase/migrations/202608050007_admin_beta_and_production_safety.sql');
const ROLE_MIGRATION = source('supabase/migrations/202608030002_admin_role_and_access_preview.sql');

/* ===========================================================================
 * 1. Privilege escalation — the tier/role boundary, in the code that decides it
 * ======================================================================== */

describe('privilege escalation is impossible through a tier', () => {
  it('never derives the operator role from a tier, an email or a display name', () => {
    for (const file of [
      'src/lib/subscription/admin-access.ts',
      'src/lib/subscription/account-access.ts',
      'src/lib/admin/admin-edge.ts',
      'src/lib/admin/admin-guard.ts',
    ]) {
      const code = source(file);
      // The escalation this forbids: `isAdmin = tier === 'elite'`, or a role
      // read out of a mailbox. The role has exactly one source.
      //
      // Bounded to a single line, because an assignment that spans one is not
      // the shape this is looking for — and a pattern that crosses newlines
      // matches the next property in the object literal instead, which made an
      // earlier version of this assertion fail on correct code.
      expect(`${file}: ${/isAdmin\s*[=:]\s*[^;\n]*\b(tier|email|name)\b/i.test(code)}`)
        .toBe(`${file}: false`);
      expect(`${file}: ${/@(gmail|portkheaw)/i.test(code)}`).toBe(`${file}: false`);
    }
  });

  it('resolves the role through the database projection and nothing else', () => {
    const edge = source('src/lib/admin/admin-edge.ts');
    expect(edge).toContain("client.rpc('get_my_account_access')");
    // Fails closed on every error path.
    expect(edge).toContain('if (error) return false;');
  });

  it('checks the role inside the database for every routine this phase added', () => {
    for (const routine of [
      'admin_set_security_lockdown', 'admin_security_posture', 'admin_security_audit',
    ]) {
      const body = LOCKDOWN_MIGRATION.slice(LOCKDOWN_MIGRATION.indexOf(`function public.${routine}(`));
      expect(`${routine}: ${body.includes('public.is_platform_admin(requesting_user)')}`)
        .toBe(`${routine}: true`);
      expect(body.slice(0, body.indexOf('$$;'))).toContain("raise exception 'ADMIN_REQUIRED'");
    }
  });
});

/* ===========================================================================
 * 2. Role spoofing — nothing the caller sends may name the caller
 * ======================================================================== */

describe('a caller can never name themselves', () => {
  it('reads the actor from auth.uid() in every routine that records one', () => {
    for (const routine of [
      'admin_set_security_lockdown', 'record_security_event',
    ]) {
      const body = LOCKDOWN_MIGRATION.slice(
        LOCKDOWN_MIGRATION.indexOf(`function public.${routine}(`),
        LOCKDOWN_MIGRATION.indexOf(`revoke all on function public.${routine}`),
      );
      expect(`${routine}: ${body.includes('requesting_user uuid := (select auth.uid())')}`)
        .toBe(`${routine}: true`);
    }
  });

  it('takes no actor argument on the client-callable audit writer', () => {
    // `record_security_event` is reachable by any signed-in caller, because a
    // non-operator's denied attempt is exactly the event worth keeping. It is
    // safe to be reachable only because there is no parameter that could name
    // somebody else as the actor.
    const signature = LOCKDOWN_MIGRATION.slice(
      LOCKDOWN_MIGRATION.indexOf('function public.record_security_event('),
      LOCKDOWN_MIGRATION.indexOf('returns text', LOCKDOWN_MIGRATION.indexOf('function public.record_security_event(')),
    );
    expect(signature).not.toMatch(/input_actor|input_user_id|input_role/);
  });

  it('never lets a client-supplied value decide authorization in a guard', () => {
    for (const file of [
      'src/lib/admin/admin-guard.ts',
      'src/lib/admin/admin-edge.ts',
      'src/lib/security/lockdown-server.ts',
      'src/lib/security/admin-assurance-server.ts',
      'app/admin/layout.tsx',
    ]) {
      const code = source(file);
      expect(`${file}: ${/searchParams|formData|localStorage/.test(code)}`).toBe(`${file}: false`);
    }
  });

  it('decides no authorization inside a client component', () => {
    for (const file of [
      'src/components/admin/SecurityLockdownControl.tsx',
      'src/components/admin/AdminSecurityControl.tsx',
      'src/components/admin/MaintenanceControl.tsx',
    ]) {
      const code = source(file);
      expect(`${file}: ${/isAdmin|requireAdmin|is_platform_admin|user_roles/.test(code)}`)
        .toBe(`${file}: false`);
    }
  });
});

/* ===========================================================================
 * 3. Mass assignment — a routine writes the columns it names, and no others
 * ======================================================================== */

describe('mass assignment', () => {
  it('assembles the audit detail from typed scalars, never from a caller object', () => {
    const writer = LOCKDOWN_MIGRATION.slice(
      LOCKDOWN_MIGRATION.indexOf('function public.record_security_event('),
      LOCKDOWN_MIGRATION.indexOf('revoke all on function public.record_security_event'),
    );
    // No jsonb parameter at all: there is no door for a caller-shaped object.
    expect(writer).not.toMatch(/input_\w+\s+jsonb/);
    // The detail is built here, from two clamped values.
    expect(writer).toContain('jsonb_build_object(');
    expect(writer).toContain("'outcome', clean_outcome");
    expect(writer).toContain('greatest(0, least(coalesce(input_observed_count, 0), 1000000))');
  });

  it('clamps every text input to a length the schema also enforces', () => {
    const writer = LOCKDOWN_MIGRATION.slice(
      LOCKDOWN_MIGRATION.indexOf('function public.record_security_event('),
      LOCKDOWN_MIGRATION.indexOf('revoke all on function public.record_security_event'),
    );
    expect(writer).toContain('left(input_event_key, 80)');
    expect(writer).toContain('160');
    expect(writer).toContain('64');
  });

  it('writes only the lockdown columns in the lockdown routine', () => {
    const routine = LOCKDOWN_MIGRATION.slice(
      LOCKDOWN_MIGRATION.indexOf('function public.admin_set_security_lockdown('),
      LOCKDOWN_MIGRATION.indexOf('revoke all on function public.admin_set_security_lockdown'),
    );
    const update = routine.slice(routine.indexOf('update public.app_runtime_settings set'));
    // It must not be able to move the maintenance switch as a side effect.
    expect(update).not.toContain('maintenance_enabled =');
    expect(update).not.toContain('maintenance_message =');
  });
});

/* ===========================================================================
 * 4. IDOR — an identifier in a request never selects somebody else's row
 * ======================================================================== */

describe('IDOR', () => {
  it('scopes every per-account routine to auth.uid() rather than to an argument', () => {
    // `set_my_admin_access_preview` takes a mode and no account: there is no
    // argument through which one operator could start a preview on another
    // account, because the account is not an input.
    const preview = ROLE_MIGRATION.slice(
      ROLE_MIGRATION.indexOf('function public.set_my_admin_access_preview('),
      ROLE_MIGRATION.indexOf('revoke all on function public.set_my_admin_access_preview'),
    );
    expect(preview).toContain('requesting_user uuid := (select auth.uid())');
    expect(preview).toContain('where target.user_id = requesting_user');
    expect(preview).not.toMatch(/input_user_id|input_target_user/);
  });

  it('grants no client role a seat at any table this phase touches', () => {
    for (const table of ['admin_audit_events', 'rate_limit_counters']) {
      expect(PHASE6_MIGRATION).toContain(`alter table public.${table} enable row level security`);
      expect(PHASE6_MIGRATION).toContain(`revoke all on table public.${table} from anon, authenticated`);
    }
    // The lockdown state lives on a table that was already revoked in Phase 7 and
    // is reachable only through the routines above.
    expect(LOCKDOWN_MIGRATION).toContain('alter table public.app_runtime_settings');
    expect(LOCKDOWN_MIGRATION).not.toMatch(/grant\s+(select|insert|update|delete)\s+on\s+table/i);
  });
});

/* ===========================================================================
 * 5. The audit trail — append-only, operator-only, and secret-free
 * ======================================================================== */

describe('the security audit trail', () => {
  it('reuses the append-only operator audit rather than adding a second log', () => {
    expect(LOCKDOWN_MIGRATION).toContain('public.admin_audit_events');
    // A second audit table would be a second, disagreeing answer to "what
    // happened here?", which during an incident is worse than none.
    expect(LOCKDOWN_MIGRATION).not.toMatch(/create table[^;]*audit/i);
    // The append-only trigger it inherits.
    expect(PHASE6_MIGRATION).toContain('before update or delete on public.admin_audit_events');
    expect(PHASE6_MIGRATION).toContain("raise exception 'AUDIT_APPEND_ONLY'");
  });

  it('lets no ordinary account read the log, by grant and by routine', () => {
    expect(PHASE6_MIGRATION).toContain('revoke all on table public.admin_audit_events from anon, authenticated');
    const reader = LOCKDOWN_MIGRATION.slice(
      LOCKDOWN_MIGRATION.indexOf('function public.admin_security_audit('),
      LOCKDOWN_MIGRATION.indexOf('revoke all on function public.admin_security_audit'),
    );
    expect(reader).toContain('not public.is_platform_admin(requesting_user)');
    expect(reader).toContain("raise exception 'ADMIN_REQUIRED'");
    expect(LOCKDOWN_MIGRATION).toContain('revoke all on function public.admin_security_audit(integer, integer) from public, anon');
  });

  it('accepts a closed vocabulary the application and the database agree on', () => {
    const keys = LOCKDOWN_MIGRATION.slice(
      LOCKDOWN_MIGRATION.indexOf('function public.security_event_keys()'),
      LOCKDOWN_MIGRATION.indexOf('revoke all on function public.security_event_keys'),
    );
    for (const key of SECURITY_EVENT_KEYS) {
      expect(`${key}: ${keys.includes(`'${key}'`)}`).toBe(`${key}: true`);
    }
    // And the database refuses anything else, rather than storing it.
    const writer = LOCKDOWN_MIGRATION.slice(LOCKDOWN_MIGRATION.indexOf('function public.record_security_event('));
    expect(writer).toContain('any(public.security_event_keys())');
    expect(writer).toContain("return 'invalid_event'");
  });

  it('has no column or argument a secret could travel in', () => {
    for (const forbidden of [
      'password', 'token', 'api_key', 'apikey', 'secret', 'authorization',
      'cookie', 'session', 'payload', 'body', 'email', 'ip_address', 'user_agent',
    ]) {
      expect(`${forbidden}: ${LOCKDOWN_MIGRATION.toLowerCase().includes(`input_${forbidden}`)}`)
        .toBe(`${forbidden}: false`);
    }
  });

  it('records the reference this application chose, never the caller´s own path', () => {
    // An attacker-chosen string written into an append-only table is a string
    // nobody can delete afterwards.
    const middleware = source('middleware.ts');
    const recorded = middleware.match(/targetRef: [^,\n]+/g) ?? [];
    expect(recorded.length).toBeGreaterThan(0);
    for (const line of recorded) {
      expect(`${line}: ${line.includes('pathname')}`).toBe(`${line}: false`);
    }
  });

  it('emits every event key that is not documented as living elsewhere', () => {
    /*
     * The loose end this prevents: a key in the vocabulary with a detection rule
     * and no emitter, which reads as coverage and is not.
     *
     * Two keys are deliberately not written to the database and are named here
     * so that is a decision rather than an omission. `security.request.spike`
     * belongs to the edge abuse gate, which runs before the session lookup —
     * recording it would put a database write back in front of the gate and undo
     * the property the gate exists for. `security.websocket.spike` belongs to
     * the Gateway, a separate process with no Supabase write path, which already
     * logs every refused upgrade with its reason and open count.
     */
    const EMITTED_ELSEWHERE = ['security.request.spike', 'security.websocket.spike'];

    const emitters = [
      'middleware.ts',
      'src/lib/admin/admin-guard.ts',
      'src/lib/security/request-guard.ts',
      'app/admin/security/actions.ts',
      'app/settings/subscription/actions.ts',
    ].map(source).join('\n');

    for (const key of SECURITY_EVENT_KEYS) {
      const expected = !EMITTED_ELSEWHERE.includes(key);
      expect(`${key}: ${emitters.includes(`'${key}'`)}`).toBe(`${key}: ${expected}`);
    }

    // And the two that live elsewhere really do produce a signal there.
    expect(source('services/market-gateway/server.ts'))
      .toContain("log('error', `rejected upgrade:");
    expect(source('src/lib/security/security-events.ts')).toContain('edge-abuse-protection.md');
  });

  it('never lets an audit failure break the request it was reporting on', () => {
    for (const file of [
      'src/lib/security/security-audit.ts',
      'src/lib/security/security-audit-edge.ts',
    ]) {
      // A recorder that throws inside a refusal turns a clean 404 into a 500 —
      // an attacker's failed probe becomes a working denial of service.
      expect(`${file}: ${source(file).includes('} catch {')}`).toBe(`${file}: true`);
    }
  });
});

/* ===========================================================================
 * 6. The lockdown — enforced at more than one layer, releasable at all times
 * ======================================================================== */

describe('the lockdown holds at every layer', () => {
  it('refuses privileged surfaces at the edge before a renderer exists', () => {
    const middleware = source('middleware.ts');
    expect(middleware).toContain('const lockdown = decideLockdown({');
    expect(middleware).toContain("if (lockdown.action === 'block')");
    expect(middleware).toContain('LOCKDOWN_DENIAL_BODY');
  });

  it('refuses at the one gate every operator mutation already passes through', () => {
    const gate = source('src/lib/security/admin-assurance-server.ts');
    expect(gate).toContain('await assertMutationAllowed(');
    // Defaulting to the blocked class is what puts an action added tomorrow
    // behind the switch without anybody remembering to classify it.
    expect(gate).toContain("options.lockdownClass ?? 'admin-mutation'");
  });

  it('refuses inside the database on the two tables where privilege lives', () => {
    for (const trigger of [
      'user_roles_security_lockdown', 'admin_access_previews_security_lockdown',
    ]) {
      expect(`${trigger}: ${LOCKDOWN_MIGRATION.includes(`create trigger ${trigger}`)}`)
        .toBe(`${trigger}: true`);
    }
    // A trigger on the table protects every path to it, including a routine
    // written next month and a service-role script that never touched the app.
    expect(LOCKDOWN_MIGRATION).toContain('before insert or update or delete on public.user_roles');
    expect(LOCKDOWN_MIGRATION).toContain("raise exception 'SECURITY_LOCKDOWN'");
  });

  it('never blocks the billing webhook, in any mode', () => {
    // A refused delivery is a retry storm and eventually a paid subscription
    // that silently did not renew — a worse outcome than the override it would
    // have caught.
    const lockdown = source('src/lib/security/lockdown.ts');
    expect(lockdown).toContain('/api/billing/webhook');
    expect(LOCKDOWN_MIGRATION).not.toContain('on public.user_subscriptions');
  });

  it('keeps the release path open in the decision, the action and the page', () => {
    expect(source('src/lib/security/lockdown.ts')).toContain("'/admin/security'");
    // The action names its exemption at the call site rather than inheriting it.
    expect(source('app/admin/security/actions.ts'))
      .toContain("requireAdminMutation({ lockdownClass: 'security-toggle' })");
    // And the switch is on the one page that stays reachable.
    expect(source('app/admin/security/page.tsx')).toContain('SecurityLockdownControl');
  });

  it('cannot be moved by anything but an operator with a second factor', () => {
    const action = source('app/admin/security/actions.ts');
    expect(action).toContain('requireAdminMutation(');
    // Server-side confirmation, so a stray submit cannot engage it.
    expect(action).toContain("formData.get('confirm') !== 'yes'");
    // And the database refuses again on its own terms.
    const routine = LOCKDOWN_MIGRATION.slice(
      LOCKDOWN_MIGRATION.indexOf('function public.admin_set_security_lockdown('),
    );
    expect(routine).toContain('not public.is_platform_admin(requesting_user)');
  });

  it('classifies every mutation class exactly once', () => {
    // A class in the union with no decision is allowed by default, which is the
    // safe direction — but it must be a decision somebody made, not an omission.
    expect([...LOCKDOWN_CLASSES]).toEqual([
      'admin-mutation', 'role-change', 'billing-override',
      'account-destructive', 'security-toggle', 'maintenance-toggle', 'ordinary-write',
    ]);
  });

  it('gates the one destructive reader path that row-level security does not bound', () => {
    // Account deletion runs on the service-role client: it removes data across
    // every table and then the auth user, and none of it comes back.
    const action = source('app/auth/actions.ts');
    expect(action).toContain("assertMutationAllowed('account-destructive')");
    const gateIndex = action.indexOf("assertMutationAllowed('account-destructive')");
    // After re-authentication, so a caller who cannot prove they are the account
    // holder learns nothing about the platform's state.
    expect(action.indexOf('reauthMethodFor(user)')).toBeLessThan(gateIndex);
    /*
     * And a second gate the application cannot get wrong on its own: the same
     * question asked of the database, on the reader's own client, immediately
     * before the pipeline. The application check fails open by design; this one
     * fails closed, and it is the layer that holds if the one above is skipped.
     */
    const dbGateIndex = action.indexOf("rpc('authorize_account_deletion')");
    expect(dbGateIndex).toBeGreaterThan(gateIndex);
    expect(dbGateIndex).toBeLessThan(action.indexOf('await deleteAccount(authorizedUserId)'));
  });
});

/* ===========================================================================
 * 7. Stale sessions and replay
 * ======================================================================== */

describe('a session is re-proved, not remembered', () => {
  it('proves the token against the auth server before reading any claim from it', () => {
    const server = source('src/lib/security/admin-assurance-server.ts');
    // Decoding first would be asking the caller what their own assurance is.
    expect(server.indexOf('client.auth.getUser()'))
      .toBeLessThan(server.indexOf('assuranceLevelFromToken('));
  });

  it('re-reads the account lifecycle per request rather than trusting the token', () => {
    const access = source('src/lib/subscription/account-access.ts');
    // A deletion begins while a perfectly valid JWT is still in the browser and
    // stays valid for the rest of its hour.
    expect(access).toContain('accountStatus');
    expect(access).toContain("client.rpc('get_my_account_access')");
  });

  it('caches an authorization answer per request only, never across readers', () => {
    for (const file of [
      'src/lib/security/lockdown-server.ts',
      'src/lib/security/admin-assurance-server.ts',
      'src/lib/subscription/account-access.ts',
    ]) {
      const code = source(file);
      // React's `cache` is request-scoped. A module-scope memo would be one
      // reader's answer handed to the next.
      expect(`${file}: ${code.includes('cache(')}`).toBe(`${file}: true`);
      expect(`${file}: ${/^let \w+(Cache|Memo|Until)/m.test(code)}`).toBe(`${file}: false`);
    }
  });

  it('never caches a positive posture answer, because half of it is per-reader', () => {
    const posture = source('src/lib/security/posture-edge.ts');
    expect(posture).toContain('assumeClearUntil = 0;');
    // The negative is cached; the positive carries `isAdmin`, which is not
    // shareable between the readers one isolate serves.
    expect(posture).toContain('if (!posture.maintenanceEnabled && !posture.lockdownEnabled)');
  });

  it('bounds how long a socket keeps believing a token', () => {
    const identity = source('services/market-gateway/identity.ts');
    // A revoked session must stop counting as a session quickly.
    expect(identity).toContain('ttlMs');
    expect(identity).toContain('negativeTtlMs');
    // And what is cached is a digest, never the credential.
    expect(identity).toContain("createHash('sha256')");
    expect(identity).not.toMatch(/cache\.set\([^)]*token[,)]/);
  });
});

/* ===========================================================================
 * 8. Rate limiting, and the ways around one
 * ======================================================================== */

describe('rate limiting cannot be walked around', () => {
  it('charges every identity a caller has, and does not stop at the first refusal', () => {
    const limiter = source('src/lib/security/rate-limit.ts');
    // Returning early would let a caller who is over their account budget spend
    // nothing against their address budget, and rotating the cheap key is how a
    // layered limiter with an early return gets bypassed.
    expect(limiter).toContain('await Promise.all(');
    const burst = source('src/lib/security/abuse-policy.ts');
    expect(burst).toContain('for (const key of identityKeys(identity))');
  });

  it('reads the address from the hop the platform appended, never a chosen header', () => {
    for (const file of ['src/lib/security/rate-limit.ts', 'src/lib/security/abuse-policy.ts']) {
      const code = source(file);
      expect(code).toContain("headers.get('x-forwarded-for')");
      expect(code).toContain("forwarded.split(',')[0]");
    }
  });

  it('pools an unidentifiable caller rather than exempting them', () => {
    const burst = source('src/lib/security/abuse-policy.ts');
    expect(burst).toContain("['anonymous']");
    const edge = source('src/lib/security/edge-abuse.ts');
    expect(edge).toContain("address ?? 'unknown'");
  });

  it('bounds the limiter´s own memory, so it is not a leak an attacker sizes', () => {
    const burst = source('src/lib/security/abuse-policy.ts');
    expect(burst).toContain('maxKeys');
    expect(burst).toContain('this.windows.clear()');
    const counter = source('src/lib/security/security-events.ts');
    expect(counter).toContain('maxKeys');
  });

  it('never turns the audit recorder into an amplifier', () => {
    // One row per refused request would mean a flood writes its own
    // amplification into an append-only table.
    expect(source('src/lib/security/security-audit-edge.ts'))
      .toContain('if (count !== 1 && !(alert && count === alert.threshold)) return;');
    expect(source('src/lib/security/security-audit.ts')).toContain('worthARow');
  });

  it('keys the shared limiter on a digest, never on a raw address', () => {
    expect(source('src/lib/security/rate-limit.ts')).toContain("createHash('sha256')");
  });
});

/* ===========================================================================
 * 9. Web security headers, and the redirects that carry a caller´s value
 * ======================================================================== */

describe('web security', () => {
  const middleware = source('middleware.ts');

  it('sets every header on every response the middleware returns', () => {
    // A refusal that skips the headers is a refusal served without a CSP.
    const returns = middleware.match(
      /return (?!withSecurityHeaders|redirectCarryingSession|NextResponse\.next\(\{ request: \{ headers \} \}\))[^;]*Response[^;]*;/g,
    ) ?? [];
    expect(returns).toEqual([]);
    /*
     * The one construction the pattern above excuses is the nonce pass-through
     * helper, which exists to put the nonce on the *request* so the layout and
     * the framework can read it. It is never itself an exit — every caller hands
     * its result to `withSecurityHeaders` — so returning it bare would be a page
     * served with no policy at all.
     */
    expect(middleware).not.toMatch(/return\s+passThrough\(\)\s*;/);
  });

  it('carries the headers this phase added', () => {
    expect(middleware).toContain("response.headers.set('Cross-Origin-Opener-Policy'");
    expect(middleware).toContain('same-origin-allow-popups');
    expect(middleware).toContain("response.headers.set('X-Content-Type-Options', 'nosniff')");
    expect(middleware).toContain("response.headers.set('X-Frame-Options', 'DENY')");
    expect(middleware).toContain("response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')");
  });

  it('keeps the CSP directives that make the others meaningful', () => {
    for (const directive of [
      `default-src 'self'`, `base-uri 'self'`, `frame-ancestors 'none'`,
      `form-action 'self'`, `object-src 'none'`,
    ]) {
      expect(`${directive}: ${middleware.includes(directive)}`).toBe(`${directive}: true`);
    }
  });

  it('leaves HSTS to the platform, which is its only owner', () => {
    /*
     * Verified against production: `/icon.svg` and a 404 under `/_next/static`
     * — both excluded by this middleware's matcher — carry
     * `max-age=63072000; includeSubDomains; preload` and none of the headers
     * this file sets. HSTS is applied by Vercel to every response.
     *
     * Setting it here too would be worse than redundant. Middleware runs on a
     * subset of paths, so the origin would answer with two different HSTS
     * policies depending on the URL, and the one from this file would be the
     * weaker of the two — dropping `preload` on exactly the pages that carry a
     * session. One owner per security header is what keeps them from drifting.
     */
    expect(middleware).not.toContain("headers.set('Strict-Transport-Security'");
  });

  it('never widens a policy to a wildcard', () => {
    const policy = middleware.slice(middleware.indexOf('const policy = ['), middleware.indexOf(`].join('; ')`));
    expect(policy).not.toContain(`'*'`);
    expect(policy).not.toContain('http:');
  });

  it('sets no CORS header anywhere, so no origin is trusted by default', () => {
    for (const file of ['middleware.ts', 'next.config.ts']) {
      expect(`${file}: ${source(file).includes('Access-Control-Allow-Origin')}`)
        .toBe(`${file}: false`);
    }
  });

  it('carries a refreshed session cookie with its attributes intact', () => {
    /*
     * The regression this pins.
     *
     * `redirectCarryingSession` used to re-set each cookie as `set(name, value)`,
     * which drops every attribute the auth library attached — `httpOnly`,
     * `secure`, `sameSite`, `path`, `maxAge`. On any middleware redirect that
     * coincided with a token refresh, the session cookie was rewritten as a
     * plain, script-readable one. `httpOnly` is the single control standing
     * between an XSS anywhere in the product and a stolen session, and the code
     * carrying the session forward was removing it.
     *
     * The cookie object goes across whole, or not at all.
     */
    const carry = middleware.slice(
      middleware.indexOf('function redirectCarryingSession'),
      middleware.indexOf('return withSecurityHeaders(redirectResponse);'),
    );
    expect(carry).toContain('redirectResponse.cookies.set(cookie)');
    expect(carry).not.toMatch(/cookies\.set\(\s*name\s*,\s*value\s*\)/);
  });

  it('never overrides the cookie attributes the auth library chose', () => {
    // The server client passes `options` straight through. Setting them here
    // would mean this product deciding how a session cookie is scoped, which is
    // a decision it is not in a position to make correctly.
    const server = source('src/lib/supabase/server.ts');
    expect(server).toContain('cookieStore.set(name, value, options)');
    expect(server).not.toMatch(/httpOnly\s*:|sameSite\s*:|secure\s*:/);
  });

  it('refuses an open redirect on every path that takes one from the caller', () => {
    const securityPage = source('app/admin/security/page.tsx');
    // A redirect target that accepts anything is an open redirect wearing a
    // security page's clothes.
    expect(securityPage).toContain("value.startsWith('//')");
    expect(securityPage).toContain("value.includes('\\\\')");
    expect(securityPage).toContain('isAdminConsolePath(path)');

    const paths = source('src/lib/auth/paths.ts');
    expect(paths).toContain('getSafeReturnPath');
  });
});

/* ===========================================================================
 * 10. The migration is additive, replayable and forward-only
 * ======================================================================== */

describe('the lockdown migration is additive and forward-only', () => {
  it('drops no table, column, schema or row belonging to an earlier phase', () => {
    expect(LOCKDOWN_MIGRATION).not.toMatch(/drop\s+table/i);
    expect(LOCKDOWN_MIGRATION).not.toMatch(/drop\s+column/i);
    expect(LOCKDOWN_MIGRATION).not.toMatch(/drop\s+schema/i);
    expect(LOCKDOWN_MIGRATION).not.toMatch(/truncate/i);
    expect(LOCKDOWN_MIGRATION).not.toMatch(/delete\s+from/i);
    // The only `drop` allowed is the idempotent re-creation of this phase's own
    // triggers, which is how the file stays replayable.
    const drops = LOCKDOWN_MIGRATION.match(/drop\s+\w+/gi) ?? [];
    expect(drops.every((statement) => /drop\s+trigger/i.test(statement))).toBe(true);
  });

  it('adds every column with `if not exists` and a default, so a replay is a no-op', () => {
    expect(LOCKDOWN_MIGRATION).toContain('add column if not exists security_lockdown_enabled boolean not null default false');
    for (const column of [
      'security_lockdown_reason', 'security_lockdown_started_at', 'security_lockdown_started_by',
    ]) {
      expect(`${column}: ${LOCKDOWN_MIGRATION.includes(`add column if not exists ${column}`)}`)
        .toBe(`${column}: true`);
    }
  });

  it('defaults a fresh install and a replay alike to "not locked down"', () => {
    expect(LOCKDOWN_MIGRATION).toContain('default false');
    // Replaying the migration — which is what a schema redeploy does — must not
    // engage or release a switch behind the operator who set it.
    expect(LOCKDOWN_MIGRATION).not.toMatch(/update public\.app_runtime_settings\s+set\s+security_lockdown_enabled\s*=\s*(true|false)\s*;/i);
  });

  it('installs no second auth trigger and redefines no existing one', () => {
    // Asserted against what the migration *does*, not what it mentions: the note
    // above the role trigger explains why a fresh signup still works, and names
    // `handle_new_user` to do it.
    expect(LOCKDOWN_MIGRATION).not.toMatch(/create\s+trigger.*on\s+auth\.users/is);
    expect(LOCKDOWN_MIGRATION).not.toMatch(/create\s+or\s+replace\s+function\s+public\.handle_new_user/i);
  });

  it('leaves a new signup able to create its own default role row', () => {
    // A lockdown that refused `role = 'user'` would take account creation down
    // as a side effect of an unrelated control.
    const trigger = LOCKDOWN_MIGRATION.slice(
      LOCKDOWN_MIGRATION.indexOf('function public.enforce_security_lockdown_on_roles()'),
      LOCKDOWN_MIGRATION.indexOf('revoke all on function public.enforce_security_lockdown_on_roles'),
    );
    expect(trigger).toContain("new.role = 'admin'");
    expect(trigger).toContain('old.role is distinct from new.role');
  });

  it('pins every routine´s search_path, so none resolves a name from the caller', () => {
    const routines = LOCKDOWN_MIGRATION.match(/create or replace function public\.\w+/g) ?? [];
    const pinned = LOCKDOWN_MIGRATION.match(/set search_path = ''/g) ?? [];
    expect(pinned.length).toBe(routines.length);
  });
});
