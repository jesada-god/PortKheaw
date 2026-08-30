# Verifying the daily snapshot capture

> **Finding, 30 August 2026: the capture has never been scheduled.**
> The route exists and is deployed. Nothing calls it. See
> [The scheduler gap](#the-scheduler-gap) below — the queries in this document
> will return zero rows on production until that is fixed, and that result is
> *expected*, not a second bug.

## What the capture is

[`/api/cron/daily-snapshot`](../../app/api/cron/daily-snapshot/route.ts) writes
one `daily_snapshot` row per held symbol per trading date: the official
regular-session close, captured after the bell and never revised by a live tick.
Every page that shows a "today" figure outside market hours reads it.

Without it, those pages fall back to the live-only path they had before the
table existed. **That is the whole difficulty of verifying this**: nothing
breaks visibly. The product looks correct, the table stays valid and empty, and
the history it is supposed to be accumulating simply does not exist.

## The scheduler gap

There is no scheduler entry for this route anywhere in the repository.

- **No `vercel.json`.** It existed once, carrying a `crons` entry for
  `/api/cron/alerts` every 15 minutes, and was deleted in `dcbfa99`
  ("fix: schedule notifications from Supabase", 2 Aug 2026) when notifications
  moved to Supabase `pg_cron`. Nothing has re-created it.
- **No `cron.schedule` for this route in any migration.** The only scheduled job
  is `portkheaw-background-notifications`, created by
  `202608020003_supabase_notification_cron.sql`, and
  `configure_notification_cron_service` *hard-rejects* any url other than
  `https://portkheaw.app/api/cron/alerts` — so it cannot be reused for this
  endpoint without a new migration.
- **`202608290001_daily_snapshot.sql` states it schedules nothing**, and it is
  right to: the table migration is not the place to start an unattended job.

So the intended 16:10 ET slot is documented in the route's own header and
implemented nowhere. Fixing it is a decision between two mechanisms (a
re-created `vercel.json`, or a second `pg_cron` job following the notification
pattern), which is why this document reports the gap rather than picking one.

**The writer guard is intact and was verified**: `runDailySnapshotCapture`
refuses while the market is `OPEN`, refuses again when there is no completed
session date, and returns 200 with a reason either way — so a scheduler that
fires early or on a holiday is harmless. That half is ready; only the trigger is
missing.

## Checking dev

```
npm run inspect:daily-snapshot
```

Read-only, and it resolves its target through
[`src/lib/dev/db-target.ts`](../../src/lib/dev/db-target.ts), which reads
`.env.test` and throws on a production project ref. There is no override flag.

Result on dev, 30 August 2026: **0 rows** — the table exists (so the migration is
applied) and nothing has ever written to it. Expected, since dev has no
scheduler either and no reader generating held symbols.

## Checking production

The script deliberately offers no production path. Run these on the Supabase
dashboard SQL editor instead, where they execute under a human's eyes and leave
an audit trail a laptop run does not. **All four are read-only.**

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
modelled here, so check anything this returns against the calendar before
concluding anything.

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
| **0 rows**, table exists | The capture has never completed. Expected right now — nothing schedules it. |
| `relation does not exist` | The migration was not applied to this project. Different problem; apply it first. |
| `last_date` is the most recent completed trading day | Working. |
| `last_date` is 2+ trading days old | The scheduler stopped, or every run is refusing. Check the route's response — a refusal returns 200 with a reason, so a green dashboard is not evidence it wrote anything. |
| Rows exist but `symbols` is far below the number of symbols readers actually hold | The capture ran but the held-symbol query returned little. Look at `heldSymbols`, not the scheduler. |
| Gaps only on US market holidays | Correct. The run refuses on non-trading dates by design. |
| Gaps on ordinary weekdays | Real missed runs. Worth investigating. |
| `date` ahead of the last completed session | Should be impossible — `lastCompletedSessionDate` gates it. Treat as a bug in the session logic, not the scheduler. |

## After a scheduler is added

Verify with the 16:10 ET slot in mind:

1. Confirm the job exists in whichever mechanism was chosen (`vercel.json`
   `crons`, or `select * from cron.job`).
2. Confirm the schedule is in **UTC** and lands on 16:10 ET for both halves of
   the year — that is `20:10` UTC during EDT and `21:10` UTC during EST. A single
   fixed UTC cron will drift by an hour across the DST boundary; either accept
   that it fires at 15:10 ET in winter (still after the close, still fine) or
   schedule it late enough to be safe in both, and write down which was chosen.
3. Wait one trading day, then run query 2 above and expect a row group for that
   date.
