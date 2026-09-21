# Phase 2 flag rollout

What each flag costs, what it needs applied first, and the order that is safe.
Measured 2026-08-31 against a production build.

The list is not "flags whose name starts with `PHASE2_`". It is **every flag
whose output has to survive `orderedOverviewSections` to be seen**, which is why
`MARKET_EVENTS_CARD` is here: it is not a Phase 2 flag, and it failed in exactly
the way this document exists to prevent.

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

## The flags

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
| `MARKET_EVENTS_CARD` | Draws the ปฏิทินเศรษฐกิจ month grid on the Overview, and makes `/market-events` exist at all — the route `notFound()`s while it is off | No. The calendar is a static JSON import; the route adds one portfolio row read, to count holdings | **None** — `marketEvents` is in both order arrays | No | None |
| `PHASE2_ALERTS` | Adds the alert-count badge to watchlist rows. **Nothing else** — see below | No. Counted from the `price_alerts` rows the page already reads for its Upcoming feed | **None** — the count decorates `watchlist`, in both order arrays | **Yes** — the count is per reader | None of its own. `202609200001` is required by the SWEEP, which this flag does not gate |

`PHASE2_MARKET_SNAPSHOT` and the watchlist-view pair are read *before* their
promises are constructed, so with a flag off the work is never started rather
than started and discarded. `src/config/phase2-flags.test.ts` asserts that
against the source of `app/page.tsx`.

### `MARKET_EVENTS_CARD` failed the same way, from the other side

It was set in production, redeployed, and the card did not appear. `OVERVIEW_V2`
was on, `'marketEvents'` was in `OVERVIEW_ORDER_V1` alone, and the section was
filtered out before its presence was consulted — the `PHASE2_EVENTS` failure
with the base flag inverted.

The manifest could not have caught it: `MARKET_EVENTS_CARD` was not in it, and
the schema had only `requires`, which says "this env var must also be TRUE".
The prerequisite that was actually true — "`OVERVIEW_V2` must be OFF" — had
nowhere to be written. There is a `forbids` field for that now, and
`marketEvents` is in both order arrays, so neither field applies to it any
more; the test derives that from `section-order.ts` and makes the matching
field mandatory the moment the key drops out of an array.

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

### `PHASE2_ALERTS` gates one render, and it used to gate more

It now decides exactly one thing: whether a watchlist row shows how many alerts
the reader has on that symbol. It costs no query — the count is derived from the
`price_alerts` rows [`app/page.tsx`](../../app/page.tsx) has already read for the
Upcoming feed.

It used to also gate a **second scheduled sweep**, over `overview_alert_rules`,
writing `overview_alert_hits`. `202609200001` merged that system into
`price_alerts` and dropped it, so:

- **turning this flag on no longer starts anything evaluating**, and
- **turning it off no longer stops any alert firing.**

Price alerts have always fired regardless of it, and still do.

`/api/cron/alerts` is scheduled by **pg_cron**, from
`202608020004_notification_cron_vercel_alias.sql`, and **it is already running
every fifteen minutes**. Verified from `alert_evaluation_runs` on 2026-08-31:

```
2026-08-31T09:15Z  completed  evaluated 4  triggered 0  push_sent 0
2026-08-31T09:00Z  completed  evaluated 4  triggered 0  push_sent 0
2026-08-31T08:45Z  completed  evaluated 4  triggered 0  push_sent 0
```

So `PHASE2_ALERTS=true` takes effect on the next RENDER, without anybody
scheduling anything. There is nothing to switch on afterwards and nothing to
switch off but the flag.

## A safe order

None of them reads another's output, so this order is about what you can still
attribute when something moves — not about correctness. Run
`npm run verify:phase2-live -- --flag <name>` after each step; record the
baseline first.

**0. `--flag baseline`, before anything.** It records production's own median as
the anchor every later step is gated against. The 413 ms above is a *localhost*
number and is not comparable to production over the internet.

1. **`MARKET_EVENTS_CARD`** — free, visible signed out, in both order arrays,
   and it is the step that makes `/market-events` stop returning 404. Nothing
   else depends on it.
   `--flag market-events-card`
2. **`PHASE2_MARKET_SNAPSHOT`** — the only one that buys anything, and moved to
   the front because it is the only one visible signed-out with no prerequisite:
   one switch, one visible change, nothing else to explain it. Watch provider
   usage for a session before continuing.
   `--flag market-snapshot`
3. **`PHASE2_WHAT_CHANGED`** — free. `whatChanged` is in both order arrays, so no
   base flag. It needs a **signed-in reader with a watchlist**, so the script
   reports it as not verified and you confirm it by eye.
   `--flag what-changed`
4. **`PHASE2_ALERTS`** — free, and it starts nothing. Signed out the page is
   identical, so the script reports it as not verified and you confirm the badge
   by eye with an account that owns an alert.
   `--flag alerts`
5. **`OVERVIEW_V2`, last and alone.** `PHASE2_EVENTS` is no longer part of this
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

### `202609200001` must be applied with the deploy, not after it

This one is not a flag question and it is not optional. The sweep calls
`trigger_price_alert_service` with ten arguments; production still has the
nine-argument version until the migration runs, so **no price alert fires in
between**. The failure is loud — `PGRST202`, a 503 from `/api/cron/alerts`, and a
`failed` row in `alert_evaluation_runs` every fifteen minutes — but it is a full
outage of the feature while it lasts.

`earnings` alerts also cannot be saved until it lands: the column's CHECK refuses
the condition, and [`app/alerts/actions.ts`](../../app/alerts/actions.ts) maps the
resulting `23514` to "ระบบยังไม่รองรับเงื่อนไขนี้" rather than to a retry.

It has been **run** — on dev, applied; the SQL is not being executed for the
first time against production. `npm run db:validate -- <file>` runs any pending
migration on dev inside a transaction it rolls back, which is the cheap way to
ask "does this execute?" before a production window opens.
`src/lib/alerts/service-path.contract.test.ts` covers the other half: that the
argument list the sweep sends still matches the one the migration declares, so
this hazard can only ever be reintroduced by deploy order, never by a rename.

### Deleting an account leaves release-note rows behind

`202608310004` is written and **not applied**, so `purge_account_data` still
carries a table list from before `user_release_note_state` existed and does not
delete it.

The rows do go — the table cascades from `auth.users`. What is wrong is
`account_residual_data_count`, the measurement that gates deleting the auth user:
it reads zero while those rows are still present, so it is right by luck rather
than by looking.

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

### The alert sweep is exercised on production data, and always has been

`overview_alert_rules` held **0** rows in every environment for its whole life —
nothing in the product could create one — so the sweep that read it was never
exercised on a real reader's rule. `npm run verify:ov-alert-sweep` proved its
hit/stamp pair atomic against the dev project on 2026-08-31, and that is the only
thing it ever proved about real use. Both the script and the table are gone with
`202609200001`.

The surviving system does not have that gap. `price_alerts` holds real rows and
`alert_evaluation_runs` shows them being evaluated every fifteen minutes; the
sample above is four alerts on a tick.

What is **not** yet exercised anywhere is the `earnings` condition, for the
ordinary reason that nobody has created one yet — the condition reached the UI in
the same change that created it. Its first real exercise will be the first tick
after somebody saves one, against a database with `202609200001` applied.
