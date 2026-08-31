/**
 * THE OVERVIEW ALERT SWEEP, AGAINST A REAL POSTGRES.
 *
 * ===========================================================================
 * WHAT THIS PROVES THAT `sweep.test.ts` CANNOT
 * ===========================================================================
 * `sweep.test.ts` runs the whole sweep against a Map and asserts that a hit and
 * the rule's `last_fired_at` move together. It has to MODEL that, because the
 * thing that makes it true is a `plpgsql` body:
 *
 *     insert into public.overview_alert_hits ...
 *     update public.overview_alert_rules set last_fired_at = ...
 *
 * in one function, one transaction, both writes or neither. A double that models
 * the pair as atomic proves that the sweep is correct GIVEN an atomic RPC. It
 * cannot prove the RPC is atomic, and it cannot notice if a later migration
 * splits the body in two.
 *
 * Three claims are therefore checked here and nowhere else:
 *
 *   1. every one of the five kinds can be CREATED through
 *      `create_overview_alert_rule` — which is the claim `202608310003` exists
 *      to make true, and which was false for `earnings` before it;
 *   2. after a sweep, every rule that fired has a hit AND a stamp — never a row
 *      with one and not the other, checked as a count over the whole set rather
 *      than per rule, so a half-written pair anywhere fails;
 *   3. a second sweep run immediately after the first writes NOTHING, because
 *      the cooldown reads the stamp the first one left.
 *
 * ===========================================================================
 * WHY THE QUOTES ARE INJECTED AND THE STORE IS NOT
 * ===========================================================================
 * `runOvAlertSweep` takes its quote loader as an argument, so this passes a
 * fixed map instead of `ovAlertSweepQuotes()`. That is deliberate: a provider
 * answering differently on two runs would make the cooldown assertion untestable
 * — a second sweep writing nothing would no longer distinguish "the cooldown
 * held" from "the price moved". The provider is not what is under test.
 *
 * The STORE is real. It is `createOvAlertServiceStore` over a service-role
 * client, which is the exact object `/api/cron/alerts` builds, calling the exact
 * RPC the cron calls.
 *
 * ===========================================================================
 * EVERYTHING IT CREATES, IT OWNS
 * ===========================================================================
 * It makes its own throwaway account rather than borrowing the dev fixture
 * owner, so a failed run cannot leave rules attached to an account somebody else
 * is using. Teardown deletes the rules and hits explicitly and then deletes the
 * user, which would cascade them anyway — belt and braces, because the whole
 * point of this script is that it writes to a database.
 *
 * Teardown runs in a `finally`. A failed assertion still cleans up.
 *
 * ===========================================================================
 * BEFORE THIS CAN RUN: FIVE MIGRATIONS, ON DEV
 * ===========================================================================
 * As of 2026-08-31 the dev project's `schema_migration_log` ends at
 * `202608290003_multi_watchlists.sql`. Five files in the repository are not on
 * it, and this script needs the first four:
 *
 *   202608300001_overview_alerts.sql              the rules table + the writer
 *   202608310001_overview_alert_hits.sql          the hits table + last_fired_at
 *   202608310002_overview_alert_hit_service.sql   the service-role RPC
 *   202608310003_overview_alert_rule_kind_parity  the writer accepts `earnings`
 *   202608310004_purge_account_data_overview...   not needed here; keeps dev
 *                                                 matching the repository
 *
 * Without `202608310003` the `earnings` rule cannot be created and this stops
 * before sweeping, naming that migration. Without `202608310002` the sweep
 * raises on every write.
 *
 * `npm run db:apply` applies all five in filename order and records them. It
 * refuses a production url on its own. `202608020004` stays skipped on dev, as
 * it always has — it schedules pg_cron against the PRODUCTION endpoint.
 *
 *   npm run db:apply                           # apply the five, once
 *   npm run verify:ov-alert-sweep
 *   npm run verify:ov-alert-sweep -- --keep    # leave the rows for inspection
 */
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import {
  ProductionTargetError,
  resolveDevSupabaseTarget,
} from '../src/lib/dev/db-target';
import { createOvAlertServiceStore } from '../src/lib/market-overview/alerts/service-store';
import { runOvAlertSweep } from '../src/lib/market-overview/alerts/run';
import type { OvAlertQuote } from '../src/lib/market-overview/alerts/evaluate';
import { OV_ALERT_KINDS, type OvAlertKind } from '../src/lib/market-overview/alerts/types';
import type { Database } from '../src/types/database';

