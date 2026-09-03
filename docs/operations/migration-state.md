# Migration state

What is known about which migrations production has run, and what is not
knowable at all. This file records the state; it does not propose changes to it.

Last confirmed **2026-08-31** — that is the date of the PostgREST probe every
`VERIFIED:` header cites, and `supabase/migration-order.test.ts` requires this
date and those to agree. The corrections below it dated 2026-09-03 are
reconciliations of stale prose against those headers, not new probes.

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

Two files:

1. `202608310003_overview_alert_rule_kind_parity.sql`
2. `202608310004_purge_account_data_overview_alerts.sql`

Every other file in `supabase/migrations/` is applied — including the three
`overview_alert_*` files that this section listed as pending until 2026-09-03.
`overview_alert_rules` and `overview_alert_hits` both resolve now; the section
was stale, and `supabase/migration-order.test.ts` reads this list against the
`STATUS:` headers so it cannot go stale again silently.

**Neither of the two can be probed.** `310003` replaces one function and
`310004` replaces two, and PostgREST reports relations and columns, never
function bodies. Their headers say so themselves and say what WAS probed
instead: for `310004`, every table it adds to or removes from the purge lists.
So "not yet applied" here means "written, never run", not "run and observed
absent" — which is the strongest thing that can be said about a function from
outside the database, and the reason the file headers carry the evidence
sentence rather than only a status.

The order is required: `310004` does not depend on `310003`, but they were
written in that order and the runners cannot skip.

What follows from `310003` being unapplied is behavioural and worth stating
where somebody will look for it: `create_overview_alert_rule` refuses
`kind = 'earnings'`, so one of the five kinds the column, the hits table, the
evaluator and the 24-hour cooldown all handle cannot be created. From `310004`:
`purge_account_data` does not delete `overview_alert_rules`,
`overview_alert_hits` or `user_release_note_state`, so an account deletion
leaves those rows behind.

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
