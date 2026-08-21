# `histogramExpanding` against the §6.6 sideways gap

A measurement. No engine file, config value, label or feature was touched to
produce it, and the decision rule below was written into
`scripts/signal-sideways-pressure-probe.ts` before the run that filled this in.

## The question

`docs/signal-handover.md` §6.6:

```
horizon | still sideways | stayed inside frame |      n
     20 |          72.6% |               25.7% |  10525
```

The label outlives the story it tells. Does `metrics.histogramExpanding` separate
the sideways calls where price stays put from the ones where it does not?

## Run

```
corpus            108 instruments — pinned to 20260818T113633Z via its manifest
period            2023-04-09 .. 2026-07-27
observations      14154   (stride 5 bars, left window 600 bars)
sideways rows     10525   — the §6.6 population
time split        train < 2025-06-30 <= test   (the P4a boundary, read from the manifest)
guard             a branch reports insufficient below n 30 OR clust 30; branches are NEVER merged
intervals         on clust, two-sided 95% — naive z 1.96, Bonferroni z 2.638 for 6 looks
```

**Rows the four-way split cannot place: 0** of 10525
(`histogramExpanding === null` — no previous bar, or a bar identical to it — or a
histogram sitting exactly on zero). They are excluded and not redistributed.

## 1. The four branches

`expanding` is the ENGINE's reading, not the bar's size: true when a bar ABOVE
zero gets longer and when a bar BELOW zero gets shorter. Read with
`macdHistogram > 0`, never alone.

| branch | still sideways @5 / @10 / @20 | stayed inside frame @5 / @10 / @20 | n | clust @5 / @10 / @20 |
| --- | --- | --- | --- | --- |
| `rising_extending`<br>histogram > 0 · expanding  (bar above zero, getting longer) | 76.9% / 73.1% / 73.0% | 60.5% / 43.2% / 25.3% | 2403 | 2403 / 1905 / 1502 |
| `rising_fading`<br>histogram > 0 · contracting (bar above zero, getting shorter) | 81.4% / 74.2% / 71.9% | 66.3% / 47.0% / 27.7% | 2546 | 2546 / 2049 / 1562 |
| `falling_easing`<br>histogram < 0 · expanding  (bar below zero, getting shorter) | 80.4% / 75.5% / 73.8% | 64.1% / 46.7% / 26.5% | 2982 | 2982 / 2358 / 1794 |
| `falling_deepening`<br>histogram < 0 · contracting (bar below zero, getting longer) | 78.3% / 72.0% / 71.4% | 60.4% / 42.0% / 23.3% | 2594 | 2594 / 2123 / 1632 |

### The same table with intervals, on `clust`

| branch | horizon | still sideways | 95% | Bonf. | inside frame | 95% | Bonf. | clust |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `rising_extending` | 5 | 76.9% | ±1.7pp | ±2.3pp | 60.5% | ±2.0pp | ±2.6pp | 2403 |
| `rising_extending` | 10 | 73.1% | ±2.0pp | ±2.7pp | 43.2% | ±2.2pp | ±3.0pp | 1905 |
| `rising_extending` | 20 | 73.0% | ±2.2pp | ±3.0pp | 25.3% | ±2.2pp | ±3.0pp | 1502 |
| `rising_fading` | 5 | 81.4% | ±1.5pp | ±2.0pp | 66.3% | ±1.8pp | ±2.5pp | 2546 |
| `rising_fading` | 10 | 74.2% | ±1.9pp | ±2.6pp | 47.0% | ±2.2pp | ±2.9pp | 2049 |
| `rising_fading` | 20 | 71.9% | ±2.2pp | ±3.0pp | 27.7% | ±2.2pp | ±3.0pp | 1562 |
| `falling_easing` | 5 | 80.4% | ±1.4pp | ±1.9pp | 64.1% | ±1.7pp | ±2.3pp | 2982 |
| `falling_easing` | 10 | 75.5% | ±1.7pp | ±2.3pp | 46.7% | ±2.0pp | ±2.7pp | 2358 |
| `falling_easing` | 20 | 73.8% | ±2.0pp | ±2.7pp | 26.5% | ±2.0pp | ±2.7pp | 1794 |
| `falling_deepening` | 5 | 78.3% | ±1.6pp | ±2.1pp | 60.4% | ±1.9pp | ±2.5pp | 2594 |
| `falling_deepening` | 10 | 72.0% | ±1.9pp | ±2.6pp | 42.0% | ±2.1pp | ±2.8pp | 2123 |
| `falling_deepening` | 20 | 71.4% | ±2.2pp | ±2.9pp | 23.3% | ±2.1pp | ±2.8pp | 1632 |

## 2. The gap the decision rule asks about

`inside frame`, expanding branch minus contracting branch, within one side of
zero. The interval is on the DIFFERENCE of two independent proportions, computed
on the clustered counts.

| pairing | horizon | expanding | contracting | gap | 95% | Bonf. | >= 10pp |
| --- | --- | --- | --- | --- | --- | --- | --- |
| above zero  (rising side) | 5 | 60.5% | 66.3% | -5.8pp | ±2.7pp | ±3.6pp | no |
| above zero  (rising side) | 10 | 43.2% | 47.0% | -3.8pp | ±3.1pp | ±4.2pp | no |
| above zero  (rising side) | 20 | 25.3% | 27.7% | -2.4pp | ±3.1pp | ±4.2pp | no |
| below zero  (falling side) | 5 | 64.1% | 60.4% | +3.7pp | ±2.6pp | ±3.4pp | no |
| below zero  (falling side) | 10 | 46.7% | 42.0% | +4.8pp | ±2.9pp | ±3.9pp | no |
| below zero  (falling side) | 20 | 26.5% | 23.3% | +3.2pp | ±2.9pp | ±3.9pp | no |

