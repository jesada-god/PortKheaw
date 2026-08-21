# Does the label describe what price already did?

A measurement of the card's FIRST claim — "การ์ดนี้อธิบายสิ่งที่ราคาทำไปแล้ว" — which no
run has ever tested. P4a/P4b/P5/P6 tested the SECOND claim (does the direction beat
the base rate forward: no). This file contains no forward return, no hit rate and no
base rate of any kind. Every quantity is computed from bars at or before the bar being
labelled.

No engine file, config value, label, threshold or line of copy was touched. The ground
truth, the mapping and the verdict rule were written into
`scripts/signal-trend-agreement-probe.ts` before the run that filled this in, and the
verdict below is the one the code computed.

## The ground truth ★

```
window            N = 20 bars, ending AT bar t — no future bar is read
displacement      (close_t - close_t-N) / ATR14_t
efficiency        |close_t - close_t-N| / Σ|close_i - close_i-1| over the window
UP                displacement >= +1.5 and efficiency >= 0.3
DOWN              displacement <= -1.5 and efficiency >= 0.3
SIDEWAYS          everything else
ATR14             Wilder, computed by the probe from the frozen bars, NEVER read off
                  `metrics.atr14` — the labeller may not borrow its yardstick from the
                  thing it is measuring
```

**These four numbers are a design choice, not the truth.** N, the ATR period, 1.5 and
0.3 were picked by a person. A disagreement below does not prove the engine wrong — it
proves the two disagree. §4 re-runs the entire verdict across 27 versions of them, and
§5 lists the ten worst conflicts with symbol and date so a chart can settle them.

## Run

```
corpus            108 instruments — pinned to 20260818T113633Z via its manifest
period            2023-04-09 .. 2026-07-27
bars labelled     72805   (stride 1, left window 600 bars, both flag states)
calculatedAt      2026-01-01T00:00:00.000Z   (pinned — no clock, no network)
engine OFF        features { gate: false, zones: false, actionable: false }  — ships today
engine ON         features { gate: true,  zones: true,  actionable: false }
indicator drift   0 bars where the two flag states disagreed about ema50SlopePct /
                  ema200 / close. Must be 0: the baselines are read off the OFF run and
                  would otherwise not be seeing the same data as the ON engine.
guard             a cell reports insufficient below n 30 OR clust 30; buckets are NEVER merged
intervals         on clust (spacing >= N bars), two-sided 95% — naive z 1.96, Bonferroni
                  z 2.498 for 4 looks (OFF, ON, B1, B2)
lag cap           60 bars; an event with fewer than 60 bars left in the capture is
                  dropped, not counted as fast and not counted as censored
look-ahead check  the labeller re-run on bars[0..t] — a capture that cannot contain a
                  future bar — reproduced its own answer at 27 of 27 sampled
                  bars (0 mismatches)
```

Ground truth over the labelled bars: UP 15479, DOWN 8008, SIDEWAYS 49318 (21.3% /
11.0% / 67.7%). This is a description of the corpus, not a target:
a labeller that said SIDEWAYS always would score that number and describe nothing,
which is what the flip ratio and the confusion matrix are there to catch.

## 1. The four numbers

| | agreement | 95% CI (clust) | Bonferroni | UP<->DOWN | lag median | lag p90 | flip ratio | n | clust |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| engine · flags OFF (ships today) | 42.3% | ±1.6pp | ±2.1pp | 0.2% | 0 | 34 | 1.06 | 62872 | 3560 |
| engine · GATE+ZONES ON | 72.5% | ±1.5pp | ±1.9pp | 0.0% | 1 | 15 | 1.03 | 63010 | 3561 |
| B1 · sign(ema50SlopePct), \|slope\| < 0.1% -> SIDEWAYS | 33.2% | ±1.5pp | ±1.9pp | 1.5% | 0 | 39 | 0.38 | 72805 | 3674 |
| B2 · close vs ema200 (no SIDEWAYS) | 27.7% | ±1.4pp | ±1.8pp | 4.5% | 0 | 8 | 0.33 | 72805 | 3674 |

`lag` is in bars: the ground truth changes at bar t, and this is how long until the
label says the same thing. `flip ratio` is label changes ÷ ground-truth changes over
the same bars — **above 1.0 the source speaks more often than the thing it describes.**

