# Migration state

What is known about which migrations production has run, and what is not
knowable at all. This file records the state; it does not propose changes to it.

Last confirmed **2026-09-20** — that is the date of the PostgREST probe every
`VERIFIED:` header cites, and `supabase/migration-order.test.ts` requires this
date and those to agree. The corrections below it dated 2026-09-03 are
reconciliations of stale prose against those headers, not new probes.

The 2026-09-20 probe re-resolved every relation and column the applied headers
name — `market_signal_history.raw_state`, `options_signal_history`,
`daily_snapshot`, `label_history`, `watchlists`, `watchlist_items.pinned`,
`user_settings.overview_watchlist_id`, `overview_alert_rules.last_fired_at`,
`overview_alert_hits` — and the five alert RPC paths in the endpoint's OpenAPI
definition. It also COUNTED the two overview alert tables: both empty, which is
what `202609200001` rests on.

## Production keeps no record of what it has run

There is no `schema_migration_log` in production — `/rest/v1/schema_migration_log`
answers `PGRST205`, "could not find the table". That table is created by
[`scripts/apply-migrations.ts`](../../scripts/apply-migrations.ts), which runs
against development only and refuses a production url by design
([`src/lib/dev/db-target.ts`](../../src/lib/dev/db-target.ts)).

Production was deployed by hand. Nothing anywhere states which files were run,
in what order, on what date, or from what text.

## What a PostgREST probe can and cannot establish

The only read-only handle on production is its PostgREST endpoint. A request of
the form

```
GET /rest/v1/<relation>?select=<columns>&limit=0
```

distinguishes three answers, and the distinction is the whole method:

| Answer | Meaning |
|---|---|
| `404` / `PGRST205` | the relation does not exist |
| `400` / `42703` | the relation exists; a named column does not |
| `401` / `42501` or `200` | the relation and every named column exist |

`42501` is permission denied for `anon`, and PostgREST only reaches the
privilege check after every name in the `select` has resolved. So it is positive
evidence of existence, and a deliberately bogus column name on the same relation
answering `42703` is the control that proves the resolution was real.

**This establishes tables and columns. Nothing else.** Functions, RLS policies,
CHECK constraints, indexes, grants, triggers and column types are all invisible
to it. A migration whose header says `STATUS: APPLIED` on this evidence is
asserting that its tables and columns are there — not that its functions,
policies or constraints are, and not that they match the file.

Where that gap is load-bearing, the file's own header names it. The largest is
`202608290003_multi_watchlists.sql`: its two columns are confirmed, while
whether `watchlists_one_per_user` was actually dropped and whether the seven
functions are the versions in that file are both unconfirmed.

## Two files were edited after they were applied

A migration is only a record of what ran if its text has not moved since. Two
have:

| File | Commits | |
|---|---|---|
| `202607300001_portfolio_ledger_source_of_truth.sql` | 3 | `454bbf4` (2026-07-30), `11c86b2` (2026-07-30), `b8ccbe6` (2026-07-31) |
| `202608190001_options_signal_history.sql` | 2 | `be355b2` (2026-08-19), `57cd2b2` (2026-08-19) |

No checksum of either file exists on the production side, and production keeps
no ledger to hold one. **Which version of these two production actually ran is
not determinable** — not from the repository, and not from the database.

## The history does not replay from zero

`202608240001_billing_period_status_validate.sql` runs `validate constraint
user_subscriptions_granting_status_period_check`, and that constraint is added
by `202608240003_billing_period_status_atomicity.sql`. `240001` sorts first, so
a replay in filename order aborts with `42704` on an empty database. This is
pinned as a known defect in
[`supabase/migration-order.test.ts`](../../supabase/migration-order.test.ts) and
in PLAN.md.

Production never met it: it was deployed by hand in the documented order
(`240003`, then `scripts/backfill-billing-period-end.ts`, then `240001`).

The current workaround is the `APPLY_AFTER` map in
[`scripts/apply-migrations.ts`](../../scripts/apply-migrations.ts), which moves
`240001` after `240003` at run time. It is honoured by that script alone.
`supabase db push` does not read it and would fail.

**A restore from these migrations has therefore never been performed.** The
ordering defect is only known because a test reads the SQL; nothing has rebuilt
this schema from zero and observed the result.

## Not yet applied

Five files:

1. `202608310004_purge_account_data_overview_alerts.sql`
2. `202609200001_unify_alert_rules.sql`
3. `202609200002_instrument_identity_without_provider.sql`
4. `202609200003_company_profile_snapshot.sql`
5. `202609200004_company_profile_translation_cache.sql`

**The first three have been run.** Not against production — against the
development project on 2026-09-20, `202608310004` inside a transaction that was
rolled back (`npm run db:validate`, below) and the other two applied outright by
`npm run db:apply`. So "not yet applied" above means *production has not run
them*, which is the only thing this document has ever tracked; it no longer also
means nobody anywhere has executed the SQL.

**Files 4 and 5 have NOT been run against either hosted project — not
production and not dev.** They were applied on 2026-09-20 to a throwaway
in-process Postgres (pglite), twice each, and their columns, RLS state,
policies, grants and CHECK constraints were read back; a lowercase symbol and a
`target_language` outside the allowlist were both refused, and a re-translate
upsert left one row carrying the new text. That establishes the files execute
and produce the shape they claim. It establishes nothing about how they behave
against a schema that already has data in it, which for these two is a small
risk — both are `create table if not exists` of tables no project has, and
neither alters or drops anything that exists.

