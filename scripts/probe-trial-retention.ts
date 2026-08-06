/**
 * Is the trial ledger healthy, and is anything stuck?
 *
 * Strictly read-only. It resolves the keyring from the local environment, calls
 * three `stable` routines, and reads one table's grants. It writes nothing,
 * deletes nothing and never touches an account, so it is safe to run against
 * production as often as you like.
 *
 * What it answers:
 *
 *   * which key versions this environment can derive, and which one is active;
 *   * whether the ledger holds a version no key can compute — the one condition
 *     that silently refuses every trial, and the reason a retired key has to be
 *     put back rather than waited out;
 *   * whether retention enforcement is on, when the sweep last ran, and how many
 *     rows are due;
 *   * every account deletion in flight, its state, and whether it is stuck;
 *   * that a browser key still cannot read the ledger.
 *
 *   npm run probe:trial-retention
 *   npm run probe:trial-retention -- --stuck-after=15min
 *
 * It prints counts, versions and account ids. It never prints a key or a digest —
 * neither does the database side, which has nowhere to put one.
 */

import {
  resolveTrialIdentityKeyring,
  TRIAL_IDENTITY_RECOMMENDED_SECRET_LENGTH,
} from '../src/lib/trial-identity/keyring';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

const stuckAfter = (() => {
  const flag = process.argv.find((argument) => argument.startsWith('--stuck-after='));
  return flag ? flag.slice('--stuck-after='.length) : '1 hour';
})();

interface Check { name: string; ok: boolean; detail: string }

async function rpc<T>(name: string, body: unknown): Promise<{ ok: boolean; status: number; rows: T[]; text: string }> {
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const text = await response.text();
  let rows: T[] = [];
  try {
    const parsed: unknown = JSON.parse(text);
    rows = Array.isArray(parsed) ? parsed as T[] : [parsed as T];
  } catch {
    rows = [];
  }
  return { ok: response.ok, status: response.status, rows, text };
}

interface RetentionStatus {
  enforcement_enabled: boolean;
  batch_limit: number;
  legal_signed_off_at: string | null;
  total_claims: number;
  due_now: number;
  held_now: number;
  held_by_live_account: number;
  qa_claims: number;
  distinct_versions: number[] | null;
  scheduled: boolean;
  last_run_at: string | null;
  last_run_mode: string | null;
  last_run_deleted: number | null;
}

interface DeletionRow {
  user_id: string;
  state: string;
  stage: string | null;
  stuck: boolean;
  residual_rows: number;
  auth_user_exists: boolean;
  age: string | null;
}

/** The keyring, from this environment. Versions and health, never a key. */
function keyringCheck(): { check: Check; supported: number[] } {
  const keyring = resolveTrialIdentityKeyring(process.env as Record<string, unknown>);
  if (!keyring.ok) {
    return {
      check: { name: 'trial identity keyring', ok: false, detail: `${keyring.reason} — ${keyring.message}` },
      supported: [],
    };
  }
  const weak = keyring.weakVersions.length > 0
    ? `; weak (< ${TRIAL_IDENTITY_RECOMMENDED_SECRET_LENGTH} chars): V${keyring.weakVersions.join(', V')}`
    : '';
  return {
    check: {
      name: 'trial identity keyring',
      ok: true,
      detail: `active V${keyring.activeVersion}, reads V${keyring.supportedVersions.join(', V')}${weak}`,
    },
    supported: keyring.supportedVersions,
  };
}

/** A browser key must not be able to read the ledger, the flag or the audit. */
async function closedToBrowsers(table: string): Promise<Check> {
  const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!publishable) {
    return { name: `${table} closed to anon key`, ok: false, detail: 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY not set' };
  }
  const response = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, {
    headers: { apikey: publishable, Authorization: `Bearer ${publishable}` },
  });
  const body = await response.text();
  const readable = response.ok && body.trim() !== '[]';
  return {
    name: `${table} closed to anon key`,
    ok: !readable,
    detail: readable ? `LEAK — HTTP ${response.status} ${body.slice(0, 80)}` : `HTTP ${response.status}, no rows`,
  };
}