## 3. Train and test, on the P4a boundary

Split by DATE at `2025-06-30` — the line P4a drew, read out of its manifest
rather than chosen here. The rule asks only whether the gap keeps its SIGN.

| pairing | horizon | train gap | clust (exp / con) | test gap | clust (exp / con) | same sign |
| --- | --- | --- | --- | --- | --- | --- |
| above zero  (rising side) | 5 | -7.6pp | 1439 / 1524 | -3.1pp | 964 / 1022 | yes |
| above zero  (rising side) | 10 | -4.3pp | 1125 / 1216 | -3.2pp | 784 / 833 | yes |
| above zero  (rising side) | 20 | -4.3pp | 887 / 913 | +0.4pp | 624 / 655 | **no** |
| below zero  (falling side) | 5 | +1.7pp | 1751 / 1524 | +6.5pp | 1231 / 1070 | yes |
| below zero  (falling side) | 10 | +4.4pp | 1384 / 1241 | +5.2pp | 980 / 883 | yes |
| below zero  (falling side) | 20 | +1.7pp | 1053 / 952 | +5.2pp | 751 / 684 | yes |

## VERDICT

The rule, as it was written before the run:

1. the `inside frame` gap between the expanding and the contracting branch of the
   SAME sign is >= 10pp at at least 2 of the 3 horizons; **and**
2. that gap keeps its sign across the train and the test half;
3. both -> GO. Either missing -> STOP.

- **above zero  (rising side)** — condition 1: 0/3 horizons at >= 10pp (needs 2) → NOT MET. condition 2: sign agreement yes / yes / no → NOT MET. **FAIL**
- **below zero  (falling side)** — condition 1: 0/3 horizons at >= 10pp (needs 2) → NOT MET. condition 2: sign agreement yes / yes / yes → MET. **FAIL**

## VERDICT: STOP


---

# Appendix — written after the run, changes nothing above

Everything in this section is a READING of the tables above. It derives no new
number, adds no bucket, and is not offered as a candidate. The VERDICT is STOP
and stays STOP.

## A. The four branches reconstruct §6.6 exactly — the population is right

Weighting each branch by its own `n` out of 10,525:

```
horizon | still sideways | inside frame | §6.6 says
      5 |         79.33% |       62.90% | 79.3% / 62.9%
     10 |         73.77% |       44.82% | 73.8% / 44.8%
     20 |         72.57% |       25.73% | 72.6% / 25.7%
```

The split is exhaustive (0 rows unplaceable) and recovers the headline it is
splitting to the last printed digit. That is the check that says the rows above
are measuring §6.6's population and not a neighbouring one.

## B. Why the two pairings came out with opposite signs

They are not in conflict. Order the four `inside frame` rates at each horizon:

```
                       @5      @10     @20
rising_fading        66.3%   47.0%   27.7%   <- bar got SHORTER
falling_easing       64.1%   46.7%   26.5%   <- bar got SHORTER
rising_extending     60.5%   43.2%   25.3%   <- bar got LONGER
falling_deepening    60.4%   42.0%   23.3%   <- bar got LONGER
```

The two "bar got shorter" branches are the top two at all three horizons and the
two "bar got longer" branches are the bottom two at all three horizons, without
an exception. The ordering is by the bar's LENGTH, which is not what
`histogramExpanding` encodes — the flag is signed, so on the rising side longer
is `expanding` and on the falling side longer is `contracting`. That is exactly
why pairing 1 reads negative and pairing 2 positive, and it is also why reading
the flag on its own — pooling across the sign — would have cancelled most of the
separation against itself.

**This does not rescue anything, and here is the arithmetic that closes it off.**
The four rates span 5.9pp end to end at 5 bars, 5.0pp at 10 and 4.4pp at 20. Any
partition of four groups has a gap bounded by the spread of the four rates, so
no grouping of these branches — the one above, the flag alone, or any other —
can reach the 10pp the rule asks for. The field does not separate this
population; it is not that the buckets were drawn wrong.

## C. The label's persistence is not a momentum story at all

`still sideways` at 20 bars, across all four branches: 71.4% / 71.9% / 73.0% /
73.8%. A 2.4pp spread around a 72.6% headline, with intervals of ±2.2pp on each.
Whatever keeps a SIDEWAYS label alive for 20 bars, the MACD histogram's direction
knows nothing about it. The half of the §6.6 gap that is about the LABEL is
untouched by this field, and only the half about PRICE moved at all.

## D. One train/test flip, and it is the shape of noise

The rising side at 20 bars reads train −4.3pp vs test +0.4pp. Both sit inside
their own intervals and the test half is a rounding away from zero, so this is
not a regime finding — it is a gap of about 2pp being measured twice. Recorded
because condition 2 failed on it, not because it means something.

## E. `histogramExpanding` is never null in practice

0 of 10,525 sideways rows landed outside the four branches. On a 600-bar left
window there is always a previous histogram bar, and an exact tie or an exact
zero did not occur once. The three-state field behaves as two states on this
corpus — worth knowing before anyone designs around the null.
