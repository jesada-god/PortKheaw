import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isProtectedPath } from '@/src/lib/auth/paths';
import { BETA_CAP_BANDS, betaStages } from '@/src/lib/beta/beta-stages';
import { betaFunnelEventKeys } from '@/src/lib/beta/funnel-events';
import { rateLimitScopes } from '@/src/lib/security/rate-limit';
import { allowedContextKeys } from '@/src/lib/monitoring/sanitize';

/**
 * The boundaries this phase is built on, asserted as source facts.
 *
 * A page or an action could be edited into checking the operator role in the
 * browser, offering a cohort size the database refuses, or recording a funnel key
 * the schema rejects — and every one of those failures is invisible until
 * somebody exercises it in production. These tests read the code and the
 * migration and check that the two still agree.
 */

const root = process.cwd();

function source(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

const migration = source('supabase/migrations/202608050007_admin_beta_and_production_safety.sql');

/**
 * Every page under `/admin`. The glob is deliberate rather than a hand-kept
 * list: a page added tomorrow joins this set by existing, and fails the guard
 * assertion below until somebody gates it.
 */
const ADMIN_PAGES = globSync('app/admin/**/page.tsx', { cwd: root })
  .map((path) => path.replace(/\\/g, '/'))
  .sort();

/** Operator mutations that live outside `/admin`, where no console gate reaches. */
const OFFSITE_ADMIN_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  'app/support/actions.ts': ['adminReplyToTicketAction', 'adminSetTicketStatusAction'],
  'app/settings/refunds/actions.ts': [
    'adminReplyToRefundRequestAction', 'adminSetRefundStatusAction',
  ],
};

