/**
 * Probes how this Supabase project marks the two facts the password-reset gate
 * depends on, so the gate is written against measured behaviour instead of a
 * guess:
 *
 *   1. the `amr` (Authentication Method References) claim of a session created
 *      from a *recovery* link — the only trustworthy proof that the visitor
 *      arrived through "forgot password" and not through an ordinary login, and
 *   2. the `identities` list on the user, which is what tells a password account
 *      apart from an OAuth-only one.
 *
 * It creates a throwaway user on a reserved-invalid domain, reads the two
 * facts, and deletes the user again in `finally` — nothing is sent by email
 * (the admin `generate_link` endpoint returns the link instead of mailing it)
 * and no existing account is touched or enumerated.
 *
 *   npm run probe:auth-recovery
 */
import { createClient } from '@supabase/supabase-js';
import { assertNotProduction } from '../src/lib/dev/db-target';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
  return value;
}

const url = required('NEXT_PUBLIC_SUPABASE_URL');
const anonKey = required('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
const serviceKey = required('SUPABASE_SERVICE_ROLE_KEY');

/*
 * It creates a throwaway user, so it may not run against production — even
 * though it deletes it again, and even though the account is on a
 * reserved-invalid domain. "It cleans up afterwards" is a promise about the
 * happy path; a killed process does not keep it, and the account it leaves is
 * a real one in a real project.
 *
 * This one has nothing to purge before the delete: it seeds no portfolio, so
 * the RESTRICT chain in `scripts/qa/qa-accounts.mjs` cannot reach it.
 */
assertNotProduction(url, 'probe:auth-recovery');

/** Decodes a JWT payload without verifying it — this is a diagnostic, not a gate. */
function payloadOf(accessToken: string): Record<string, unknown> {
  const [, payload] = accessToken.split('.');
  return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const probeEmail = `portkheaw-auth-probe-${crypto.randomUUID()}@probe.invalid`;
const probePassword = `Probe!${crypto.randomUUID().slice(0, 12)}A1`;
let probeUserId: string | null = null;

async function main(): Promise<void> {
try {
  const created = await admin.auth.admin.createUser({
    email: probeEmail,
    password: probePassword,
    email_confirm: true,
  });
  if (created.error || !created.data.user) throw new Error(`createUser failed: ${created.error?.message}`);
  probeUserId = created.data.user.id;
  console.log('identities (password account):', created.data.user.identities?.map((identity) => identity.provider));

  const link = await admin.auth.admin.generateLink({ type: 'recovery', email: probeEmail });
  if (link.error || !link.data.properties) throw new Error(`generateLink failed: ${link.error?.message}`);

  const anon = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const verified = await anon.auth.verifyOtp({
    type: 'recovery',
    token_hash: link.data.properties.hashed_token,
  });
  if (verified.error || !verified.data.session) throw new Error(`verifyOtp failed: ${verified.error?.message}`);

  const claims = payloadOf(verified.data.session.access_token);
  console.log('recovery session amr:', JSON.stringify(claims.amr));
  console.log('recovery session aal:', claims.aal);
  console.log('recovery session identities:', verified.data.session.user.identities?.map((identity) => identity.provider));

  const refreshed = await anon.auth.refreshSession(verified.data.session);
  if (refreshed.data.session) {
    console.log('after refresh amr:', JSON.stringify(payloadOf(refreshed.data.session.access_token).amr));
  }

  const password = await anon.auth.signInWithPassword({ email: probeEmail, password: 'wrong-on-purpose' });
  console.log('invalid password error code:', password.error?.code, '| status:', password.error?.status);

  // The ordinary-session control: whatever the reset gate accepts, it must not
  // accept this.
  const passwordSession = await anon.auth.signInWithPassword({ email: probeEmail, password: probePassword });
  console.log(
    'password sign-in amr:',
    passwordSession.data.session ? JSON.stringify(payloadOf(passwordSession.data.session.access_token).amr) : passwordSession.error?.code,
  );

  // A second sign-up with an address that already exists must never mint a
  // second user — this is the one-email-one-account guarantee, measured.
  const duplicate = await anon.auth.signUp({ email: probeEmail, password: `Other!${crypto.randomUUID().slice(0, 10)}A1` });
  console.log(
    'duplicate signUp -> error:', duplicate.error?.code ?? 'none',
    '| userId matches existing:', duplicate.data.user?.id === probeUserId,
    '| identities:', JSON.stringify(duplicate.data.user?.identities?.map((identity) => identity.provider) ?? null),
    '| session:', Boolean(duplicate.data.session),
  );
} finally {
  if (probeUserId) {
    const deleted = await admin.auth.admin.deleteUser(probeUserId);
    console.log('probe user deleted:', !deleted.error, deleted.error?.message ?? '');
  }
}
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