A flip counts every change in the word the source shows, SQUEEZE and OVEREXTENDED
included: they are excluded from agreement because they are not directions, but a card
that goes BULLISH -> SQUEEZE -> BULLISH changed its word twice in front of a reader and
the flip ratio is the one number here that has to say so.

| | ground-truth changes | label changes | lag events | censored (> cap) | dropped (end of capture) | label already there |
| --- | --- | --- | --- | --- | --- | --- |
| engine · flags OFF (ships today) | 8603 | 9121 | 7852 | 822 | 751 | 3430 |
| engine · GATE+ZONES ON | 8603 | 8879 | 7852 | 438 | 751 | 3506 |
| B1 · sign(ema50SlopePct), \|slope\| < 0.1% -> SIDEWAYS | 8603 | 3294 | 7852 | 1453 | 751 | 3208 |
| B2 · close vs ema200 (no SIDEWAYS) | 8603 | 2867 | 7852 | 4179 | 751 | 2832 |

The lag median and p90 are computed over the events that RESOLVED. Censored events —
the label never caught up inside 60 bars — are counted beside them rather than
folded in at the cap, because a cap value is not a measured lag; read the two columns
together or not at all.

"label already there" counts events where the source was ALREADY saying the new word on
the bar before the ground truth changed to it. It is reported because it is the only
thing here that could be mistaken for anticipation, and it is not evidence of any: a
source that says UP most of the time is already saying UP before most changes to UP.

## 2. Confusion matrices

Ground truth down the side, label across the top. **SIDEWAYS confusion is a threshold
disagreement; UP<->DOWN is a description that is backwards.**

**engine · flags OFF (ships today)**

| truth \ label | UP | DOWN | SIDEWAYS | row total | row correct |
| --- | --- | --- | --- | --- | --- |
| **UP** | 12822 | 27 | 125 | 12974 | 98.8% |
| **DOWN** | 76 | 6752 | 369 | 7197 | 93.8% |
| **SIDEWAYS** | 21512 | 14168 | 7021 | 42701 | 16.4% |

UP<->DOWN: **103** of 62872 (0.2%).

SQUEEZE / OVEREXTENDED — reported apart, never folded into the 3x3: **9933** bars
(ground truth there: UP 2505, DOWN 811, SIDEWAYS 6617).

**engine · GATE+ZONES ON**

| truth \ label | UP | DOWN | SIDEWAYS | row total | row correct |
| --- | --- | --- | --- | --- | --- |
| **UP** | 7262 | 2 | 5660 | 12924 | 56.2% |
| **DOWN** | 6 | 3426 | 3756 | 7188 | 47.7% |
| **SIDEWAYS** | 4302 | 3591 | 35005 | 42898 | 81.6% |

UP<->DOWN: **8** of 63010 (0.0%).

SQUEEZE / OVEREXTENDED — reported apart, never folded into the 3x3: **9795** bars
(ground truth there: UP 2555, DOWN 820, SIDEWAYS 6420).

**B1 · sign(ema50SlopePct), \|slope\| < 0.1% -> SIDEWAYS**

| truth \ label | UP | DOWN | SIDEWAYS | row total | row correct |
| --- | --- | --- | --- | --- | --- |
| **UP** | 14867 | 479 | 133 | 15479 | 96.0% |
| **DOWN** | 606 | 7238 | 164 | 8008 | 90.4% |
| **SIDEWAYS** | 27549 | 19705 | 2064 | 49318 | 4.2% |

UP<->DOWN: **1085** of 72805 (1.5%).

**B2 · close vs ema200 (no SIDEWAYS)**

| truth \ label | UP | DOWN | SIDEWAYS | row total | row correct |
| --- | --- | --- | --- | --- | --- |
| **UP** | 14574 | 905 | 0 | 15479 | 94.2% |
| **DOWN** | 2382 | 5626 | 0 | 8008 | 70.3% |
| **SIDEWAYS** | 33810 | 15508 | 0 | 49318 | 0.0% |

UP<->DOWN: **3287** of 72805 (4.5%).

## 3. VERDICT

# FAIL

The rule, from the probe header, applied by `verdictFor()`:

> The better baseline is taken PER METRIC — the higher of B1/B2 agreement and the lower
> of B1/B2 flip ratio. An engine state passes only if it beats that on BOTH. The
> headline is the OFF state's, because OFF is what ships today (handover §1.3). The ON
> state is reported beside it and cannot rescue it.