describe('every operator route is gated on the server', () => {
  it('finds every operator page, so none can be added unguarded', () => {
    expect(ADMIN_PAGES).toEqual([
      'app/admin/beta/page.tsx',
      'app/admin/billing/page.tsx',
      'app/admin/page.tsx',
      'app/admin/refunds/[id]/page.tsx',
      'app/admin/refunds/page.tsx',
      'app/admin/support/[id]/page.tsx',
      'app/admin/support/page.tsx',
      'app/admin/system/page.tsx',
    ]);
  });

  it('keeps the gate in the layout that covers the whole console', () => {
    const layout = source('app/admin/layout.tsx');
    expect(layout).toContain('requireAdminPage()');
  });

  /*
   * The incident this file now exists to prevent a repeat of.
   *
   * A layout and the page beneath it render *concurrently* in the App Router. A
   * layout that calls `notFound()` therefore does not stop the page: by the time
   * it refuses, the console has queried its projections and built its tree, and
   * that tree ships in the response beside the 404 marker under a 200 — readable
   * by anybody who fetches the URL without running the client runtime.
   *
   * The gate has to be inside the thing being guarded, and it has to run before
   * the page reads anything. Both halves are asserted: the call is present, and
   * it is the first statement in the component.
   */
  it('gates every operator page inside the page itself, before it reads anything', () => {
    for (const page of ADMIN_PAGES) {
      const code = source(page);
      expect(`${page}: ${code.includes('requireAdminPage()')}`).toBe(`${page}: true`);

      const gate = 'await requireAdminPage();';
      const body = code.slice(code.indexOf('export default async function'));
      const firstAwait = body.indexOf('await ');
      expect(`${page}: ${body.slice(firstAwait, firstAwait + gate.length)}`)
        .toBe(`${page}: ${gate}`);
    }
  });

  /*
   * A server action is reachable by its identifier alone. It does not run under
   * the layout of the page whose form submits it, and these four live outside
   * `/admin` entirely, so neither the console gate nor the middleware filter is
   * between a caller and the function.
   */
  it('gates every operator action that lives outside the console', () => {
    for (const [file, actions] of Object.entries(OFFSITE_ADMIN_ACTIONS)) {
      const code = source(file);
      for (const action of actions) {
        const body = code.slice(code.indexOf(`export async function ${action}(`));
        const declaration = body.slice(0, body.indexOf('\n}\n'));
        expect(`${action}: ${declaration.includes('await requireAdmin();')}`)
          .toBe(`${action}: true`);
      }
    }
  });

  it('refuses a non-operator action with a code of its own, never a success', () => {
    for (const file of Object.keys(OFFSITE_ADMIN_ACTIONS)) {
      expect(source(file)).toContain("refusal(isAdminRequiredError(cause) ? 'FORBIDDEN' : 'UNAVAILABLE')");
    }
  });

  it('bounces a signed-out visitor from every operator URL', () => {
    for (const path of ['/admin', '/admin/billing', '/admin/support', '/admin/refunds', '/admin/beta']) {
      expect(isProtectedPath(path)).toBe(true);
    }
  });

  /*
   * Middleware is a filter, not the boundary — but it is the only layer that can
   * refuse before a renderer exists, which is what keeps console markup off the
   * wire entirely. It must fail closed, and it must not cache an answer that is
   * per-reader.
   */
  it('refuses the console at the edge, fail closed and uncached', () => {
    expect(source('middleware.ts')).toContain('isAdminConsolePath(pathname) && !(await isPlatformAdminForEdge(supabase))');
    const edge = source('src/lib/admin/admin-edge.ts');
    expect(edge).toContain("client.rpc('get_my_account_access')");
    expect(edge).toContain('if (error) return false;');
    expect(edge).toContain('catch {\n    return false;\n  }');
    // No module-scope memo: a shared positive would be one reader's role reused.
    expect(edge).not.toMatch(/^let |^const cache/m);
  });

  it('never lets a client-supplied role, id or preview decide the answer', () => {
    for (const file of [
      'src/lib/admin/admin-guard.ts',
      'src/lib/admin/admin-edge.ts',
      'app/admin/layout.tsx',
    ]) {
      const code = source(file);
      expect(code).not.toMatch(/searchParams|formData|headers\(\)|cookies\(\)|localStorage/);
    }
  });

  it('renders every operator page on the server, never as a static shell', () => {
    for (const page of ADMIN_PAGES) {
      expect(source(page)).toContain("export const dynamic = 'force-dynamic'");
    }
  });

  it('never decides authorization in a client component', () => {
    for (const file of [
      'src/components/admin/BetaStageControl.tsx',
      'src/components/admin/BetaInviteControls.tsx',
      'src/components/admin/StatCard.tsx',
      'src/components/admin/TicketStatusControl.tsx',
      'src/components/admin/RefundDecisionControl.tsx',
    ]) {
      const code = source(file);
      expect(code).not.toMatch(/isAdmin|requireAdmin|is_platform_admin|user_roles/);
    }
  });

  it('checks the operator role inside the database for every routine it added', () => {
    const routines = [
      'admin_set_beta_stage', 'admin_add_beta_invite', 'admin_revoke_beta_invite',
      'admin_beta_program_state', 'admin_beta_invites', 'admin_beta_report',
      'admin_beta_feature_report', 'admin_dashboard_overview',
      'admin_recent_billing_activity', 'admin_audit_feed',
    ];
    for (const routine of routines) {
      const body = migration.slice(migration.indexOf(`function public.${routine}(`));
      expect(body).toContain('if not public.is_platform_admin(requesting_user) then');
      expect(body.slice(0, body.indexOf('$$;'))).toContain("raise exception 'ADMIN_REQUIRED'");
    }
  });

  it('grants no client role a seat at any new table', () => {
    for (const table of [
      'admin_audit_events', 'beta_program_state', 'beta_invites',
      'beta_funnel_events', 'rate_limit_counters',
    ]) {
      expect(migration).toContain(`alter table public.${table} enable row level security`);
      expect(migration).toContain(`revoke all on table public.${table} from anon, authenticated`);
      expect(migration).not.toContain(`grant select on table public.${table}`);
      expect(migration).not.toContain(`grant insert on table public.${table}`);
    }
  });
});

