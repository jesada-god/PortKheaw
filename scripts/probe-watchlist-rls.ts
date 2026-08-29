/**
 * Proves — against a real database, with two real sessions — that one reader
 * cannot see, rename, delete or pin into another reader's watchlist, and that
 * the rules the multi-watchlist migration added actually hold.
 *
 * ===========================================================================
 * WHY THIS IS A PROBE AND NOT A UNIT TEST
 * ===========================================================================
 * Every assertion here is about POSTGRESQL'S behaviour: what the RLS policies
 * admit, what the unique index refuses, and what the `security definer`
 * functions raise. None of that exists in a mocked Supabase client — a test
 * against a fake proves the code sends the query it was written to send, which
 * is exactly the thing that is not in doubt. A migration's security contract can
 * only be verified by the database that enforces it.
 *
 * So this runs against a live project, creates two throwaway users on a
 * reserved-invalid domain, and deletes both in `finally`. It touches no existing
 * account and enumerates nothing.
 *
 * ===========================================================================
 * BEFORE RUNNING IT
 * ===========================================================================
 * `supabase/migrations/202608290003_multi_watchlists.sql` MUST BE APPLIED to
 * the project this points at. Against a database without it, the create/rename/
 * delete checks fail because the functions do not exist — which is a true
 * result about that database and a confusing one to read.
 *
 * It resolves its target through `src/lib/dev/db-target.ts`, which reads
 * `.env.test` and REFUSES to run against production. There is no override.
 *
 *   npm run probe:watchlist-rls
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ProductionTargetError, resolveDevSupabaseTarget } from '../src/lib/dev/db-target';

/*
  The target is resolved and CHECKED before anything is constructed. There is no
  `createClient` above this line, and no url read straight from the environment
  — a guarded script that also keeps an unguarded connection is an unguarded
  script. `db-target.test.ts` asserts that shape by reading this file.
*/
let target;
try {
  target = resolveDevSupabaseTarget('npm run probe:watchlist-rls');
} catch (error) {
  console.error(error instanceof ProductionTargetError ? error.message : error);
  process.exit(1);
}

const { url, anonKey, serviceKey, projectRef } = target;
console.log(`Target: ${url} (project ${projectRef})`);
console.log('');

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

interface Check { name: string; passed: boolean; detail: string }
const checks: Check[] = [];