They are additive and the code that reads them fails open: with the tables
absent, `CompanyProfileService` and `CompanyProfileTranslationService` both fall
back to the provider chain they used before, so **the deploy may land before the
migration without breaking anything**. Until they are applied, the cost
reduction they exist for simply does not happen — the profile and translation
caches stay per-instance, as they were.

That distinction used to be the sharpest edge here. Every `STATUS: NOT YET
APPLIED` file was SQL whose first execution would be against production, by
hand, with a deploy waiting — so a mistyped `drop function` signature or a CHECK
that an existing row fails was found at the worst possible moment.
`npm run db:validate <file>` removes that: it runs the file's body on dev inside
a transaction it rolls back, and answers "does this execute?" without applying
anything. It does **not** answer "is this correct", and it can only see dev's
schema — a statement naming something only dev has still passes.

What the 2026-09-20 run observed for `202609200001`, beyond that it executes:
one condition CHECK survives and it admits `earnings`;
`trigger_price_alert_service` takes ten arguments and `trigger_price_alert` is
gone; both overview alert tables and all three of their functions are gone; an
`earnings` alert inserts, does not fire at 30 days or on an unknown report date,
fires at 5 days with `earningsDays` in the notification metadata, and does not
fire again while it stays true; and a price alert's re-crossing inside its
`cooldown_minutes` is held — the column nothing had read since `202608020001`.

`202609200002` is the one with a deadline. Until it is applied,
`market_instruments` is keyed on `(provider, provider_symbol)` while
`scripts/sync-instruments.ts` records the provider that actually served a run —
so the first sync that falls back to Nasdaq Trader inserts a SECOND full
instrument universe beside the first instead of replacing it. Dev did this on
2026-09-05 and reached 25,272 rows with every symbol duplicated. Production has
not been re-synced since and has not forked, but it will on its first fallback
run. **Do not run `npm run sync:instruments` against production until this file
is applied.**

Every other file in `supabase/migrations/` is applied — including the three
`overview_alert_*` files that this section listed as pending until 2026-09-03.

There was a fourth pending file, `202608310003_overview_alert_rule_kind_parity.sql`.
It is **deleted**, not applied and not skipped. It repaired
`create_overview_alert_rule` so the writer would accept `kind = 'earnings'`, and
`202609200001` drops that function along with the whole second alert system, so
applying it afterwards would recreate a function against a table that no longer
exists. The defect it described is worth remembering rather than losing with the
file: a CHECK was widened to five values and the function that inserts rows was
left on four, so a kind could be stored, evaluated, cooled down and recorded —
and created by nobody, for a month, with nothing detecting it. The replacement
guard is in `src/lib/alerts/types.ts`, where the schema's condition union and the
domain's are pinned to each other with two mutually exclusive assignments that
fail the BUILD rather than a reader's save.

**`310004` and `200001` cannot be fully probed.** `310004` replaces two
functions and `200001` replaces one and drops four, and PostgREST reports
relations, columns and RPC paths — never function bodies, CHECK constraints or
grants. Their headers say so themselves and say what WAS probed instead. So "not
yet applied" here means "written, never run", not "run and observed absent",
which is the strongest thing that can be said about a function body from outside
the database.

The order is required: none of the three depends on another, but the runners
apply in filename order and cannot skip.

What follows from each being unapplied, stated where somebody will look for it:

- **`310004`** — `purge_account_data` does not delete `user_release_note_state`,
  so an account deletion leaves those rows behind. They cascade from
  `auth.users`, so the rows do go; it is the residual-data MEASUREMENT that is
  wrong, and that measurement is what gates deleting the auth user.
- **`200001`** — `price_alerts.condition` still refuses `'earnings'`, so the
  condition now offered on `/alerts` is saved by nobody: the action maps the
  resulting `23514` to "ระบบยังไม่รองรับเงื่อนไขนี้" rather than to a retry. The
  other four conditions are unaffected. The sweep also calls
  `trigger_price_alert_service` with ten arguments while production still has
  the nine-argument function, so **no price alert fires until this is applied**
  — apply it with the deploy, not after it. That failure is loud rather than
  silent, which is why no compatibility shim was written for it: PostgREST
  answers `PGRST202`, `runBackgroundAlerts` throws, `/api/cron/alerts` returns
  503 and the `alert_evaluation_runs` row for the window is left `failed`. An
  operator sees a red cron every fifteen minutes, not a quiet absence of
  notifications.
- **`200002`** — see the deadline above.

## The header contract

A migration file may carry a status block, and if it does the form is fixed:

```
-- STATUS: APPLIED
-- VERIFIED: 2026-08-31, by PostgREST probe against production.
```

or

```
-- STATUS: NOT YET APPLIED
-- VERIFIED: 2026-08-31, by PostgREST probe against production.
-- QUEUE: 202608300001, 202608310001, 202608310002
```

`supabase/migration-order.test.ts` enforces the grammar, the date, that the
unapplied files are the tail of the filename order, and that every `QUEUE:` line
lists exactly the unapplied set. It cannot check the claims against production —
nothing offline can. It exists because five files claimed `NOT YET APPLIED` for
as long as they had been live, and prose alone did not catch it.

Files with no status block are older than the convention and are applied.