| | agreement | better baseline | beat it? | flip ratio | better baseline | beat it? | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| engine OFF (headline) | 42.3% | 33.2% | yes | 1.06 | 0.33 | **no** | **FAIL** |
| engine ON | 72.5% | 33.2% | yes | 1.03 | 0.33 | **no** | **FAIL** |

## 4. Sensitivity — 27 versions of the ground truth

The whole verdict, recomputed for every combination of N ∈ {15, 20, 25}, displacement ∈
{1.2, 1.5, 1.8} and efficiency ∈ {0.25, 0.3, 0.35}. The engine labels are the same run
every time; only the definition of the thing they are compared against moves.

**OFF passes at 0 of 27 grid points. ON passes at 0 of 27.**

| N | disp | eff | truth UP/DOWN/SIDE % | OFF agree | ON agree | B1 agree | B2 agree | OFF flip | ON flip | B1 flip | B2 flip | OFF | ON |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 15 | 1.2 | 0.25 | 29/18/52 | 53.8% | 68.3% | 42.0% | 37.3% | 0.70 | 0.69 | 0.25 | 0.22 | FAIL | FAIL |
| 15 | 1.2 | 0.3 | 25/15/61 | 47.2% | 71.9% | 36.1% | 31.6% | 0.79 | 0.77 | 0.29 | 0.25 | FAIL | FAIL |
| 15 | 1.2 | 0.35 | 20/11/68 | 40.4% | 74.1% | 30.4% | 26.0% | 0.91 | 0.88 | 0.33 | 0.28 | FAIL | FAIL |
| 15 | 1.5 | 0.25 | 29/18/53 | 53.6% | 68.6% | 41.8% | 37.0% | 0.71 | 0.69 | 0.26 | 0.22 | FAIL | FAIL |
| 15 | 1.5 | 0.3 | 25/15/61 | 47.1% | 71.9% | 36.1% | 31.5% | 0.79 | 0.77 | 0.29 | 0.25 | FAIL | FAIL |
| 15 | 1.5 | 0.35 | 20/11/68 | 40.4% | 74.1% | 30.4% | 26.0% | 0.90 | 0.88 | 0.33 | 0.28 | FAIL | FAIL |
| 15 | 1.8 | 0.25 | 28/17/54 | 52.7% | 69.5% | 40.8% | 36.0% | 0.72 | 0.70 | 0.26 | 0.23 | FAIL | FAIL |
| 15 | 1.8 | 0.3 | 24/14/61 | 46.9% | 72.2% | 35.8% | 31.2% | 0.80 | 0.78 | 0.29 | 0.25 | FAIL | FAIL |
| 15 | 1.8 | 0.35 | 20/11/68 | 40.3% | 74.2% | 30.3% | 26.0% | 0.91 | 0.88 | 0.33 | 0.29 | FAIL | FAIL |
| 20 | 1.2 | 0.25 | 26/15/59 | 50.5% | 69.4% | 40.6% | 34.5% | 0.90 | 0.88 | 0.33 | 0.28 | FAIL | FAIL |
| 20 | 1.2 | 0.3 | 21/11/68 | 42.3% | 72.5% | 33.2% | 27.7% | 1.06 | 1.03 | 0.38 | 0.33 | FAIL | FAIL |
| 20 | 1.2 | 0.35 | 17/8/75 | 34.8% | 74.2% | 26.5% | 21.8% | 1.27 | 1.24 | 0.46 | 0.40 | FAIL | FAIL |
| 20 | 1.5 | 0.25 | 26/15/59 | 50.5% | 69.4% | 40.6% | 34.5% | 0.90 | 0.88 | 0.33 | 0.28 | FAIL | FAIL |
| 20 ★ | 1.5 | 0.3 | 21/11/68 | 42.3% | 72.5% | 33.2% | 27.7% | 1.06 | 1.03 | 0.38 | 0.33 | FAIL | FAIL |
| 20 | 1.5 | 0.35 | 17/8/75 | 34.8% | 74.2% | 26.5% | 21.8% | 1.27 | 1.24 | 0.46 | 0.40 | FAIL | FAIL |
| 20 | 1.8 | 0.25 | 26/15/59 | 50.5% | 69.5% | 40.6% | 34.5% | 0.90 | 0.88 | 0.33 | 0.28 | FAIL | FAIL |
| 20 | 1.8 | 0.3 | 21/11/68 | 42.3% | 72.5% | 33.2% | 27.7% | 1.06 | 1.03 | 0.38 | 0.33 | FAIL | FAIL |
| 20 | 1.8 | 0.35 | 17/8/75 | 34.8% | 74.2% | 26.5% | 21.8% | 1.27 | 1.24 | 0.46 | 0.40 | FAIL | FAIL |
| 25 | 1.2 | 0.25 | 24/12/64 | 45.4% | 70.1% | 37.7% | 31.7% | 1.08 | 1.05 | 0.39 | 0.34 | FAIL | FAIL |
| 25 | 1.2 | 0.3 | 19/8/73 | 36.9% | 72.9% | 29.4% | 24.5% | 1.32 | 1.28 | 0.48 | 0.41 | FAIL | FAIL |
| 25 | 1.2 | 0.35 | 14/5/81 | 29.3% | 74.0% | 22.3% | 18.0% | 1.68 | 1.63 | 0.60 | 0.53 | FAIL | FAIL |
| 25 | 1.5 | 0.25 | 24/12/64 | 45.4% | 70.1% | 37.7% | 31.7% | 1.08 | 1.05 | 0.39 | 0.34 | FAIL | FAIL |
| 25 | 1.5 | 0.3 | 19/8/73 | 36.9% | 72.9% | 29.4% | 24.5% | 1.32 | 1.28 | 0.48 | 0.41 | FAIL | FAIL |
| 25 | 1.5 | 0.35 | 14/5/81 | 29.3% | 74.0% | 22.3% | 18.0% | 1.68 | 1.63 | 0.60 | 0.53 | FAIL | FAIL |
| 25 | 1.8 | 0.25 | 24/12/64 | 45.4% | 70.1% | 37.7% | 31.7% | 1.08 | 1.05 | 0.39 | 0.34 | FAIL | FAIL |
| 25 | 1.8 | 0.3 | 19/8/73 | 36.9% | 72.9% | 29.4% | 24.5% | 1.32 | 1.28 | 0.48 | 0.41 | FAIL | FAIL |
| 25 | 1.8 | 0.35 | 14/5/81 | 29.3% | 74.0% | 22.3% | 18.0% | 1.68 | 1.63 | 0.60 | 0.53 | FAIL | FAIL |

