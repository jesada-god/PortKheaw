# P5 — the context layer, measured instead of built

`npm run signal:context` · `scripts/signal-context-probe.ts` · 108 instruments,
14,154 sampled days, same window / stride / horizons / split as the P4a run.

The instrument list is read from the calibration manifest named by
`MARKET_SIGNAL_MEASURED.runId` rather than from the corpus directory, which is a
cache that grows: another probe fetching its own list added a 109th instrument
mid-session, and a run that quietly measured 109 while calling itself comparable
to a 108-instrument run would be two different things under one heading. The
figures below were produced against `20260818T092020Z` and reproduce identically
against the P4b re-run `20260818T113633Z`, which pins the same 108 instruments.

**Outcome: nothing was built.** All four candidates fail the bar the brief set,
and `SIGNAL_CONTEXT` stays off with nothing behind it. This document is the
deliverable.

---

## The bar

From the brief, in order:

1. build it standalone, no engine;
2. measure edge against the same base rate as P4a;
3. **under 1pp at every horizon → do not build, report and skip**;
4. only if it passes, wire it in and measure again;
5. if the engine's edge does not rise, take it out.

Every candidate stopped at step 3 or, in one case, at the significance test that
sits beside it. Steps 4 and 5 were never reached, so no engine file was touched.

## What the run found

```
feature                                   | hor |  signal   clust |    base |    edge |    ±adj | sig?
------------------------------------------|-----|-----------------|---------|---------|---------|-----
relative strength vs SPY (63b, 2% band)   |   5 |   49.8%   12047 |   49.7% |  +0.1pp |  ±1.3pp |   no
                                          |  10 |   49.5%    6376 |   49.7% |  -0.2pp |  ±1.8pp |   no
                                          |  20 |   48.9%    3355 |   49.6% |  -0.7pp |  ±2.5pp |   no
compressed vol + 20-bar move              |   5 |   53.2%    3100 |   51.8% |  +1.4pp |  ±2.6pp |   no
                                          |  10 |   53.5%    1910 |   52.1% |  +1.4pp |  ±3.3pp |   no
                                          |  20 |   54.4%    1273 |   52.6% |  +1.8pp |  ±4.0pp |   no
  the same move, UNGATED (its control)    |   5 |   50.9%   14137 |   50.6% |  +0.3pp |  ±1.2pp |   no
                                          |  10 |   50.7%    7122 |   50.7% |  +0.0pp |  ±1.7pp |   no
                                          |  20 |   51.4%    3566 |   50.9% |  +0.5pp |  ±2.4pp |   no
price vs volume POC (120b, 0.5 ATR band)  |   5 |   50.5%   12523 |   51.4% |  -0.9pp |  ±1.3pp |   no
                                          |  10 |   51.1%    6623 |   51.7% |  -0.6pp |  ±1.8pp |   no
                                          |  20 |   52.4%    3448 |   52.1% |  +0.3pp |  ±2.4pp |   no
```

`±adj` is a two-sided 95% interval Bonferroni-adjusted for the nine primary
looks, computed on `clust` — the largest subset of observations sharing no
outcome bars — because at a 20-bar horizon with a 5-bar stride the raw n
overstates the evidence about fourfold.

### 1. Relative strength — SKIP

Largest gap 0.7pp, and negative at the two longer horizons: an instrument
outperforming SPY over the last quarter was very slightly LESS likely to
continue over the next month than the market's own base rate. It also fails the
regime test independently — train −1.1/−1.6/−2.4pp against test
+1.6/+1.7/+1.7pp, opposite signs at every horizon.

### 2. Volatility regime — SKIP, and it is the interesting one

A regime is not a direction, so this could not be tested as specified. What was
tested is the claim people actually make about it: that a compressed regime
precedes an expansion that continues the prevailing move. The gated version
scores +1.4/+1.4/+1.8pp, and the same 20-bar move taken **ungated** scores
+0.3/+0.0/+0.5pp — so compression appears to add about 1.3pp on its own terms,
consistently signed across all three horizons, which is more than anything else
in this report managed.

It still fails, for a reason worth being explicit about: it speaks on 3,103 days,
which is 1,273 independent facts at 20 bars, and its interval is ±4.0pp. A
+1.8pp reading inside a ±4.0pp band is not a finding, it is a number. The
train/test halves also give +1.8/+1.7/+1.0 against +0.7/+0.9/+2.8 — same sign
throughout, which is better than any other candidate managed, but the magnitudes
are not stable.

