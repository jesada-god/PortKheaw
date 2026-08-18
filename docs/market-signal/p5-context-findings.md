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

**DECIDED: nothing is built.** No historical chain means it cannot be tested,
and an untestable feature does not get made. The flag stays off and there is no
code behind it.

That leaves only the question of whether it is worth starting to COLLECT, so the
question becomes answerable later. The arithmetic below is what that would cost
in time, and it is worse than "revisit in a year".

### How long before a forward-collected chain could answer anything

To conclude anything, the 95% interval has to exclude zero, so the interval's
half-width must be smaller than the edge being looked for. On a rate near 50%
that is `n > 0.96 / d²` INDEPENDENT observations, where `d` is the edge in
decimal.

```
edge to detect | independent observations needed
---------------|--------------------------------
        2.0pp  |   2,401
        1.0pp  |   9,604      <- the bar P5 actually used
```

Independent means non-overlapping outcome windows, which is `252 / horizon` per
instrument per year — 50 at 5 bars, 25 at 10, 12.6 at 20. Of the 108 instruments
in the corpus, roughly 85 have options liquid enough to quote a usable expected
move (the three futures contracts, the crypto pairs and the thinner ETFs drop
out). So one year of daily collection buys about:

```
horizon | independent observations per year
--------|----------------------------------
      5 |  ~4,300
     10 |  ~2,100
     20 |  ~1,070
```

Which gives:

```
                        | 5 bars | 10 bars | 20 bars
------------------------|--------|---------|--------
detect a 2pp edge       |  ~7 mo |  ~14 mo |  ~27 mo
detect a 1pp edge (P5)  | ~27 mo |  ~55 mo | ~110 mo
```

**Read the bottom-right corner before deciding anything.** P5's criterion
requires the edge to hold at every horizon, so the binding number is the 20-bar
column: roughly **three years** of daily collection before a 2pp effect could be
established across all three, and something like a decade for the 1pp bar this
programme actually used.

And that is only the sampling arithmetic. The regime rule from P4a applies on top:
a collection window that spans one market state cannot satisfy "same sign on both
halves of a split", so three years of a single rising market would fail the test
even with the observations in hand.

### What to do with that

**The first honest look is at about twelve months, at the 5-bar horizon only, and
it can only ever be suggestive.** Anything earlier is a number with an interval
wider than any effect worth having.

That is an argument for collecting cheaply and forgetting about it, not for
planning a project around it. A daily row per symbol — spot, front-month expiry,
days to it, ATM implied volatility, and the implied move it prices — is enough to
reconstruct the signal later and is a few kilobytes a day. Nothing has to be
built now, nothing has to be shown to anybody, and the decision to measure can be
made in a year by somebody who has the data rather than by somebody estimating.

If that collection is not started, this stays permanently unanswerable, which is
also a legitimate choice — it is the current state and it has cost nothing.

### The one thing that would NOT need any of this

Shipping the market's implied range as **disclosure** — labelled as the market's
opinion rather than the product's, Elite-entitled as specified — makes no
directional claim, so it needs no edge to justify it. It would have to be barred
from moving a label, a score or a threshold, and it is a different product
decision from the one P5 was scoped to make. Still open, still yours.

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

---

# OPEN QUESTION — the sign flip, and what "edge = 0" might be hiding

**INTERNAL ONLY. This section must never reach the card, the changelog, the
pricing page or any other reader-facing surface.** It is a hypothesis with no
measurement behind it, and the distance between "we have not tested this" and "we
found something" is exactly the distance this whole programme exists to keep.
Nothing here weakens the not-a-forecast line: that line reports what WAS
measured, and this is a note about what was not.

## What was observed

Four features that share no construction — relative strength against an index,
a volume-profile location, a 20-bar price move, and the engine's own zone
structure — are negative on the train half and positive on the test half, at
every horizon, with the flip landing on the same date.

Unrelated signals do not independently change sign on the same day. Something
about the two periods differs systematically, and it acts on anything that leans
on trend continuation. **The features are not broken. The halves are different.**

## Why that matters more than it first appears

The headline figure for every one of them, and for the engine, is the
FULL-SAMPLE average of the two halves. If the two halves are two different
market states in which the same signal genuinely behaves differently — helpful
in one, harmful in the other — then an average near zero is not the absence of a
signal. It is two signals of opposite sign cancelling.

Those are very different statements about the product:

* **"No signal"** — the engine's direction carries no information, and the card
  is right to say so.
* **"Two states cancelling"** — the direction carries information CONDITIONAL on
  something not currently in the model, and the unconditional average hides it.

P4a and P5 measured the first and cannot distinguish it from the second. The
regime split by SPY's 200-day average is not that distinction either: it splits
by a definition chosen in advance, and the flip does not line up with it — the
`down` regime rows are small, noisy and inconsistent in sign at different
horizons.

## Why it has NOT been tested, and why testing it is dangerous

This hypothesis has the shape that produces false discoveries most reliably:

* the split point is **already known** from having looked at the data — any test
  that uses the 2025-06-30 boundary is testing a boundary chosen because it
  worked;
* "find the conditioning variable that makes the edge appear" is a search over
  an unbounded space of variables, and something always fits;
* two halves means one degree of freedom and roughly 1,800 independent
  observations per half at the 20-bar horizon, which is not enough to establish a
  conditional effect that the unconditional test could not see;
* a conditional model that works is indistinguishable, on this corpus, from a
  model that has learned the dates.

So the requirements for taking it seriously are stricter than P5's, not looser:

1. the conditioning variable must be **named and defined in advance**, from
   economic reasoning rather than from inspecting the split;
2. it must be computable **at the as-of bar** with no look-ahead — a regime label
   that needs to see the following month is not a feature, it is the answer;
3. it must be tested on a **third period** the corpus does not currently contain,
   because both existing halves have been looked at;
4. the effect must survive with the split point moved — if it only exists at
   2025-06-30, it is that date and not a regime;
5. a stated correction for the number of conditioning variables tried, since the
   whole risk here is that trying enough of them guarantees one.

Until all five are met, the product's position is unchanged and is the one on the
card: **no edge was found.** That statement remains true and is not softened by
this note — "we did not find one" is exactly what it says, and this is a note
about a place nobody has looked yet.

## What would actually settle it

More corpus, not more cleverness. The corpus covers 2023-04 to 2026-07 and is
mostly one rising market. A backwards extension through 2020-2022 would supply a
genuine drawdown and a genuine recovery, and would let the question be asked with
the split defined before the data is seen. That is a data-collection task, not a
modelling one, and it is the only version of this that could produce an answer
worth acting on.

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