function record(name: string, passed: boolean, detail: string) {
  checks.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function signedInClient(email: string, password: string): Promise<SupabaseClient> {
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return client;
}

const users = [0, 1].map(() => ({
  email: `portkheaw-rls-probe-${crypto.randomUUID()}@probe.invalid`,
  password: `Probe!${crypto.randomUUID().slice(0, 12)}A1`,
  id: null as string | null,
}));

async function main(): Promise<void> {
  for (const user of users) {
    const created = await admin.auth.admin.createUser({
      email: user.email, password: user.password, email_confirm: true,
    });
    if (created.error) throw created.error;
    user.id = created.data.user!.id;
  }

  const [alice, bob] = await Promise.all(users.map((user) => signedInClient(user.email, user.password)));

  // Each signs in and resolves their own starter list.
  const aliceList = await alice!.rpc('get_or_create_default_watchlist');
  if (aliceList.error) throw aliceList.error;
  const aliceListId = aliceList.data as string;

  const bobList = await bob!.rpc('get_or_create_default_watchlist');
  if (bobList.error) throw bobList.error;
  const bobListId = bobList.data as string;

  record('each account resolves its own list', aliceListId !== bobListId,
    `${aliceListId} vs ${bobListId}`);

  const added = await alice!.from('watchlist_items')
    .insert({ watchlist_id: aliceListId, symbol: 'AAPL' }).select('id').single();
  record("alice can add to her own list", !added.error, added.error?.message ?? 'inserted');

  // ---------------------------------------------------------------------
  // The reads. Another account's rows must be invisible, not merely hidden.
  // ---------------------------------------------------------------------
  const bobReadsAliceList = await bob!.from('watchlists').select('id, name').eq('id', aliceListId);
  record("bob cannot read alice's list row",
    !bobReadsAliceList.error && (bobReadsAliceList.data?.length ?? 0) === 0,
    `${bobReadsAliceList.data?.length ?? 0} rows`);

  const bobReadsAliceItems = await bob!.from('watchlist_items')
    .select('id, symbol').eq('watchlist_id', aliceListId);
  record("bob cannot read alice's symbols",
    !bobReadsAliceItems.error && (bobReadsAliceItems.data?.length ?? 0) === 0,
    `${bobReadsAliceItems.data?.length ?? 0} rows`);

  const bobSelectsEverything = await bob!.from('watchlists').select('id');
  const leaked = (bobSelectsEverything.data ?? []).some((row) => row.id === aliceListId);
  record("an unfiltered select does not leak alice's list", !leaked,
    `${bobSelectsEverything.data?.length ?? 0} rows visible to bob`);

  // ---------------------------------------------------------------------
  // The writes. Refused, and refused without confirming the id exists.
  // ---------------------------------------------------------------------
  const bobWritesAliceItem = await bob!.from('watchlist_items')
    .insert({ watchlist_id: aliceListId, symbol: 'TSLA' }).select('id');
  record("bob cannot insert into alice's list", Boolean(bobWritesAliceItem.error),
    bobWritesAliceItem.error?.code ?? 'INSERT SUCCEEDED');

  const bobRenamesAlice = await bob!.rpc('rename_watchlist', {
    target_watchlist_id: aliceListId, input_name: 'taken over',
  });
  record("bob cannot rename alice's list", Boolean(bobRenamesAlice.error),
    bobRenamesAlice.error?.message ?? 'RENAME SUCCEEDED');

  const bobDeletesAlice = await bob!.rpc('delete_watchlist', { target_watchlist_id: aliceListId });
  record("bob cannot delete alice's list", Boolean(bobDeletesAlice.error),
    bobDeletesAlice.error?.message ?? 'DELETE SUCCEEDED');

  const bobPinsAlice = await bob!.rpc('set_watchlist_item_pinned', {
    target_watchlist_id: aliceListId, input_symbol: 'AAPL', input_pinned: true,
  });
  record("bob cannot pin inside alice's list", Boolean(bobPinsAlice.error),
    bobPinsAlice.error?.message ?? 'PIN SUCCEEDED');

  /*
    The one hole RLS alone would not have closed. `user_settings` is bob's own
    row, so a write to it passes his policies — the ownership of the list he is
    pointing AT has to be checked inside the function, and this is the check.
  */
  const bobPointsOverviewAtAlice = await bob!.rpc('set_overview_watchlist', {
    target_watchlist_id: aliceListId,
  });
  record("bob cannot point his overview at alice's list",
    Boolean(bobPointsOverviewAtAlice.error),
    bobPointsOverviewAtAlice.error?.message ?? 'SELECTION SUCCEEDED');

  // ---------------------------------------------------------------------
  // The rules the migration added, on the caller's OWN lists.
  // ---------------------------------------------------------------------
  const second = await alice!.rpc('create_watchlist', { input_name: 'ระยะยาว' });
  record('alice can create a second list', !second.error, second.error?.message ?? 'created');

  const duplicate = await alice!.rpc('create_watchlist', { input_name: '  ระยะยาว  ' });
  record('a duplicate name is refused, ignoring case and padding',
    duplicate.error?.code === '23505', duplicate.error?.code ?? 'CREATE SUCCEEDED');

  const empty = await alice!.rpc('create_watchlist', { input_name: '   ' });
  record('an empty name is refused', Boolean(empty.error),
    empty.error?.code ?? 'CREATE SUCCEEDED');

  const tooLong = await alice!.rpc('create_watchlist', { input_name: 'ก'.repeat(81) });
  record('a name past the length limit is refused', Boolean(tooLong.error),
    tooLong.error?.code ?? 'CREATE SUCCEEDED');

  const deleteOne = await alice!.rpc('delete_watchlist', { target_watchlist_id: second.data as string });
  record('alice can delete a list while she has two', !deleteOne.error,
    deleteOne.error?.message ?? 'deleted');

  const deleteLast = await alice!.rpc('delete_watchlist', { target_watchlist_id: aliceListId });
  record('the last remaining list cannot be deleted',
    deleteLast.error?.code === '23514', deleteLast.error?.code ?? 'DELETE SUCCEEDED');

  const stillThere = await alice!.from('watchlists').select('id');
  record('alice still has exactly one list afterwards',
    (stillThere.data?.length ?? 0) === 1, `${stillThere.data?.length ?? 0} lists`);
}

main()
  .catch((error) => {
    console.error('\nProbe aborted:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const user of users) {
      if (user.id) await admin.auth.admin.deleteUser(user.id).catch(() => {});
    }
    const failed = checks.filter((check) => !check.passed);
    console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
    if (failed.length > 0) {
      console.log('Failed:', failed.map((check) => check.name).join('; '));
      process.exitCode = 1;
    }
  });
