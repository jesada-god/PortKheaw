/**
 * Is the account-deletion and trial-identity release ready to deploy?
 *
 * Strictly read-only. It calls one `stable` routine and reads two tables' row
 * counts; it writes nothing, deletes nothing, and never touches an account. Safe
 * to run against production as many times as you like, before or after the
 * deploy.
 *
 * What it cannot check is the Vercel environment: a running deployment does not
 * expose its own variables, and it should not. That one is proved instead by the
 * Production QA trial actually being granted — a deployment with no
 * `TRIAL_IDENTITY_HMAC_SECRET` refuses every trial by design, so a granted trial
 * *is* the proof the secret is set.
 *
 *   npm run probe:account-deletion
 */

import { resolveTrialIdentityKeyring } from '../src/lib/trial-identity/keyring';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}

const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function rpcExists(name: string, body: unknown): Promise<Check> {
  const response = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const text = await response.text();
  if (response.status === 404 || text.includes('PGRST202')) {
    return { name: `rpc ${name}`, ok: false, detail: 'not found — migration not applied' };
  }
  return { name: `rpc ${name}`, ok: response.ok, detail: response.ok ? `returns ${text.trim()}` : `HTTP ${response.status}` };
}

async function tableExists(table: string): Promise<Check> {
  const response = await fetch(`${url}/rest/v1/${table}?select=*&limit=0`, {
    headers: { ...headers, Prefer: 'count=exact' },
  });
  if (!response.ok) {
    return { name: `table ${table}`, ok: false, detail: `HTTP ${response.status} — migration not applied` };
  }
  const range = response.headers.get('content-range') ?? '';
  return { name: `table ${table}`, ok: true, detail: `${range.split('/')[1] ?? '?'} rows` };
}

/** A browser key must not be able to read the ledger. */
async function ledgerIsClosedToBrowsers(): Promise<Check> {
  const publishable = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!publishable) {
    return { name: 'ledger closed to anon key', ok: false, detail: 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY not set' };
  }
  const response = await fetch(`${url}/rest/v1/trial_identity_claims?select=id&limit=1`, {
    headers: { apikey: publishable, Authorization: `Bearer ${publishable}` },
  });
  const body = await response.text();
  // Either a permission error or an empty result under a policy-less RLS table.
  const readable = response.ok && body.trim() !== '[]';
  return {
    name: 'ledger closed to anon key',
    ok: !readable,
    detail: readable ? `LEAK — HTTP ${response.status} ${body.slice(0, 80)}` : `HTTP ${response.status}, no rows`,
  };
}

/**
 * The trial keys, as the application resolves them.
 *
 * Resolved through the real keyring rather than by reading one variable, so this
 * reports the same answer the running deployment would — including the failures
 * that take the feature down, such as an active version whose key is missing. It
 * prints versions and never a key or its length.
 */
function keyringCheck(): Check {
  const keyring = resolveTrialIdentityKeyring(process.env as Record<string, unknown>);
  if (!keyring.ok) {
    return { name: 'trial identity keyring (local)', ok: false, detail: `${keyring.reason} — ${keyring.message}` };
  }
  return {
    name: 'trial identity keyring (local)',
    ok: true,
    detail: `active V${keyring.activeVersion}, reads V${keyring.supportedVersions.join(', V')}`,
  };
}

async function main() {
  const checks: Check[] = [
    await rpcExists('trial_identity_is_claimed', { input_identities: [] }),
    await tableExists('trial_identity_claims'),
    await tableExists('account_lifecycle'),
    await ledgerIsClosedToBrowsers(),
    keyringCheck(),
  ];

  for (const check of checks) {
    console.info(`${check.ok ? 'ok  ' : 'FAIL'}  ${check.name} — ${check.detail}`);
  }

  const failed = checks.filter((check) => !check.ok);
  console.info(failed.length === 0
    ? '\nready: migration applied and the ledger is not readable by a browser key.'
    : `\nnot ready: ${failed.length} check(s) failed.`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error('probe failed:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
});