const LABEL = 'npm run verify:ov-alert-sweep';
const KEEP = process.argv.includes('--keep');

/*
 * THE GUARD, BEFORE ANYTHING ELSE IN THE FILE RUNS.
 *
 * `resolveDevSupabaseTarget` THROWS on a production ref, on `.env.local`'s
 * project, and on any url it cannot confidently read — see `db-target.ts` for
 * why it throws rather than returning a boolean. This script writes and deletes,
 * so it is exactly the caller that guard exists for.
 */
let target: ReturnType<typeof resolveDevSupabaseTarget>;
try {
  target = resolveDevSupabaseTarget(LABEL);
} catch (cause) {
  console.error(cause instanceof ProductionTargetError ? cause.message : cause);
  process.exit(1);
}

const admin = createClient<Database>(target.url, target.serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

/** A symbol nobody trades, so a stray row is obviously this script's. */
const SYMBOL = 'ZZ-SWEEPQA';

/**
 * ONE reading, judged by five rules.
 *
 * A single quote rather than one per kind, because the sweep reads its quote map
 * by SYMBOL: five rules on one symbol is the shape a real reader produces, and
 * it is also the shape that would expose a sweep evaluating the wrong rule
 * against the wrong reading.
 *
 * A rise of 8% to 200, reporting in 3 days.
 */
const QUOTE: OvAlertQuote = { price: 200, changePercent: 8, earningsDays: 3 };

/**
 * A threshold per kind, against {@link QUOTE}.
 *
 * Four of the five are set to pass. `percent_down` is set to a threshold it
 * CANNOT pass, and that is the interesting one — see below.
 */
const THRESHOLD: Readonly<Record<OvAlertKind, number>> = {
  price_above: 150,   // price 200 >= 150            → fires
  price_below: 250,   // price 200 <= 250            → fires
  percent_up: 5,      // change +8 >= +5             → fires
  percent_down: 5,    // +8 is not a fall of 5       → must NOT fire
  earnings: 7,        // reports in 3 days, 3 <= 7   → fires
};

/*
 * `percent_down` cannot match the same reading the other four match: one number
 * cannot be both a rise and a fall. It is created and swept anyway, and asserted
 * NOT to fire.
 *
 * That is the assertion that stops this script passing for the wrong reason. A
 * sweep that fired every enabled rule regardless of direction — or an evaluator
 * comparing a magnitude without its sign — would satisfy every count below if
 * all five were expected to fire. One rule that must stay silent is what makes
 * the other four mean something.
 */
const EXPECTED_TO_FIRE: readonly OvAlertKind[] = [
  'price_above', 'price_below', 'percent_up', 'earnings',
];

interface Created {
  userId: string;
  email: string;
  ruleIds: string[];
}

const failures: string[] = [];
function check(claim: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${claim}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(`${claim}${detail ? ` — ${detail}` : ''}`);
}

/**
 * A throwaway account, signed in.
 *
 * The session is the point. `create_overview_alert_rule` resolves `auth.uid()`
 * and raises 42501 when it is null, so a service-role caller cannot create a
 * rule at all — which means the only way to exercise the real creation path is
 * to hold a real session. Creating the rules with a service-role INSERT instead
 * would skip the function, and the function is half of what is being verified.
 */
async function createSignedInUser() {
  const email = `ov-sweep-qa+${randomUUID().slice(0, 8)}@dev.invalid`;
  const password = `Qa!${randomUUID().slice(0, 20)}A1`;
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (error || !data.user) throw new Error(`could not create the test account: ${error?.message}`);

  const asUser = createClient<Database>(target.url, target.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const signIn = await asUser.auth.signInWithPassword({ email, password });
  if (signIn.error) throw new Error(`could not sign the test account in: ${signIn.error.message}`);

  return { userId: data.user.id, email, asUser };
}

async function main(): Promise<void> {
  console.log(`Target: project ${target.projectRef} (development)`);
  console.log(`Symbol: ${SYMBOL}\n`);

  const created: Created = { userId: '', email: '', ruleIds: [] };

  try {
    const { userId, email, asUser } = await createSignedInUser();
    created.userId = userId;
    created.email = email;
    console.log(`Test account ${userId} (${email})\n`);

    /* ---------------------------------------------------------------- 1 */
    console.log('1. every kind can be created through create_overview_alert_rule');
    for (const kind of OV_ALERT_KINDS) {
      const { data, error } = await asUser.rpc('create_overview_alert_rule', {
        input_symbol: SYMBOL,
        input_kind: kind,
        input_threshold: THRESHOLD[kind],
      });
      if (error) {
        check(`create ${kind}`, false, `${error.code ?? '?'} ${error.message}`);
        continue;
      }
      check(`create ${kind}`, typeof data === 'string' && data.length > 0);
      if (typeof data === 'string') created.ruleIds.push(data);
    }
    if (created.ruleIds.length !== OV_ALERT_KINDS.length) {
      /*
        Stop rather than sweep a partial set. A cooldown assertion over four
        rules when five were expected would pass for the wrong reason.
      */
      throw new Error(
        `only ${created.ruleIds.length}/${OV_ALERT_KINDS.length} rules were created; `
        + 'is 202608310003 applied on this database?',
      );
    }

    const store = createOvAlertServiceStore(admin);
    const quotes = new Map<string, OvAlertQuote>([[SYMBOL, QUOTE]]);

    /* ---------------------------------------------------------------- 2 */
    console.log('\n2. first sweep writes the hit and the stamp together');
    const first = await runOvAlertSweep({ store, loadQuotes: async () => quotes });
    console.log(`   summary: ${JSON.stringify(first)}`);

    check(
      'the sweep reported no per-owner errors',
      first.errors.length === 0,
      first.errors.map((e) => e.message).join(' | '),
    );
    check(
      `it recorded ${EXPECTED_TO_FIRE.length} hits`,
      first.recorded === EXPECTED_TO_FIRE.length,
      `recorded ${first.recorded}, failed ${first.failed}`,
    );

    const afterFirst = await readState(created.ruleIds);
    check(
      'a hit exists for exactly the kinds whose comparison passed',
      sameSet(afterFirst.firedKinds, EXPECTED_TO_FIRE),
      `fired [${afterFirst.firedKinds.join(', ')}]`,
    );
    check(
      'percent_down did not fire on a rising reading',
      !afterFirst.firedKinds.includes('percent_down'),
    );

    /*
      THE ATOMICITY CLAIM, counted over the whole set rather than per rule.

      A rule with a stamp and no hit is an alert silently lost; a hit with no
      stamp is a rule that fires again on every sweep forever. Both are one
      mismatched count away, so both are caught by comparing the two sets.
    */
    check(
      'no rule has a stamp without a hit',
      afterFirst.stampedWithoutHit.length === 0,
      afterFirst.stampedWithoutHit.join(', '),
    );
    check(
      'no hit exists without a stamp on its rule',
      afterFirst.hitWithoutStamp.length === 0,
      afterFirst.hitWithoutStamp.join(', '),
    );
    check(
      'every stamp equals its hit’s observed_at',
      afterFirst.stampMismatches.length === 0,
      afterFirst.stampMismatches.join(', '),
    );

    /* ---------------------------------------------------------------- 3 */
    console.log('\n3. an immediate second sweep is absorbed by the cooldown');
    const second = await runOvAlertSweep({ store, loadQuotes: async () => quotes });
    console.log(`   summary: ${JSON.stringify(second)}`);

    check('it recorded nothing', second.recorded === 0, `recorded ${second.recorded}`);
    check('it failed nothing', second.failed === 0, `failed ${second.failed}`);

    const afterSecond = await readState(created.ruleIds);
    check(
      'the hit count did not move',
      afterSecond.hitCount === afterFirst.hitCount,
      `${afterFirst.hitCount} then ${afterSecond.hitCount}`,
    );
    check(
      'no stamp moved',
      JSON.stringify(afterSecond.stamps) === JSON.stringify(afterFirst.stamps),
    );
  } finally {
    if (KEEP) {
      console.log(`\n--keep: leaving account ${created.userId} and its rows in place.`);
    } else {
      await teardown(created);
    }
  }

  console.log(
    failures.length === 0
      ? '\nPASS — every claim held.'
      : `\nFAILED (${failures.length}):\n  ${failures.join('\n  ')}`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

interface State {
  hitCount: number;
  firedKinds: OvAlertKind[];
  stamps: Record<string, string | null>;
  stampedWithoutHit: string[];
  hitWithoutStamp: string[];
  stampMismatches: string[];
}

/** The two tables, read back and cross-checked against each other. */
async function readState(ruleIds: readonly string[]): Promise<State> {
  const { data: rules, error: rulesError } = await admin
    .from('overview_alert_rules')
    .select('id, kind, last_fired_at')
    .in('id', ruleIds as string[]);
  if (rulesError) throw rulesError;

  const { data: hits, error: hitsError } = await admin
    .from('overview_alert_hits')
    .select('id, rule_id, kind, observed_at')
    .in('rule_id', ruleIds as string[]);
  if (hitsError) throw hitsError;

  const hitByRule = new Map((hits ?? []).map((hit) => [hit.rule_id, hit]));
  const stamps: Record<string, string | null> = {};
  const stampedWithoutHit: string[] = [];
  const hitWithoutStamp: string[] = [];
  const stampMismatches: string[] = [];

  for (const rule of rules ?? []) {
    stamps[rule.id] = rule.last_fired_at;
    const hit = hitByRule.get(rule.id);
    if (rule.last_fired_at && !hit) stampedWithoutHit.push(`${rule.kind}(${rule.id})`);
    if (hit && !rule.last_fired_at) hitWithoutStamp.push(`${rule.kind}(${rule.id})`);
    if (hit && rule.last_fired_at
      && Date.parse(hit.observed_at) !== Date.parse(rule.last_fired_at)) {
      stampMismatches.push(`${rule.kind}: hit ${hit.observed_at} vs stamp ${rule.last_fired_at}`);
    }
  }

  return {
    hitCount: hits?.length ?? 0,
    firedKinds: (hits ?? []).map((hit) => hit.kind as OvAlertKind).sort(),
    stamps,
    stampedWithoutHit,
    hitWithoutStamp,
    stampMismatches,
  };
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join(',') === [...right].sort().join(',');
}

/**
 * Remove everything this run created, loudly.
 *
 * The hits go first, then the rules, then the account — the order they depend
 * in, so a failure at any step leaves a smaller mess rather than an orphan.
 * `deleteUser` would cascade both tables on its own; doing it explicitly means a
 * teardown failure is reported against the table it happened on.
 */
async function teardown(created: Created): Promise<void> {
  if (!created.userId) return;
  console.log('\nteardown');

  if (created.ruleIds.length > 0) {
    const hits = await admin.from('overview_alert_hits').delete()
      .in('rule_id', created.ruleIds);
    console.log(`  hits deleted   ${hits.error ? `FAILED: ${hits.error.message}` : 'ok'}`);

    const rules = await admin.from('overview_alert_rules').delete()
      .in('id', created.ruleIds);
    console.log(`  rules deleted  ${rules.error ? `FAILED: ${rules.error.message}` : `ok (${created.ruleIds.length})`}`);
  }

  const user = await admin.auth.admin.deleteUser(created.userId);
  console.log(`  account deleted ${user.error ? `FAILED: ${user.error.message}` : `ok (${created.userId})`}`);

  /* Proof rather than assumption: nothing of this run's is left behind. */
  const left = await admin.from('overview_alert_rules').delete().eq('symbol', SYMBOL).select('id');
  if (!left.error && (left.data?.length ?? 0) > 0) {
    console.log(`  swept up ${left.data!.length} stray ${SYMBOL} rule(s) from an earlier run`);
  }
}

main().catch((error: unknown) => {
  console.error('\nverify failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
