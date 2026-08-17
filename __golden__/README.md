# Market Signal golden snapshots

The single mechanical check for the Market Signal v2 build. Every phase ends by
regenerating these and reading the diff; nothing about the engine is verified by
looking at a screen.

```
candles/<SYMBOL>.json   frozen INPUT  — real provider OHLCV, captured once
signal/<SYMBOL>.json    OUTPUT        — the engine replayed over that input
```

Splitting it this way is what makes "byte-identical" mean anything. A snapshot
taken live would differ from itself an hour later: candles arrive daily,
`calculatedAt` is a clock read, and provider freshness moves on its own. Here the
input is a file and `calculatedAt` is pinned, so `signal/` is a pure function of
the repo — reproducible offline, in CI, and next month.

## Commands

```bash
npm run snapshot:signal              # replay frozen candles, rewrite signal/
npm run snapshot:signal -- --check   # replay and compare; non-zero on any diff
npm run snapshot:signal -- --refresh # re-fetch candles from real providers
```

`--refresh` is the only mode that touches the network, and it moves the baseline
on purpose. It also invalidates the pinned fixtures in
`src/lib/analytics/market-signal/reference.test.ts`, which assert the identity of
the IREN capture precisely so a refresh fails loudly instead of quietly.

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