★ marks the pre-registered definition, the one §3 decides on. The UP/DOWN/SIDE column
is the ground truth's own mix at that grid point, measured over B2's rows (B2 labels
every bar, so its denominator is the full population).

## 5. The ten worst conflicts — open these charts

Bars the definition calls a MOVE and the engine does not describe as one, worst first.
Three kinds, ranked in this order because they are not equally bad:

- **`opposite`** — an engine state named the OTHER direction. A backwards description.
- **`missed`** — NEITHER state named this direction (SIDEWAYS, SQUEEZE or OVEREXTENDED
  while price travelled that far in a straight line). A quiet one, not a wrong one.
- **`split`** — one flag state named it and the other did not. The disagreement is
  between the two engines, and the flag decides which sentence a reader gets.

One row per instrument, so this is ten different charts rather than ten bars of one
episode. 108 of 108 instruments have at least one conflicting bar; 110 bars in the
whole corpus are `opposite`, spread over 57 instruments. Whether the engine or the
definition is wrong on a given row is a question a chart answers and this file does not.

| # | kind | symbol | date | ground truth | engine OFF | engine ON | displacement (ATR) | efficiency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `opposite` | NFLX | 2026-03-23 | UP | DOWN | SIDEWAYS | 6.42 | 0.50 |
| 2 | `opposite` | SBUX | 2024-05-29 | DOWN | UP | SIDEWAYS | -5.66 | 0.34 |
| 3 | `opposite` | MRK | 2024-08-26 | DOWN | UP | SIDEWAYS | -5.11 | 0.37 |
| 4 | `opposite` | ABBV | 2024-12-02 | DOWN | UP | SIDEWAYS | -5.03 | 0.36 |
| 5 | `opposite` | XRP-USD | 2024-10-19 | DOWN | UP | SIDEWAYS | -5.02 | 0.45 |
| 6 | `opposite` | TXN | 2025-12-19 | UP | DOWN | SIDEWAYS | 5.01 | 0.47 |
| 7 | `opposite` | SOL-USD | 2023-06-24 | DOWN | UP | SIDEWAYS | -4.86 | 0.39 |
| 8 | `opposite` | NCLH | 2024-05-22 | DOWN | UP | SIDEWAYS | -4.57 | 0.39 |
| 9 | `opposite` | EEM | 2024-12-06 | DOWN | UP | UP | -4.56 | 0.42 |
| 10 | `opposite` | ACN | 2026-07-14 | DOWN | UP | SIDEWAYS | -4.52 | 0.34 |

