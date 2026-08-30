# Verifying the daily snapshot capture

> **Status: scheduled since 30 August 2026.** `vercel.json` fires
> `/api/cron/daily-snapshot` at `10 21 * * 1-5`. Before that the route was
> deployed and nothing called it, so `daily_snapshot` was empty from the day the
> table was created — see [History](#history).
>
> **Nothing has been verified in production yet.** The first row should appear
> after the first weekday run following deploy. Use
> [Checking production](#checking-production) then.

## What the capture is

[`/api/cron/daily-snapshot`](../../app/api/cron/daily-snapshot/route.ts) writes
one `daily_snapshot` row per held symbol per trading date: the official
regular-session close, captured after the bell and never revised by a live tick.
Every page that shows a "today" figure outside market hours reads it.

Without it, those pages fall back to the live-only path they had before the
table existed. **That is what made this so hard to notice**: nothing breaks
visibly. The product looks correct, the table stays valid and empty, and the
history it should be accumulating simply does not exist.

## The schedule, and why 21:10 UTC

Vercel cron expressions are evaluated in **UTC** and there is no time zone to
set. So a schedule written as a New York wall clock has to be chosen for both
halves of the year, and the obvious reading of the route's intended "16:10 ET"
is wrong for four months:

| UTC | in EDT (summer) | in EST (winter) | Result |
|---|---|---|---|
| `20:10` | 16:10 ET — after close | **15:10 ET — market OPEN** | Guard refuses **all winter**; table stays empty |
| `21:10` | 17:10 ET — after-hours | 16:10 ET — after close | Captures in both |

`21:10 UTC` is the earliest single time past the closing bell under both
offsets. **The hour of drift across the DST boundary is accepted, not
overlooked**: in summer the job runs at 17:10 ET instead of 16:10, still inside
the after-hours window and still the same trading date, so the row it writes is
identical. Both cases are asserted against the real session functions in
[`daily-snapshot-capture.test.ts`](../../src/lib/market-data/daily-snapshot-capture.test.ts),
including the one that shows `20:10` would refuse.

**Monday–Friday, not daily**, and that is about cost rather than safety. On a
Saturday the session is `CLOSED` (not `OPEN`), so the guard lets the run through
and `lastCompletedSessionDate` answers *Friday* — a weekend run would re-capture
Friday's closes for no new data. The upsert makes it harmless and the provider
calls make it wasteful. A market holiday still costs one redundant re-capture
(Christmas re-captures 24 December), which is a handful of days a year and not
worth a holiday calendar to avoid.

### Why this is a Vercel cron and not a `pg_cron` job

The three existing scheduled jobs live in Supabase:

| Job | Runs |
|---|---|
| `portkheaw-background-notifications` | HTTP GET → `/api/cron/alerts`, every 15 min |
| `portkheaw-trial-retention` | in-database SQL function |
| `portkheaw-portfolio-purge` | in-database SQL function |

So this splits scheduling across two mechanisms, which is a real cost. It was
chosen anyway because adding a second HTTP job to `pg_cron` needs a new
migration —`configure_notification_cron_service` hard-rejects any URL other than
the alerts endpoint — plus a vault secret and a manual configure call, to
schedule something Vercel schedules with four lines of JSON.

**`/api/cron/alerts` must not be added to `vercel.json`.** It already runs from
`pg_cron`, and a Vercel cron beside it would double-fire the notification pass,
with each scheduler invisible from the other's dashboard. A test asserts
`vercel.json` schedules the capture and nothing else.

## Authorization

`CRON_SECRET`, the **same variable `/api/cron/alerts` already uses** — no new
environment variable is introduced. Vercel sends
`Authorization: Bearer $CRON_SECRET` on scheduled invocations whenever that
variable is set on the project, so the platform's mechanism and the route's
check are the same secret.

**If alerts currently work in production, `CRON_SECRET` is already set and
nothing needs adding.** If it is unset, every caller is rejected including
Vercel — deliberately, because an endpoint that writes market data must not be
open because a variable was forgotten.

## Reading the logs

Every run emits one structured line, which is what distinguishes a refusal from
a run that never fired — the two used to leave identical empty tables.

| Line | Level | Meaning |
|---|---|---|
| `daily_snapshot_written` | info | Ran and wrote. Carries `date`, `written`, `skipped`, `symbols`, `contracts`, `unpriced` |
| `daily_snapshot_refused` | info | Nothing to capture. Carries `refused` (`market-open` / `not-a-trading-day` / `no-completed-session`) and `date` |
| `daily_snapshot_rejected` | warn | Bad or missing secret |
| `daily_snapshot_failed` | warn | `not_configured` (no Supabase admin client) or `capture_threw` |

Counts only — no symbol, account, price or error message reaches a log line.

A healthy weekday looks like:

```json
{"event":"daily_snapshot_written","date":"2026-12-09","written":12,"skipped":0,"symbols":10,"contracts":2,"unpriced":0}
```

`written: 0` with `refused: null` is a **different** state from a refusal: the
job ran and found no held symbols. Expect exactly that until somebody holds
something.

## Checking dev

```
npm run inspect:daily-snapshot
```

Read-only, and it resolves its target through
[`src/lib/dev/db-target.ts`](../../src/lib/dev/db-target.ts), which reads
`.env.test` and throws on a production project ref. There is no override flag.

Dev has **no scheduler and no readers**, so 0 rows there is expected
indefinitely. `vercel.json` schedules production deployments only.

## Checking production

The script deliberately offers no production path. Run these on the Supabase
dashboard SQL editor, where they execute under a human's eyes and leave an audit
trail a laptop run does not. **All four are read-only.**

### 1. Volume and range

```sql
select
  count(*)                as rows,
  count(distinct symbol)  as symbols,
  min(date)               as first_date,
  max(date)               as last_date
from public.daily_snapshot;
```

### 2. Rows per captured date, most recent first

```sql
select date, count(*) as rows
from public.daily_snapshot
group by date
order by date desc
limit 30;
```

### 3. Weekdays in range with no rows at all

Gaps, without claiming they are missed runs — US market holidays are not
modelled here, so check anything this returns against the calendar first.

```sql
with bounds as (
  select min(date) as first_date, max(date) as last_date
  from public.daily_snapshot
),
weekdays as (
  select generate_series(b.first_date, b.last_date, interval '1 day')::date as day
  from bounds b
)
select w.day
from weekdays w
where extract(isodow from w.day) < 6
  and not exists (select 1 from public.daily_snapshot s where s.date = w.day)
order by w.day;
```

### 4. `label_history`, while you are here

Empty here is **not** a bug — `recordLabel` has exactly one caller,
`loadMarketStatusWithHistory`, and that only runs when `MARKET_STATUS_CARD` is
on. Expect zero rows until that flag is enabled; see
[phase2-rollout.md](../phase2-rollout.md).

```sql
select scope, count(*) as rows, max(created_at) as latest
from public.label_history
group by scope
order by scope;
```

## Reading the results

| What you see | What it means |
|---|---|
| `last_date` is the most recent completed trading day | Working. |
| **0 rows** shortly after deploy | Expected until the first weekday 21:10 UTC run. Check the logs for a `daily_snapshot_written` line before assuming a fault. |
| **0 rows** after a weekday has passed | Check the Vercel cron ran at all, then the log line. `daily_snapshot_rejected` means `CRON_SECRET` is unset or mismatched. |
| `relation does not exist` | The migration was not applied to this project. Different problem; apply it first. |
| `last_date` is 2+ trading days old | The scheduler stopped, or every run is refusing. A refusal returns 200, so a green Vercel dashboard is **not** evidence it wrote anything — read the log line. |
| Rows exist but `symbols` is far below what readers hold | The capture ran but `heldSymbols` returned little. Look there, not at the scheduler. |
| Gaps only on US market holidays | Correct. The run refuses on non-trading dates by design. |
| Gaps on ordinary weekdays | Real missed runs. Worth investigating. |
| `date` ahead of the last completed session | Should be impossible — `lastCompletedSessionDate` gates it. Treat as a bug in the session logic, not the scheduler. |
| Two rows for one `(symbol, date)` | Impossible — that pair is the primary key and the write is an upsert against it. If you see it, the table was written by something other than this job. |

## First verification after deploy

1. Confirm the cron is registered: Vercel project → **Settings → Cron Jobs**.
   It should list `/api/cron/daily-snapshot` at `10 21 * * 1-5`.
2. Confirm `CRON_SECRET` is set on the project (Production environment).
3. Wait for the first weekday run, then read the function log for a
   `daily_snapshot_written` line.
4. Run query 2 above and expect a row group for that trading date.

## History

`vercel.json` existed once, carrying a `crons` entry for `/api/cron/alerts`, and
was deleted in `dcbfa99` ("fix: schedule notifications from Supabase",
2 Aug 2026) when notifications moved to `pg_cron`. The daily snapshot route was
added later (`202608290001_daily_snapshot.sql`, 29 Aug 2026) and its 16:10 ET
slot was documented in the route header but never implemented anywhere — the
file that would have carried it no longer existed. It was found and fixed on
30 August 2026, with the table still holding zero rows.

`202608290001_daily_snapshot.sql` states that it schedules nothing, and that is
still correct: a table migration is not where an unattended job should start.
