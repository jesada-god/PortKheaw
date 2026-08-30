# When the overview alert sweep runs, and why it is not in `vercel.json`

## The short answer

It runs from **Supabase pg_cron**, every **15 minutes**, via the job
`portkheaw-background-notifications` defined in
[`202608020003_supabase_notification_cron.sql`](../../supabase/migrations/202608020003_supabase_notification_cron.sql),
which calls `GET /api/cron/alerts`. The overview sweep rides that schedule; it
does not ask for a second one.

**`vercel.json` must not list `/api/cron/alerts`.**
[`daily-snapshot-run.test.ts`](../../src/lib/market-data/daily-snapshot-run.test.ts)
pins that, and the test exists because the mistake is easy: two schedulers on one
endpoint double-fire the pass, and each is invisible from the other's dashboard.
The only Vercel cron in this product is `/api/cron/daily-snapshot`.

---

## Why a 15-minute cadence sidesteps the DST trap entirely

This is worth writing down because the product has already made the mistake
once, in the other job.

Vercel and pg_cron expressions are both evaluated in **UTC**, with no zone to
set. New York is **UTC−5 in winter (EST)** and **UTC−4 in summer (EDT)**, so a
schedule written as a New York wall clock has to be chosen for *both* halves of
the year. The obvious reading of "16:10 ET" is 20:10 UTC, and it is broken for
roughly four months:

| UTC | ET in summer (EDT, −4) | ET in winter (EST, −5) | After the 16:00 close? |
|---|---|---|---|
| `20:10` | 16:10 | **15:10** | ❌ winter — market still open |
| `21:10` | 17:10 | 16:10 | ✅ both |

That is why the daily snapshot fires at `10 21 * * 1-5` (21:10 UTC) and accepts
an hour of drift across the boundary — the reasoning is in
[`app/api/cron/daily-snapshot/route.ts`](../../app/api/cron/daily-snapshot/route.ts)
and proved in `daily-snapshot-capture.test.ts`.

**The alert sweep has no such choice to get wrong.** It runs every 15 minutes, so
it fires 96 times a day in both offsets and there is no single hour whose ET
meaning has to be reasoned about. A DST transition moves *which* run lands
closest to any given ET moment by one slot; it cannot make the job miss a window,
because there is no window.

### What the ET timeline looks like either way

| pg_cron (UTC) | EDT (summer) | EST (winter) | What the sweep sees |
|---|---|---|---|
| `13:30` | 09:30 — open | 08:30 — pre-market | Prices from the last completed session or the opening tape |
| `20:00` | 16:00 — close | 15:00 — open | Late-session prices |
| `21:00` | 17:00 — after-hours | 16:00 — close | The completed session |
| `03:00` | 23:00 — closed | 22:00 — closed | Nothing new; the sweep is a no-op |

None of these rows is a failure. The sweep evaluates against whatever the shared
day-change rule reports for the session it is in, and the cooldown — 4 hours for
price and move kinds, 24 for earnings — is what stops a rule that stays true
across many of these runs from writing a row each time. See
[`cooldown.ts`](../../src/lib/market-overview/alerts/cooldown.ts).

---

## If it ever *does* have to move to Vercel

Two things must happen together, or the pass double-fires:

1. remove the pg_cron job (`cron.unschedule('portkheaw-background-notifications')`)
   in a migration, and
2. add the Vercel entry **and** update the assertion in
   `daily-snapshot-run.test.ts`, which currently requires
   `vercel.json` crons to be exactly `['/api/cron/daily-snapshot']`.

Doing only the second is the failure the test is there to catch.

If the sweep is ever changed from a cadence to a wall-clock time, pick the UTC
hour from the table at the top — **21:10 UTC, not 20:10** — and write the reason
next to it.

---

## Wiring status

`runOvAlertSweep` in
[`src/lib/market-overview/alerts/run.ts`](../../src/lib/market-overview/alerts/run.ts)
is complete and tested, and **is not yet called by the route**. Calling it means
one addition to `app/api/cron/alerts/route.ts`, which this change was not
permitted to edit. Until that line lands the sweep runs nowhere, and the tables
it writes to are unapplied migrations, so nothing is silently half-live.
