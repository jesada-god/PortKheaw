# Market Signal golden snapshots

The single mechanical check for the Market Signal v2 build. Every phase ends by
regenerating these and reading the diff; nothing about the engine is verified by
looking at a screen.

```
candles/<SYMBOL>.json           frozen INPUT   — real provider OHLCV, captured once
signal/<SYMBOL>.json            BASELINE       — the engine replayed with every flag OFF
preview/<combo>/<SYMBOL>.json   NOT a baseline — what the engine does with flags ON
```

`preview/` exists so a phase can be reviewed: it is what a reader would see if
the owner turned the flag on today. A flag-ON run writes there and **never**
touches `signal/`, so no stray environment variable can quietly redefine the
baseline. It is regenerated per phase and is evidence, not a gate.

One directory per COMBINATION — `gate-only`, `gate-zones`,
`gate-zones-actionable` — because the rollout turns flags on one at a time and
production passes through each of those states. A single flat `preview/` would
let the second combination silently overwrite the first, and both are legitimate
flag-ON output, so nothing would say it happened.

Splitting it this way is what makes "byte-identical" mean anything. A snapshot
taken live would differ from itself an hour later: candles arrive daily,
`calculatedAt` is a clock read, and provider freshness moves on its own. Here the
input is a file and `calculatedAt` is pinned, so `signal/` is a pure function of
the repo — reproducible offline, in CI, and next month.

## Commands

```bash
npm run snapshot:signal                       # replay frozen candles, rewrite signal/
npm run snapshot:signal -- --check            # replay and compare; non-zero on any diff
npm run snapshot:signal -- --refresh          # re-fetch candles from real providers
npm run snapshot:signal -- --refresh-earnings # re-read the calendar only, bars untouched
SIGNAL_GATE=true npm run snapshot:signal      # write preview/ for one phase
```

`--refresh` and `--refresh-earnings` are the only modes that touch the network.
`--refresh` moves the baseline on purpose, and it invalidates the pinned fixtures
in `src/lib/analytics/market-signal/reference.test.ts`, which assert the identity
of the IREN capture precisely so a refresh fails loudly instead of quietly.
`--refresh-earnings` deliberately cannot move the bars, so adding calendar
coverage to a capture can never disturb those fixtures.

The frozen input stores the next report **date**, not a number of days; days are
derived against the capture's own newest bar, so replaying a capture next month
produces the signal it produced today.

## Which flags name a preview directory — and which cannot

**Only the flags that reach the engine.** `calculateMarketSignal` takes a
`MarketSignalFeatures`, which has exactly three members, and
`scripts/snapshot-signal.ts` maps each one to its environment variable in a
single table (`ENGINE_FEATURE_OF`). Both the call into the engine and the
directory name are built from that table, so they cannot disagree.

| flag | reaches the engine? | in the directory name? |
| --- | --- | --- |
| `SIGNAL_GATE` | yes — `features.gate` | yes |
| `SIGNAL_ZONES` | yes — `features.zones` | yes |
| `SIGNAL_ACTIONABLE` | yes — `features.actionable` | yes |
| `SIGNAL_CONTEXT` | **no** | no |
| `SIGNAL_HISTORY` | **no** | no |

The last two are real rollout switches that change nothing this harness writes.
There used to be a `gate-zones-actionable-history/` directory, and it was a
byte-for-byte copy of `gate-zones-actionable/` wearing a name that announced
coverage it did not have. It is gone and the slug no longer produces it. The harness
prints a line naming any flag it left out of the directory name.

A run with an inert flag on and every engine flag off is the one case with no
combination directory of its own, and it does not get a third copy of the same
ten files: `--check` compares it against `signal/`, which is exactly what it
reproduces, so the check asserts that the inert flag really is inert. Writing is
still diverted away from `signal/` — that run is not a flags-OFF run and must
never be able to redefine the baseline.

### Why P6 history in particular cannot be snapshotted here

`history` is not engine output. It is attached afterwards, in
`src/lib/analytics/market-signal/service.ts`, from `readSignalHistory()` — a
Supabase read of `public.market_signal_history`. That table stores **what the
card said on which day**, the one thing in this system that cannot be
recomputed: replaying today's engine over yesterday's bars yields "yesterday's
bars at today's engine", which is a different statement.

This harness reaches no network and reads no clock, by design — that is the
property that makes byte-identical mean something. Reaching a live database from
it would destroy that, and a hand-seeded fixture database would only assert that
our own fixture round-trips. So the history payload is covered by tests instead:

| behaviour | covered by |
| --- | --- |
| `raw_state` column → `rawState` | `src/lib/analytics/market-signal/history-service.test.ts` |
| run-length counting, `null` when it cannot be counted honestly | `src/lib/analytics/market-signal/history.test.ts` |
| the hold rule vs. the raw reading (P8) | `src/lib/analytics/market-signal/persistence.test.ts` |
| what the strip draws and refuses to draw | `src/components/analytics/market-signal/MarketSignalSection.test.tsx` |

## The pre-deploy gate

```bash
npm run snapshot:signal -- --check
```

with **every `SIGNAL_*` flag unset**. That is the only run that may WRITE
`signal/`, and the only one whose pass is the gate. A flag-ON `--check` is
allowed and compares against that combination's own `preview/` directory; it
answers "did turning this flag on do what it did last time?", which is a
different and smaller question, and it labels itself `PREVIEW` rather than
`GATE`. If a single field differs: stop, explain the field, do not deploy.

## Coverage

`IREN SPY QQQ DIA IWM REMX GC-F SI-F CL-F BTC-USD` — a single equity, four index
ETFs, a thin sector ETF, the three commodity contracts sold at Pro, and a
24-hour crypto pair whose candle boundaries differ from every other row.
