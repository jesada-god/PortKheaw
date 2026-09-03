# Phase 2 flag rollout

What each of the four flags costs, what it needs applied first, and the order
that is safe. Measured 2026-08-31 against a production build.

**Nothing here has been switched on.** All four are off in production.

## Measured cost, all four on at once

`npm run qa:overview-phase2`, same build, two deployments, seven samples each
after a warm-up. Timing is the server document, not a browser paint.

| | median | samples (ms) |
|---|---|---|
| baseline, flags unset | **413 ms** | 1619 · 459 · 386 · 378 · 413 · 402 · 456 |
| candidate, all four on | **425 ms** | 2256 · 457 · 380 · 425 · 531 · 400 · 399 |

**Ratio 1.03× against a 2× gate — pass, with a wide margin.** The first sample of
each run is cold compilation and is why the median is reported rather than the
mean.

Also from that run, at 375 × 812:

- both deployments answered **200** — no 307, so the maintenance gate is genuinely
  released;
- `document.scrollWidth` 375 against a 375 viewport, **0 overflow offenders**;
- **0 page errors** and 0 console errors on either.

## The four flags

Prerequisites are declared once, in
[`src/config/phase2-flag-manifest.mjs`](../../src/config/phase2-flag-manifest.mjs).
This table, the QA script and that file are held to each other by
`phase2-flag-manifest.test.ts`, which compares them against the real order
arrays in `section-order.ts`.

| Flag | What turning it on does | Spends | Flag prerequisite | Signed in? | Migration needed |
|---|---|---|---|---|---|
| `PHASE2_MARKET_SNAPSHOT` | Adds the market strip, the status word and its reasons to ตลาดวันนี้ | **Yes — the only one that spends.** Six provider quotes, behind a 60-second shared cache and a last-good snapshot, so a burst of readers costs one round rather than one each | **None** — `marketToday` is in both order arrays | No | None |
| `PHASE2_WHAT_CHANGED` | Shows the renamed change feed | No. Renames items the watchlist detectors already produce — a mapping with a dedupe, no request, no clock, no history read | **None** — `whatChanged` is in both order arrays | **Yes** — built from the reader's own watchlist | None |
| `PHASE2_EVENTS` | **Nothing, in any combination.** It still builds the merged list; no order array walks the `events` key any more | No, and it buys nothing either | **Unreachable.** `events` is in neither order array — the Overview draws the month grid (`marketEvents`) in that slot. See below | No | None |
| `PHASE2_ALERTS` | Two separate things — see below | One indexed row read per render | **None** — the count decorates `watchlist`, in both order arrays | **Yes** — the count is per reader | `202608300001`, `202608310001`, `202608310002` — **all applied**. `202608310003` (`earnings` rules) and `202608310004` (account-deletion purge) — **not applied** |

`PHASE2_MARKET_SNAPSHOT` and the watchlist-view pair are read *before* their
promises are constructed, so with a flag off the work is never started rather
than started and discarded. `src/config/phase2-flags.test.ts` asserts that
against the source of `app/page.tsx`.

### `PHASE2_EVENTS` no longer reaches the page at all

The Overview's calendar slot draws `marketEvents` — the month grid — in **both**
order arrays. `events`, the merged list, is in neither, so
`orderedOverviewSections` can never emit it and `PHASE2_EVENTS` changes no pixel
whether it is on or off, with or without the base flag.

That is deliberate and it is recorded in two places that are checked against the
real arrays: `STRANDED_SECTION_KEYS` in
[`section-order.ts`](../../src/lib/overview/section-order.ts) and the
`unreachable` field on the flag's manifest entry. **The flag is safe to turn
off, and should be** — a switch that does nothing is a switch somebody will one
day move looking for an effect.

### `OVERVIEW_V2` is a base flag, not a fifth Phase 2 flag

It does not add a section. It selects **which order array the page walks**, and
that decision happens after presence is computed — so a section absent from the
chosen array is dropped no matter how true its flag is.

`PHASE2_EVENTS=true` was set in production and drew nothing for exactly this
reason: the flag was read, the data was built, the presence map said
`events: true`, and `orderedOverviewSections` filtered `OVERVIEW_ORDER_V1`,
which has no `'events'` key at all.

**Turning `OVERVIEW_V2` on is a visible change to the whole page:**

- **Two sections disappear.** `marketStatus` and `upcoming` exist only in V1.
  `marketStatus` goes because `marketToday` publishes the same six instruments
  and the same regime; `upcoming` goes because the calendar slot answers the
  same question and the month grid answers it faster.
- **Nothing new appears.** V2 is a reordering now, not an addition — the six
  sections it lists are six V1 already had.
- **Two swap.** V1 runs `watchlist` then `whatChanged`; V2 runs `whatChanged`
  then `watchlist`. `marketToday`, `portfolio` and `news` do not move.
- **The calendar moves rather than leaving.** V1 draws the month grid last; V2
  draws it after the watchlist. It is the same card either way.

### `PHASE2_ALERTS` gates two things, and only one of them is a render

