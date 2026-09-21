# When the alert sweep runs, and why it is not in `vercel.json`

## The short answer

It runs from **Supabase pg_cron**, every **15 minutes**, via the job
`portkheaw-background-notifications` defined in
[`202608020003_supabase_notification_cron.sql`](../../supabase/migrations/202608020003_supabase_notification_cron.sql),
which calls `GET /api/cron/alerts`.

There is **one** sweep on that tick. A second one used to ride it — over
`overview_alert_rules`, behind `PHASE2_ALERTS` — and `202609200001` merged it
into `price_alerts`; see [`migration-state.md`](migration-state.md).

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

None of these rows is a failure — but the last one is worth reading carefully,
because it is the limit readers actually notice. The sweep judges an alert only
against a reading it ACCEPTS, and
[`targetObservation`](../../src/lib/alerts/observation.ts) accepts nothing
outside a regular, pre-market or after-hours session. **An alert cannot fire on a
market that is shut**, whatever the cadence.

What stops an alert that stays true across many of these runs from notifying
each time is two things, both in `trigger_price_alert_service`:

- `was_matching` — the CROSSING edge. A threshold that is still crossed on the
  next tick is not a second event. This is also what makes `earnings` workable:
  "reports within 7 days" is true for seven days running and is said once.
- `cooldown_minutes` — the reader's own floor between two notifications for one
  alert, for the case the edge does not cover: a price sitting ON the threshold
  genuinely re-crosses it every few minutes.

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

`runBackgroundAlerts` in
[`src/lib/alerts/background.ts`](../../src/lib/alerts/background.ts) reads
`price_alerts` with the service role, up to 20 per tick, and hands each accepted
reading to `trigger_price_alert_service`. That function — not TypeScript —
decides every match, stamps the row and writes the Inbox item, in one transaction
under a row lock.

`PHASE2_ALERTS` does **not** gate any of this and never should: it gates the
count badge on a watchlist row and nothing else. Alerts fire with the flag off.

**`202609200001` must be applied before this code is deployed.** The sweep calls
`trigger_price_alert_service` with ten arguments; a production that still has the
nine-argument version answers `PGRST202` and the whole run fails — loudly, as a
red cron and a `failed` row in `alert_evaluation_runs`, but no alert fires until
it is applied.