async function main() {
  const checks: Check[] = [];
  const { check: keyring, supported } = keyringCheck();
  checks.push(keyring);

  const status = await rpc<RetentionStatus>('trial_retention_status', {});
  if (!status.ok) {
    checks.push({
      name: 'trial_retention_status',
      ok: false,
      detail: status.text.includes('PGRST202')
        ? 'not found — migration 202608060003 not applied'
        : `HTTP ${status.status}`,
    });
  } else {
    const row = status.rows[0];
    const stored = row?.distinct_versions ?? [];
    const unsupported = stored.filter((version) => !supported.includes(version));

    checks.push({
      name: 'stored key versions',
      // The one condition that refuses every trial while looking like nothing is
      // wrong. Reported as a failure whenever a stored version has no key here.
      ok: unsupported.length === 0,
      detail: unsupported.length === 0
        ? `ledger holds V${stored.length ? stored.join(', V') : '—'}, all derivable`
        : `UNSUPPORTED V${unsupported.join(', V')} stored — restore that key or every trial is refused`,
    });

    checks.push({
      name: 'retention enforcement',
      // Off is the expected, correct state until legal sign-off, so this is a
      // status line rather than a failure either way.
      ok: true,
      detail: row.enforcement_enabled
        ? `ENABLED, batch ${row.batch_limit}, signed off ${row.legal_signed_off_at ?? 'NOT RECORDED'}`
        : `disabled (awaiting legal sign-off), batch ${row.batch_limit}`,
    });
    checks.push({
      name: 'retention sweep schedule',
      ok: row.scheduled,
      detail: row.scheduled
        ? `scheduled; last run ${row.last_run_at ?? 'never'} (${row.last_run_mode ?? '—'}, deleted ${row.last_run_deleted ?? 0})`
        : 'not scheduled — pg_cron job portkheaw-trial-retention is absent',
    });
    checks.push({
      name: 'claims',
      ok: true,
      detail: `${row.total_claims} total, ${row.due_now} due, ${row.held_now} on legal hold, `
        + `${row.held_by_live_account} due but held by a live account, ${row.qa_claims} from QA`,
    });
  }

  const deletions = await rpc<DeletionRow>('account_deletion_report', { input_stuck_after: stuckAfter });
  if (!deletions.ok) {
    checks.push({
      name: 'account_deletion_report',
      ok: false,
      detail: deletions.text.includes('PGRST202')
        ? 'not found — migration 202608060003 not applied'
        : `HTTP ${deletions.status}`,
    });
  } else {
    const rows = deletions.rows.filter((row) => typeof row?.user_id === 'string');
    const stuck = rows.filter((row) => row.stuck);
    checks.push({
      name: 'account deletions in flight',
      ok: stuck.length === 0,
      detail: rows.length === 0
        ? 'none'
        : `${rows.length} in flight, ${stuck.length} stuck beyond ${stuckAfter}`,
    });
    for (const row of rows) {
      console.info(
        `      ${row.stuck ? 'STUCK' : 'in flight'}  ${row.user_id}  state=${row.state}`
        + `  stage=${row.stage ?? '—'}  residual_rows=${row.residual_rows}`
        + `  auth_user=${row.auth_user_exists ? 'present' : 'gone'}  age=${row.age ?? '—'}`,
      );
    }
  }

  for (const table of ['trial_identity_claims', 'trial_retention_config', 'trial_retention_runs']) {
    checks.push(await closedToBrowsers(table));
  }

  for (const check of checks) {
    console.info(`${check.ok ? 'ok  ' : 'FAIL'}  ${check.name} — ${check.detail}`);
  }

  const failed = checks.filter((check) => !check.ok);
  console.info(failed.length === 0
    ? '\nhealthy: every stored key version is derivable, nothing is stuck, and the ledger is closed to browsers.'
    : `\nattention: ${failed.length} check(s) need action.`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error('probe failed:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
});