1. **A read-time count** on the Overview — one row read per render, harmless.
2. **The scheduled sweep.** `/api/cron/alerts` checks `phase2AlertsEnabled()`
   before sweeping, so this flag is what starts alert rules being evaluated and
   `overview_alert_hits` rows being written.

That second one is not on `vercel.json` and turning it on does not need to be.
`/api/cron/alerts` is scheduled by **pg_cron**, from
`202608020004_notification_cron_vercel_alias.sql`, and **it is already running
every fifteen minutes**. Verified from `alert_evaluation_runs` on 2026-08-31:

```
2026-08-31T09:15Z  completed  evaluated 4  triggered 0  push_sent 0
2026-08-31T09:00Z  completed  evaluated 4  triggered 0  push_sent 0
2026-08-31T08:45Z  completed  evaluated 4  triggered 0  push_sent 0
```

So `PHASE2_ALERTS=true` takes effect on the next tick, without anybody
scheduling anything. There is nothing to switch on afterwards and nothing to
switch off but the flag.

## A safe order

None of the four reads another's output, so this order is about what you can
still attribute when something moves — not about correctness. Run
`npm run verify:phase2-live -- --flag <name>` after each step; record the
baseline first.

**0. `--flag baseline`, before anything.** It records production's own median as
the anchor every later step is gated against. The 413 ms above is a *localhost*
number and is not comparable to production over the internet.

1. **`PHASE2_MARKET_SNAPSHOT`** — the only one that buys anything, and moved to
   the front because it is the only one visible signed-out with no prerequisite:
   one switch, one visible change, nothing else to explain it. Watch provider
   usage for a session before continuing.
   `--flag market-snapshot`
2. **`PHASE2_WHAT_CHANGED`** — free. `whatChanged` is in both order arrays, so no
   base flag. It needs a **signed-in reader with a watchlist**, so the script
   reports it as not verified and you confirm it by eye.
   `--flag what-changed`
3. **`PHASE2_ALERTS`** — free to render, but it starts the sweep. Only after
   `202608310003` is applied if you want `earnings` rules.
   `--flag alerts --wait-for-tick`
4. **`OVERVIEW_V2`, last and alone.** `PHASE2_EVENTS` is no longer part of this
   step — it reaches nothing, and pairing it here would attribute the base
   flag's changes to a switch that did none of them. What this step does is drop
   `marketStatus` and `upcoming`, swap `watchlist` with `whatChanged`, and move
   the calendar up. **Re-record the baseline afterwards** — the page is a
   different page.
   `--flag baseline` again, after

Measured together at 1.03× locally, so the order is not protecting a budget — it
is protecting attribution. `OVERVIEW_V2` is last because it is the only step that
cannot be judged by "did one thing appear": two sections leave and a third moves
at the same time, and that is worth looking at on its own rather than alongside
another flag.

## Not ready

### `earnings` alert rules cannot be created

`202608310003` is written and **not applied**. Until it is,
`create_overview_alert_rule` refuses `earnings`, which is one of the five kinds
the feature is built around. The column, the hits table, the evaluator and the
24-hour cooldown all handle it; only the writer refuses.

`PHASE2_ALERTS` is safe to turn on before that migration — the four price and
percent kinds work — but the feature is a fifth short until it lands.

### Deleting an account leaves alert rows behind

`202608310004` is written and **not applied**, so `purge_account_data` still
carries a table list from before `overview_alert_rules`, `overview_alert_hits`
and `user_release_note_state` existed, and deletes none of the three.

Not urgent today only because nothing can create a rule — there is no interface
for it, so those two tables are empty. It becomes a real gap the moment one
lands, and it should land before that does.

### Breadth: `% above the 50-day / 200-day` is null and stays null

`OvBreadthSnapshot.pctAboveMA50` and `pctAboveMA200` are typed **`null`**, not
`number | null`. That is deliberate, and the type is the enforcement: no caller
can fill them from a smaller sample and publish a different statistic under the
same name.

The reason is cost. The batch that breadth already reads returns two bars per
symbol; a 200-day average needs two hundred, across ~4,285 symbols — a second
fan-out an order of magnitude larger than the one that exists.
`MarketBreadth.aboveEma20Percent` has been hardcoded `null` since it shipped for
the same reason, without the type saying so.

No flag changes this and none of the four is waiting on it.

### The sweep is verified on dev, never on production data

`npm run verify:ov-alert-sweep` ran against the dev project on 2026-08-31 and
passed every claim, with all five migrations applied there:

- all five kinds create through `create_overview_alert_rule`, `earnings`
  included — the claim `202608310003` exists to make true;
- after a sweep, no rule carries a stamp without a hit and no hit exists without
  a stamp, and every `last_fired_at` equals its own hit's `observed_at`;
- an immediate second sweep recorded nothing and moved no stamp, with
  `evaluated: 5` — it looked at every rule and chose not to write;
- `percent_down`, given a threshold it could not pass, did not fire.

That is the first time the hit/stamp pair has been observed as atomic in
Postgres rather than modelled by a double.

**What is still unproven** is behaviour on production data: production holds
**0** `overview_alert_rules`, so nothing has swept a real reader's rule. The
first real exercise will be the tick after `PHASE2_ALERTS` goes on.