**This is the one worth re-measuring on more data**, not the one worth building.
If the corpus is ever extended backwards, run this first.

### 3. VPVR — SKIP

Largest gap 0.9pp and the wrong sign at the two shorter horizons: price above
the point of control was slightly less likely to continue up than base rate.
Train and test disagree in sign (−2.1/−1.9/−0.9 against +0.9/+1.3/+2.1).

Worth saying plainly, because VPVR is a feature people ask for by name: this does
not mean a volume profile is useless on a chart. It means the specific claim
"price above the POC continues up" does not survive measurement, and that is the
only claim a signal engine could act on.

### 4. Options / Expected Move — CANNOT BE MEASURED, not skipped

`__golden__/corpus/` is OHLCV. There is no historical options chain behind it and
no provider in the project backfills one, so there is no way to compute what an
expected-move band would have said on 2024-03-15 and no way to score it. The
other three failed a test; this one could not be given the test.

Three honest options, none of which is "build it and see":

* **Leave it.** Nothing is lost that was ever measured.
* **Record forward.** Snapshot the chain daily and revisit in a year. Cheap,
  slow, and the only route to an actual answer.
* **Ship it as disclosure, never as a signal** — the market's implied range,
  labelled as the market's opinion rather than the product's, entitled to Elite
  as specified. It would make no directional claim, so it needs no edge to
  justify it, and it must not be allowed to move a label or a score.

The third is defensible; it is a different product decision from the one P5 was
scoped to make, and it is yours.

## The verdicts as the script prints them

```
relative_strength       largest |edge|  0.67pp   SKIP — under 1pp at every horizon
volatility_compression  largest |edge|  1.75pp   SKIP — inside its own interval at every horizon
momentum_ungated        largest |edge|  0.49pp   SKIP — under 1pp at every horizon
vpvr_poc                largest |edge|  0.90pp   SKIP — under 1pp at every horizon
```

## The pattern underneath all four, which is a finding in itself

Every candidate — and the engine itself in P4a — is negative on the train half
and positive on the test half:

```
                        train (2023-04 → 2025-06)   test (2025-06 → 2026-07)
engine direction (P4a)      -0.8 / -1.7 / -2.3pp        +1.2 / +1.9 / +2.2pp
relative strength           -1.1 / -1.6 / -2.4pp        +1.6 / +1.7 / +1.7pp
vpvr POC                    -2.1 / -1.9 / -0.9pp        +0.9 / +1.3 / +2.1pp
momentum ungated            +0.1 / -0.6 / -0.1pp        +0.6 / +0.9 / +1.4pp
```

Four unrelated signals do not independently flip sign at the same date. This is a
property of the two market halves, not of any feature: trend-following of every
kind was punished in the first period and mildly rewarded in the second.

Two consequences, both load-bearing:

1. **No feature may be accepted on its test-half number**, however good. The test
   half is generous to everything, so a feature that only works there has
   demonstrated that it is trend-following, not that it works.
2. **P4b inherits a train half in which the signal underperformed.** Fitting on
   that half and verifying on this test half would produce a flattering number by
   construction. This has to be said out loud wherever a P4b figure is quoted.

## `completeness` is still inert, as predicted

The P1.5 note in `src/config/signal.ts` said `completeness` would wake up in P5
when optional sources started being genuinely absent. P5 added no optional
source, so it did not. Re-run at the close of P5, unchanged against the P1.5
baseline in every term:

```
                 P1.5 baseline          P5 close
base             median 0.778           median 0.7805
completeness     median 1.000  INERT    median 1.000  INERT
agreement        median 0.850           median 0.850   (min 0.575)
regimeClarity    median 0.800           median 0.800   (min 0.500)
conflict         median 0.970           median 0.970   (min 0.743)
earnings         median 1.000  INERT    median 1.000  INERT
```

Four live terms, same as at the close of P1.5. The comment in `signal.ts` that
promises P5 will wake `completeness` is now wrong and should be corrected to say
it did not — left for whoever opens the file next, since changing it would mean
another engine-file commit for a comment.

## What this cost and what it bought

One script, no engine change, no config change, no flag turned on, no migration.
The four features the brief listed would have been roughly two thousand lines of
engine, UI, entitlement and test code between them.

What it bought is the knowledge that none of them would have made the card more
accurate — which is the thing P4a's finding makes it very tempting to stop
checking, because a product that has just measured itself at zero has every
incentive to start adding things.