describe('the migration is additive and forward-only', () => {
  it('drops no table, column, policy or row belonging to an earlier phase', () => {
    expect(migration).not.toMatch(/drop\s+table/i);
    expect(migration).not.toMatch(/drop\s+column/i);
    expect(migration).not.toMatch(/drop\s+schema/i);
    expect(migration).not.toMatch(/truncate/i);
    expect(migration).not.toMatch(/delete\s+from\s+public\.(?!rate_limit_counters)/i);
    // The only `drop` allowed is the idempotent re-creation of this phase's own
    // trigger, which is how the file stays replayable.
    const drops = migration.match(/drop\s+\w+/gi) ?? [];
    expect(drops.every((statement) => /drop\s+(trigger|policy)/i.test(statement))).toBe(true);
  });

  it('installs no second auth trigger', () => {
    expect(migration).not.toContain('handle_new_user');
    expect(migration).not.toMatch(/create\s+trigger.*on\s+auth\.users/is);
  });

  it('indexes what it filters and orders by', () => {
    for (const index of [
      'admin_audit_events_created_idx',
      'admin_audit_events_target_idx',
      'beta_funnel_events_key_time_idx',
      'beta_funnel_events_stage_key_idx',
      'beta_funnel_events_feature_idx',
      'beta_invites_active_idx',
      'rate_limit_counters_expiry_idx',
    ]) {
      expect(migration).toContain(index);
    }
  });
});

describe('the rollout never opens itself', () => {
  it('defaults a fresh install to closed', () => {
    expect(migration).toContain("stage text not null default 'closed'");
  });

  it('preserves a running stage across a replay of the migration', () => {
    // `do nothing` is what makes a redeploy of the schema a no-op for a live
    // programme — and what stops `enforced_from` being re-stamped, which would
    // start gating accounts that were never meant to be gated.
    expect(migration).toContain('insert into public.beta_program_state (singleton) values (true)');
    expect(migration).toContain('on conflict (singleton) do nothing');
  });

  it('has exactly one writer for the stage, and it is operator-only', () => {
    const writes = migration.match(/update\s+public\.beta_program_state\s+set/gi) ?? [];
    expect(writes).toHaveLength(1);
    // No scheduler, no expiry, no "graduate after N days".
    expect(migration).not.toMatch(/cron\.schedule/i);
  });

  it('requires an explicit confirmation on the server, not only in the browser', () => {
    const actions = source('app/admin/beta/actions.ts');
    expect(actions).toContain("formData.get('confirm') !== 'yes'");
    expect(actions).toContain('requireAdmin()');
  });

  it('agrees with the database about every cohort band', () => {
    for (const stage of betaStages) {
      const band = BETA_CAP_BANDS[stage];
      expect(migration).toContain(`('${stage}', ${band.min}, ${band.max})`);
    }
  });

  it('enforces the cap inside the transaction that adds an invite', () => {
    const routine = migration.slice(migration.indexOf('function public.admin_add_beta_invite('));
    // A count taken outside the lock is a count two operators can both pass.
    expect(routine).toContain('perform 1 from public.beta_program_state where singleton for update');
    expect(routine).toContain("return query select null::uuid, 'cap_reached'::text");
  });
});

