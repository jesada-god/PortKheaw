# Market Signal golden snapshots

The single mechanical check for the Market Signal v2 build. Every phase ends by
regenerating these and reading the diff; nothing about the engine is verified by
looking at a screen.

```
candles/<SYMBOL>.json   frozen INPUT   — real provider OHLCV, captured once
signal/<SYMBOL>.json    BASELINE       — the engine replayed with every flag OFF
preview/<SYMBOL>.json   NOT a baseline — what the engine does with flags ON
```

`preview/` exists so a phase can be reviewed: it is what a reader would see if
the owner turned the flag on today. A flag-ON run writes there and **never**
touches `signal/`, so no stray environment variable can quietly redefine the
baseline. It is regenerated per phase and is evidence, not a gate.

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

## The pre-deploy gate

```bash
npm run snapshot:signal -- --check
```

with **every `SIGNAL_*` flag unset**. `--check` refuses to run at all if any of
them is on, because the baseline is by definition the flags-OFF output. If a
single field differs: stop, explain the field, do not deploy.

## Coverage

`IREN SPY QQQ DIA IWM REMX GC-F SI-F CL-F BTC-USD` — a single equity, four index
ETFs, a thin sector ETF, the three commodity contracts sold at Pro, and a
24-hour crypto pair whose candle boundaries differ from every other row.
