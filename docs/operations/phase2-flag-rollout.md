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

| Flag | What turning it on does | Spends | Migration needed |
|---|---|---|---|
| `PHASE2_MARKET_SNAPSHOT` | Adds the market strip, the status word and its reasons to ตลาดวันนี้ | **Yes — the only one that spends.** Six provider quotes, behind a 60-second shared cache and a last-good snapshot, so a burst of readers costs one round rather than one each | None |
| `PHASE2_WHAT_CHANGED` | Shows the renamed change feed | No. Renames items the watchlist detectors already produce — a mapping with a dedupe, no request, no clock, no history read | None |
| `PHASE2_EVENTS` | Shows the 12-month macro calendar and its relevance join | No. The calendar is a static JSON already in the bundle; the symbol join is one array pass over lists the page holds | None |
| `PHASE2_ALERTS` | Two separate things — see below | One indexed row read per render | `202608300001`, `202608310001`, `202608310002` — **all applied**. `202608310003` for `earnings` rules — **not applied** |

`PHASE2_MARKET_SNAPSHOT` and the watchlist-view pair are read *before* their
promises are constructed, so with a flag off the work is never started rather
than started and discarded. `src/config/phase2-flags.test.ts` asserts that
against the source of `app/page.tsx`.

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

The four are independent — none reads another's output — so this order is about
what you can still attribute when something moves, not about correctness.

1. **`PHASE2_EVENTS`** — costs nothing and touches no database. If the page
   changes shape, it is the calendar and nothing else.
2. **`PHASE2_WHAT_CHANGED`** — also free. Note the capped watchlist view needs
   `WATCHLIST_V2` as well; this flag alone does not turn that on.
3. **`PHASE2_MARKET_SNAPSHOT`** — the only one that buys anything. Turn it on
   alone and watch provider usage for one session before adding the next, since
   it is the only flag whose cost can grow with traffic.
4. **`PHASE2_ALERTS`** — last, and only after `202608310003` is applied. It is
   the only one with a write path, and the sweep it starts runs unattended every
   fifteen minutes.

Measured together at 1.03×, so the order is not protecting a budget — it is
protecting attribution.

## Not ready

### `earnings` alert rules cannot be created

`202608310003` is written and **not applied**. Until it is,
`create_overview_alert_rule` refuses `earnings`, which is one of the five kinds
the feature is built around. The column, the hits table, the evaluator and the
24-hour cooldown all handle it; only the writer refuses.

`PHASE2_ALERTS` is safe to turn on before that migration — the four price and
percent kinds work — but the feature is a fifth short until it lands.

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

### The sweep has never been verified end to end

`runOvAlertSweep` has never run against a real database. See
"What is still unverified" in the Phase 2 finalization report: production holds
**0** `overview_alert_rules`, so a sweep there has nothing to evaluate, and
creating a test rule needs either a session or a write into a real account.

What that leaves unproven, specifically:

- that a hit row and `overview_alert_rules.last_fired_at` are written in the same
  transaction, with no row carrying one without the other;
- that a second sweep inside the cooldown writes nothing.

Both are asserted in `sweep.test.ts` against an in-memory double, and the double
models the pair as atomic because the RPC does. Neither has been observed in
Postgres. Turning `PHASE2_ALERTS` on is what would first exercise them, on live
readers' rules.