describe('the funnel stores nothing personal', () => {
  it('accepts exactly the ten approved keys, in the schema itself', () => {
    const constraint = migration.slice(
      migration.indexOf('beta_funnel_events_key_check'),
      migration.indexOf('beta_funnel_events_stage_check'),
    );
    for (const key of betaFunnelEventKeys) {
      expect(constraint).toContain(`'${key}'`);
    }
  });

  it('has no column that could carry free text, an amount or a provider id', () => {
    const table = migration.slice(
      migration.indexOf('create table if not exists public.beta_funnel_events'),
      migration.indexOf('create unique index if not exists beta_funnel_events_dedupe_key'),
    );
    for (const forbidden of ['amount', 'note', 'message', 'body', 'content', 'email', 'ip_', 'user_agent', 'invoice_id', 'customer_id']) {
      expect(table).not.toContain(forbidden);
    }
  });

  it('stamps the account, the clock and the stage in the database, not from the caller', () => {
    const routine = migration.slice(migration.indexOf('function public.record_beta_funnel_event('));
    expect(routine).toContain('requesting_user uuid := (select auth.uid())');
    expect(routine).toContain("bangkok_date date := (observed at time zone 'Asia/Bangkok')::date");
    expect(routine).toContain('select state.stage into current_stage');
    // The account id is prepended here, so a caller cannot compose a scope that
    // collides with somebody else's row and suppress their event.
    expect(routine).toContain("coalesce(requesting_user::text, 'anon') || ':' || input_event_key");
  });

  it('lands once, by a unique index rather than by convention', () => {
    expect(migration).toContain('create unique index if not exists beta_funnel_events_dedupe_key');
    expect(migration).toContain('on conflict (dedupe_key) do nothing');
  });

  it('clears the account link when an account is deleted', () => {
    expect(migration).toContain('user_id uuid references auth.users(id) on delete set null');
  });

  it('lets a browser report intent but never money', () => {
    const action = source('app/settings/subscription/funnel-actions.ts');
    // The allowlist is the whole gate on a client-supplied event name.
    expect(action).toContain('isClientRecordableEventKey(event)');
    expect(action).toContain("scope: 'funnel.record'");
    // It can reach nothing but the funnel recorder.
    expect(action).not.toMatch(/apply_billing|user_subscriptions|set_.*tier|entitlement/i);
  });

  it('reads the checkout return URL only where it can grant nothing', () => {
    // The subscription page is contractually forbidden from reading a query
    // parameter — `billing-security.contract.test.ts` asserts it. The one
    // component that does read it renders nothing and holds no billing state.
    const component = source('src/components/subscription/CheckoutReturnFunnel.tsx');
    expect(component).toContain('recordClientFunnelEventAction');
    expect(component).toContain('return null;');
    // It imports one thing, and that thing can only insert a telemetry row.
    const imports = component.match(/^import .*$/gm) ?? [];
    expect(imports.filter((line) => line.includes('@/'))).toEqual([
      "import { recordClientFunnelEventAction } from '@/app/settings/subscription/funnel-actions';",
    ]);
    expect(component).not.toMatch(/startCheckoutAction|setTier|setPlan|useEntitlement/);
  });
});

describe('the operator audit is append-only', () => {
  it('refuses every update and delete unconditionally', () => {
    // Phase 5's `reject_audit_mutation` is support-specific — it reads
    // `old.ticket_id` — so this table needs its own refusal.
    expect(migration).toContain('function public.reject_admin_audit_mutation()');
    expect(migration).toContain('before update or delete on public.admin_audit_events');
    expect(migration).toContain('execute function public.reject_admin_audit_mutation()');
  });

  it('records an actor, an action, a target, both summaries and a correlation id', () => {
    for (const column of ['actor_user_id', 'action', 'target_type', 'target_ref', 'before_summary', 'after_summary', 'request_id', 'created_at']) {
      expect(migration).toContain(column);
    }
  });

  it('writes an audit row in the same transaction as every operator mutation', () => {
    for (const routine of ['admin_set_beta_stage', 'admin_add_beta_invite', 'admin_revoke_beta_invite']) {
      const body = migration.slice(
        migration.indexOf(`function public.${routine}(`),
        migration.indexOf(`revoke all on function public.${routine}`),
      );
      expect(body).toContain('perform public.record_admin_audit_event(');
    }
  });

  it('masks the mailbox before it enters an audit row', () => {
    // An audit log outlives the record it describes.
    const routine = migration.slice(migration.indexOf('function public.admin_add_beta_invite('));
    expect(routine).toContain("'emailMask'");
    expect(routine).not.toContain("jsonb_build_object('email', normalized)");
  });

  it('reads ticket and refund decisions in the same feed', () => {
    const feed = migration.slice(migration.indexOf('function public.admin_audit_feed('));
    expect(feed).toContain('from public.support_audit_events as event');
    // A reader replying to their own ticket is not an administrative action.
    expect(feed).toContain("where event.actor_role = 'admin'");
  });
});