---

## Not part of the verdict

Everything above was fixed before the run. This section is what was noticed
afterwards; it changes nothing above it and is written down so the next round does not
have to rediscover it. Every number in it is computed by the same file, not typed in.

### 1. The displacement threshold is inert over its whole tested range

Re-labelling the whole corpus with one knob at each end of its tested range, and
counting the bars whose label changed:

| knob | from -> to | bars re-labelled |
| --- | --- | --- |
| displacement | 1.2 -> 1.8 (N 20, eff 0.3) | 0 of 72805 (0.0%) |
| efficiency | 0.25 -> 0.35 (N 20, disp 1.5) | 12203 of 72805 (16.8%) |
| N | 15 -> 25 (disp 1.5, eff 0.3) | 20082 of 72805 (27.6%) |

The reason is arithmetic, not data: over 20 bars a path that is 30% efficient has
already travelled several ATRs end to end, so a window that clears the efficiency gate
clears 1.8 as well — in this corpus, without a single exception. **The ground truth is, in practice,
an efficiency rule that reads its sign off displacement.** The §4 rows that repeat down
the displacement column are that fact, not a copy-paste error, and anyone re-running
this should spend the sensitivity budget on efficiency and N instead.

### 2. The one dimension the engine wins on is not in the verdict

Cross-polarity — the label naming the direction opposite to the move — is where the
two baselines are worst and the engine is best, by a wide margin:

- engine OFF **0.2%** · engine ON **0.0%** · B1 1.5% · B2 4.5%

The pre-registered rule scores agreement and flip ratio, so this changes nothing about
the FAIL. It is still the most defensible sentence available about the label: whatever
else it does, it very rarely points the wrong way. `docs/signal-handover.md` should
carry that as a measured claim rather than the stronger one the card makes.

### 3. The two flag states fail in opposite directions

| | UP rows correct | DOWN rows correct | SIDEWAYS rows correct | flip ratio |
| --- | --- | --- | --- | --- |
| engine OFF | 98.8% | 93.8% | 16.4% | 1.06 |
| engine ON | 56.2% | 47.7% | 81.6% | 1.03 |

OFF names a direction almost every time the definition names one, and also names one
through most of what the definition calls quiet: it OVER-speaks. ON is the mirror — it
holds SIDEWAYS through more than half of the moves the definition does name: it
UNDER-speaks. Same engine, same bars; §5 of the handover says the zone frame is what
separates them, and this is that rule's cost and benefit in one table.

### 4. "Speaks more often than the thing it describes" survives the whole grid for OFF

Across all 27 definitions the OFF flip ratio runs 0.70 .. 1.68 — above 1.0 at every
single one. ON runs 0.69 .. 1.63 and dips under 1.0 only where N is 15, i.e. only when
the ground truth is allowed to change its own mind fastest. The shipped card changes
its word more often than the move it describes changes, under every definition tested.

### 5. What the baselines' low flip ratios are actually made of

B2 cannot say SIDEWAYS at all, and 4179 of its 7852 lag events never resolve because of
it. B1 says SIDEWAYS on 3.2% of its bars. Both are smooth two-state labellers, and a
two-state labeller flips rarely for the same reason it describes the majority class
badly. The verdict rule was written before any of this was visible and it stands as
written — but a future round that wants a flip-ratio comparator should build one that
can express all three states, not read this one as "simpler is calmer".

### 6. The regime veto is flag-independent, as documented

SQUEEZE / OVEREXTENDED covers 9933 bars with flags off and 9795 with GATE+ZONES on
— NOT identical, which contradicts what handover §5 says ("regime มาก่อนทุกอย่าง", veto สูงสุด, เสมอ).
Of those bars the definition calls 3316 a move (UP 2505, DOWN 811) and
6617 quiet — so the veto lands on a real move about 33.4% of the time it fires.
Whether a reader is better served by "SQUEEZE" than by the direction on those bars is a
copy question this file cannot answer, but it is not a rare case.

```
shards            4 files under .qa/trend-agreement/
reproduce         npm run signal:trend-agreement -- --shard=0/4   (0..3, in parallel)
                  npm run signal:trend-agreement
```