describe('rate limiting', () => {
  it('bounds every money path and every operator mutation', () => {
    const checkout = source('app/settings/subscription/billing-actions.ts');
    expect(checkout).toContain("withinRateLimit(client, 'checkout.start'");
    expect(checkout).toContain("withinRateLimit(client, 'checkout.promptpay-renewal'");
    expect(checkout).toContain("withinRateLimit(client, 'billing.portal'");

    const betaActions = source('app/admin/beta/actions.ts');
    expect(betaActions).toContain("authorizeAndBound('admin.mutation')");

    for (const file of ['app/support/actions.ts', 'app/settings/refunds/actions.ts']) {
      expect(source(file)).toContain("scope: 'admin.mutation'");
    }

    for (const page of ['app/admin/page.tsx', 'app/admin/billing/page.tsx']) {
      expect(source(page)).toContain('withinAdminSearchLimit');
    }
  });

  it('leaves the inbound webhook unbounded, so provider retries are never dropped', () => {
    const webhook = source('app/api/billing/webhook/route.ts');
    expect(webhook).not.toContain('consumeRateLimit');
    expect(webhook).not.toContain('rate-limit');
    expect(rateLimitScopes.some((scope) => scope.includes('webhook'))).toBe(false);
  });

  it('keeps the reader-facing support and refund limits where they already are', () => {
    // Phase 5 enforces these inside the routines, which holds for every caller
    // rather than only for the one that goes through a server action. Adding a
    // second layer here would be duplication, not defence.
    const operations = source('supabase/migrations/202608050003_operations_support_and_trust.sql');
    for (const routine of ['create_support_ticket', 'create_refund_request', 'reply_to_my_support_ticket']) {
      const body = operations.slice(operations.indexOf(`function public.${routine}(`));
      expect(body.slice(0, body.indexOf('$$;'))).toContain("interval '24 hours'");
    }
  });

  it('keys the limiter on a digest, never on a raw address', () => {
    const limiter = source('src/lib/security/rate-limit.ts');
    expect(limiter).toContain("createHash('sha256')");
    expect(limiter).toContain("headers.get('x-forwarded-for')");
    expect(migration).toContain('rate_limit_counters_key_check check (char_length(bucket_key) between 16 and 128)');
  });
});

describe('monitoring and readiness', () => {
  it('captures the four failures nobody is watching a log for', () => {
    expect(source('app/settings/subscription/billing-actions.ts')).toContain("scope: 'billing.checkout'");
    expect(source('app/api/billing/webhook/route.ts')).toContain("scope: 'billing.webhook.dead-letter'");
    expect(source('src/lib/alerts/background.ts')).toContain("scope: 'billing.reconciliation'");
    expect(source('src/lib/alerts/background.ts')).toContain("scope: 'scheduler.background-run'");
  });

  it('never blocks release on a missing provider', () => {
    const reporter = source('src/lib/monitoring/report.ts');
    // With no DSN the reporter still runs and still sanitizes.
    expect(reporter).toContain('if (!target) return;');
    expect(allowedContextKeys.length).toBeGreaterThan(0);
  });

  it('keeps readiness coarse in the database as well as in the route', () => {
    const readiness = migration.slice(migration.indexOf('function public.platform_readiness('));
    expect(readiness).toContain('returns table (database_ready boolean, scheduler_status text)');
    // No timestamp, count or error crosses the boundary.
    expect(readiness).not.toContain('completed_at,');
    // `billingConfigResult()` knows which variables are absent and names them
    // for the server log. The route must never read that field.
    const route = source('app/api/health/route.ts');
    expect(route).not.toContain('.missing');
    expect(route).not.toContain('.reason');
  });
});
