# Market Signal calibration — 20260818T113633Z

P4a. Nothing here is fitted and nothing here feeds the engine.

```
corpus             108 instruments — pinned to the list run 20260818T092020Z measured
observations       14154   (stride 5 bars, left window 600 bars)
period             2023-04-09 .. 2026-07-27   (403 distinct as-of dates)
time split         train < 2025-06-30 <= test   (8326 / 5828)
directional        3629   (25.6% — the rest are sideways)
both barriers      2562   (18.1% of all observations)
window self-check  36 comparisons, 0 mismatches
bucket guard       n < 30 reports insufficient; buckets are NEVER merged to reach it
```

**Known limits.** Survivorship: all 108 instruments still trade and the corpus
has no delisted names, so every figure is conditioned on survival and optimistic
by an unknown amount. No fees, spread or slippage — these are price moves, not
returns. The train/test split is **not** an overfit control: nothing is fitted at
this stage, so there is no fit for it to protect. It exists so P4b inherits a
held-out period that was defined before any number moved.

`n` is raw observations; `clust` is the largest non-overlapping subset of them,
which is the honest count of independent facts at that horizon.

## 1. Does the signal beat doing nothing?

Criterion B, all directional signals, against the unconditional rate over the
same instrument-days weighted to the same long/short mix.

```
horizon |  signal      n   clust |    base      n |     edge
--------|------------------------|----------------|---------
      5 |   51.4%   3626    3626 |   51.3%  14143 |   +0.0pp
     10 |   51.4%   3626    2510 |   51.6%  14146 |   -0.2pp
     20 |   51.5%   3628    1853 |   51.9%  14148 |   -0.4pp
```

### The same, by market regime

Split so a rising tape cannot make every long signal look predictive.

```
regime | horizon |  signal      n   clust |    base      n |     edge
-------|---------|------------------------|----------------|---------
up     |       5 |   51.4%   3338    3338 |   51.4%  12657 |   +0.0pp
up     |      10 |   52.1%   3338    2320 |   51.6%  12659 |   +0.5pp
up     |      20 |   51.5%   3341    1724 |   52.2%  12662 |   -0.6pp
down   |       5 |   51.6%    225     225 |   46.5%   1183 |   +5.1pp
down   |      10 |   41.3%    225     186 |   46.2%   1184 |   -4.9pp
down   |      20 |   50.9%    224     171 |   46.8%   1183 |   +4.1pp
```

### The same, by time split

```
split | horizon |  signal      n   clust |    base      n |     edge
------|---------|------------------------|----------------|---------
train |       5 |   50.8%   2085    2085 |   51.6%   8315 |   -0.8pp
train |      10 |   50.1%   2085    1447 |   51.8%   8322 |   -1.7pp
train |      20 |   49.7%   2088    1088 |   52.0%   8321 |   -2.3pp
test  |       5 |   52.0%   1541    1541 |   50.8%   5828 |   +1.2pp
test  |      10 |   53.0%   1541    1068 |   51.1%   5824 |   +1.9pp
test  |      20 |   54.0%   1540     781 |   51.8%   5827 |   +2.2pp
```

## 2. Criterion A — target before invalidation

The claim the card literally makes. Control is the same instrument and the same
barrier distances placed on other dates, so only the timing is removed.
`unres.` is observations where neither barrier was reached inside the horizon;
`amb.` is bars that reached both, which resolve as losses.

At the short horizons most observations reach neither barrier, so `signal` is a
rate over the RESOLVED ones only. `target/all` is the share of every observation
that reached its target, which is the number a reader waiting for one would feel.

```
horizon |  signal      n   clust | control      n |     edge | unres. amb. | target/all
--------|------------------------|----------------|----------|-------------|-----------
      5 |   37.7%   1384    1384 |   37.7%   4214 |   +0.1pp |   1178   11 |      20.4%
     10 |   39.2%   1842    1502 |   39.1%   6432 |   +0.1pp |    720   11 |      28.2%
     20 |   40.5%   2227    1408 |   39.4%   8595 |   +1.2pp |    335   11 |      35.2%
```

## 3. The dimensions P4a has to cut by

Marginals first. The full cross of zone x proximity x conflict x confidence is
180 cells and almost all of them are under the guard, so it is printed last with
`insufficient` wherever it belongs rather than merged into something readable.

### By zone

```
bucket           | horizon |  signal      n   clust |    base |     edge
-----------------|---------|------------------------|---------|---------
uptrend          |       5 |   55.0%   2358    2358 |   54.4% |   +0.7pp
uptrend          |      10 |   57.1%   2359    1597 |   55.2% |   +1.9pp
uptrend          |      20 |   57.6%   2361    1211 |   56.4% |   +1.1pp
downtrend        |       5 |   44.5%   1268    1268 |   45.6% |   -1.2pp
downtrend        |      10 |   40.6%   1267     948 |   44.8% |   -4.2pp
downtrend        |      20 |   40.3%   1267     796 |   43.6% |   -3.3pp
```

### By proximity — the P2.6 assumption, tested

P2.6 asserted that `near_trigger` marks a FRAGILE label. It never said fragile
means wrong, and nothing has checked either reading. Both are below: this table
is whether the direction is less often right, and the one after it is whether the
label itself is less likely to survive.

```
bucket           | horizon |  signal      n   clust |    base |     edge
-----------------|---------|------------------------|---------|---------
near_trigger     |       5 |   52.7%    651     651 |   50.9% |   +1.8pp
near_trigger     |      10 |   50.9%    650     615 |   51.1% |   -0.2pp
near_trigger     |      20 |   50.2%    651     554 |   51.4% |   -1.1pp
mid_range        |       5 |   51.5%   2355    2355 |   51.1% |   +0.4pp
mid_range        |      10 |   50.9%   2356    1834 |   51.3% |   -0.4pp
mid_range        |      20 |   51.3%   2356    1461 |   51.6% |   -0.4pp
deep_range       |       5 |   49.2%    620     620 |   52.5% |   -3.3pp
deep_range       |      10 |   53.5%    620     484 |   53.0% |   +0.6pp
deep_range       |      20 |   53.8%    621     438 |   53.7% |   +0.1pp
```

#### Does `near_trigger` actually mark a fragile label?

The claim P2.6 made, measured directly: how often the zone is something else
`horizon` bars later. Read from the sampled grid, which is why the stride divides
every horizon.

```
proximity    | horizon | zone changed |      n | changed to sideways
-------------|---------|--------------|--------|--------------------
near_trigger |       5 |        64.8% |    648 |               60.3%
near_trigger |      10 |        78.9% |    644 |               71.1%
near_trigger |      20 |        83.0% |    630 |               71.6%
mid_range    |       5 |        60.4% |   2348 |               58.8%
mid_range    |      10 |        78.2% |   2327 |               72.5%
mid_range    |      20 |        84.1% |   2289 |               72.9%
deep_range   |       5 |        51.4% |    621 |               50.7%
deep_range   |      10 |        74.4% |    616 |               72.7%
deep_range   |      20 |        81.5% |    606 |               75.7%
```

### By conflict — is the P1 gate earning its confidence penalty?

If a conflicted signal is no worse than an unconflicted one, then `SIGNAL_GATE`
is damping confidence for a reason that does not exist, and that is a thing to
know before P4b calibrates on top of it.

```
bucket           | horizon |  signal      n   clust |    base |     edge
-----------------|---------|------------------------|---------|---------
conflict         |       5 |   49.0%    469     469 |   48.8% |   +0.3pp
conflict         |      10 |   48.5%    468     411 |   48.6% |   -0.0pp
conflict         |      20 |   44.7%    468     390 |   48.2% |   -3.5pp
no conflict      |       5 |   51.7%   3157    3157 |   51.7% |   +0.0pp
no conflict      |      10 |   51.8%   3158    2217 |   52.0% |   -0.2pp
no conflict      |      20 |   52.5%   3160    1694 |   52.5% |   +0.0pp
```

### By risk leg — the P3.5 outlier question

R:R runs away when the close sits almost on its own invalidation, which is exactly
when a zone is freshest. This is whether those signals are actually better.

```
bucket           | horizon |  signal      n   clust |    base |     edge
-----------------|---------|------------------------|---------|---------
< 0.5 ATR        |       5 |   51.2%    334     334 |   50.7% |   +0.5pp
< 0.5 ATR        |      10 |   51.4%    333     322 |   50.9% |   +0.5pp
< 0.5 ATR        |      20 |   50.3%    334     308 |   51.1% |   -0.8pp
0.5-1.5 ATR      |       5 |   55.5%    978     978 |   51.1% |   +4.4pp
0.5-1.5 ATR      |      10 |   53.1%    978     885 |   51.3% |   +1.8pp
0.5-1.5 ATR      |      20 |   51.7%    978     779 |   51.6% |   +0.1pp
1.5-3 ATR        |       5 |   50.0%   1097    1097 |   51.0% |   -1.1pp
1.5-3 ATR        |      10 |   48.9%   1098     973 |   51.3% |   -2.3pp
1.5-3 ATR        |      20 |   50.2%   1098     877 |   51.5% |   -1.4pp
>= 3 ATR         |       5 |   49.4%    722     722 |   52.6% |   -3.1pp
>= 3 ATR         |      10 |   53.6%    722     563 |   53.1% |   +0.5pp
>= 3 ATR         |      20 |   54.9%    723     504 |   53.8% |   +1.1pp
```

### Reliability — reported confidence against measured hit rate

A confidence number is a promise. This is whether it is kept. `uncalibrated` is
what the UI says today, and these rows are why it has to keep saying it until P4b.

```
confidence | horizon | reported |     hit |      n   clust |     gap
-----------|---------|----------|---------|----------------|--------
     10-19 |       5 |   15.6% | insuff. |      7       7 |        —
     10-19 |      10 |   15.6% | insuff. |      7       7 |        —
     10-19 |      20 |   15.6% | insuff. |      7       7 |        —
     20-29 |       5 |   25.2% |   53.0% |    115     115 |  +27.8pp
     20-29 |      10 |   25.2% |   53.0% |    115     110 |  +27.8pp
     20-29 |      20 |   25.2% |   44.3% |    115     110 |  +19.1pp
     30-39 |       5 |   34.5% |   47.3% |    169     169 |  +12.8pp
     30-39 |      10 |   34.5% |   43.5% |    168     158 |   +8.9pp
     30-39 |      20 |   34.5% |   44.4% |    169     157 |   +9.9pp
     40-49 |       5 |   44.6% |   53.4% |    208     208 |   +8.8pp
     40-49 |      10 |   44.6% |   46.6% |    208     197 |   +2.1pp
     40-49 |      20 |   44.6% |   46.6% |    208     192 |   +2.1pp
     50-59 |       5 |   54.5% |   53.1% |    311     311 |   -1.4pp
     50-59 |      10 |   54.5% |   52.7% |    311     300 |   -1.7pp
     50-59 |      20 |   54.5% |   48.7% |    310     293 |   -5.7pp
     60-69 |       5 |   64.8% |   45.8% |    382     382 |  -19.0pp
     60-69 |      10 |   64.8% |   46.2% |    383     362 |  -18.6pp
     60-69 |      20 |   64.8% |   46.2% |    383     339 |  -18.6pp
     70-79 |       5 |   75.6% |   53.8% |    669     669 |  -21.7pp
     70-79 |      10 |   75.6% |   52.7% |    670     604 |  -22.9pp
     70-79 |      20 |   75.6% |   53.3% |    670     560 |  -22.3pp
     80-89 |       5 |   84.6% |   49.9% |    968     968 |  -34.7pp
     80-89 |      10 |   84.6% |   51.6% |    967     840 |  -33.0pp
     80-89 |      20 |   84.6% |   53.7% |    969     760 |  -30.9pp
     90-99 |       5 |   93.5% |   53.3% |    797     797 |  -40.2pp
     90-99 |      10 |   93.5% |   54.6% |    797     627 |  -38.9pp
     90-99 |      20 |   93.5% |   55.0% |    797     532 |  -38.5pp
```

## 4. The claims that are not directional

### Sideways

Excluded from every hit rate above: no direction was claimed, so there is nothing
to be right about. It does make a claim, though — that price stays in the frame
and the label holds — and that is checkable.

```
horizon | still sideways | stayed inside frame |      n
--------|----------------|---------------------|-------
      5 |          79.3% |               62.9% |  10525
     10 |          73.8% |               44.8% |  10525
     20 |          72.6% |               25.7% |  10525
```

### `pending_breakout` — how many are confirmed

A close is already past the trigger and the confirmation rule has not accepted it
yet. The card tells a reader that. This is what happens next.

```
flag              | horizon | confirmed | reverted to sideways |      n
------------------|---------|-----------|----------------------|-------
pending_breakout  |       5 |     53.2% |                45.0% |    220
pending_breakout  |      10 |     27.6% |                64.5% |    217
pending_breakout  |      20 |     21.2% |                70.8% |    212
pending_breakdown |       5 |     42.5% |                55.0% |    120
pending_breakdown |      10 |     19.7% |                70.1% |    117
pending_breakdown |      20 |     17.9% |                63.2% |    117
```

## 5. The full cross

zone x proximity x conflict x confidence bucket, at the 10-bar horizon. Printed
whole, with `insufficient` wherever the guard bites, because merging cells to
reach 30 would change the question being answered without anybody noticing.

```
zone      proximity     conflict  conf   |     hit      n   clust |    base |     edge
----------------------------------------|------------------------|---------|---------
uptrend   near_trigger  no        20s    | insuff.      1       1 |   55.2% |        —
uptrend   near_trigger  no        30s    | insuff.      5       5 |   55.2% |        —
uptrend   near_trigger  no        40s    | insuff.     19      19 |   55.2% |        —
uptrend   near_trigger  no        50s    | insuff.     27      26 |   55.2% |        —
uptrend   near_trigger  no        60s    |   56.8%     44      44 |   55.2% |   +1.6pp
uptrend   near_trigger  no        70s    |   54.0%     63      62 |   55.2% |   -1.2pp
uptrend   near_trigger  no        80s    |   53.8%    117     115 |   55.2% |   -1.3pp
uptrend   near_trigger  no        90s    |   61.4%     57      55 |   55.2% |   +6.2pp
uptrend   near_trigger  yes       20s    | insuff.     15      15 |   55.2% |        —
uptrend   near_trigger  yes       30s    | insuff.     14      14 |   55.2% |        —
uptrend   near_trigger  yes       40s    | insuff.     16      16 |   55.2% |        —
uptrend   near_trigger  yes       50s    | insuff.     13      13 |   55.2% |        —
uptrend   near_trigger  yes       60s    | insuff.      1       1 |   55.2% |        —
uptrend   near_trigger  yes       70s    | insuff.      1       1 |   55.2% |        —
uptrend   mid_range     no        30s    | insuff.     10      10 |   55.2% |        —
uptrend   mid_range     no        40s    | insuff.     29      28 |   55.2% |        —
uptrend   mid_range     no        50s    |   59.5%     74      74 |   55.2% |   +4.3pp
uptrend   mid_range     no        60s    |   45.0%    131     125 |   55.2% |  -10.2pp
uptrend   mid_range     no        70s    |   61.4%    295     274 |   55.2% |   +6.2pp
uptrend   mid_range     no        80s    |   58.0%    464     421 |   55.2% |   +2.8pp
uptrend   mid_range     no        90s    |   55.6%    376     326 |   55.2% |   +0.4pp
uptrend   mid_range     yes       10s    | insuff.      3       3 |   55.2% |        —
uptrend   mid_range     yes       20s    | insuff.     15      14 |   55.2% |        —
uptrend   mid_range     yes       30s    | insuff.     21      21 |   55.2% |        —
uptrend   mid_range     yes       40s    | insuff.     25      25 |   55.2% |        —
uptrend   mid_range     yes       50s    | insuff.     23      22 |   55.2% |        —
uptrend   mid_range     yes       60s    | insuff.     10      10 |   55.2% |        —
uptrend   mid_range     yes       70s    | insuff.      1       1 |   55.2% |        —
uptrend   deep_range    no        40s    | insuff.      2       2 |   55.2% |        —
uptrend   deep_range    no        50s    | insuff.      8       8 |   55.2% |        —
uptrend   deep_range    no        60s    |   66.7%     30      29 |   55.2% |  +11.5pp
uptrend   deep_range    no        70s    |   53.5%    114     104 |   55.2% |   -1.7pp
uptrend   deep_range    no        80s    |   58.0%    119     108 |   55.2% |   +2.8pp
uptrend   deep_range    no        90s    |   61.7%    206     167 |   55.2% |   +6.5pp
uptrend   deep_range    yes       40s    | insuff.      2       2 |   55.2% |        —
uptrend   deep_range    yes       50s    | insuff.      4       4 |   55.2% |        —
uptrend   deep_range    yes       60s    | insuff.      4       3 |   55.2% |        —
downtrend near_trigger  no        20s    | insuff.      1       1 |   44.8% |        —
downtrend near_trigger  no        30s    | insuff.      8       8 |   44.8% |        —
downtrend near_trigger  no        40s    | insuff.     11      11 |   44.8% |        —
downtrend near_trigger  no        50s    | insuff.     28      28 |   44.8% |        —
downtrend near_trigger  no        60s    | insuff.     27      27 |   44.8% |        —
downtrend near_trigger  no        70s    | insuff.     22      22 |   44.8% |        —
downtrend near_trigger  no        80s    |   32.6%     46      46 |   44.8% |  -12.2pp
downtrend near_trigger  no        90s    | insuff.     14      14 |   44.8% |        —
downtrend near_trigger  yes       10s    | insuff.      1       1 |   44.8% |        —
downtrend near_trigger  yes       20s    |   54.8%     31      31 |   44.8% |  +10.0pp
downtrend near_trigger  yes       30s    | insuff.     29      29 |   44.8% |        —
downtrend near_trigger  yes       40s    | insuff.     22      22 |   44.8% |        —
downtrend near_trigger  yes       50s    | insuff.     15      15 |   44.8% |        —
downtrend near_trigger  yes       60s    | insuff.      2       2 |   44.8% |        —
downtrend mid_range     no        20s    | insuff.      7       7 |   44.8% |        —
downtrend mid_range     no        30s    | insuff.     11      11 |   44.8% |        —
downtrend mid_range     no        40s    |   47.5%     40      40 |   44.8% |   +2.7pp
downtrend mid_range     no        50s    |   40.3%     72      71 |   44.8% |   -4.5pp
downtrend mid_range     no        60s    |   37.9%    103      98 |   44.8% |   -6.9pp
downtrend mid_range     no        70s    |   40.8%    147     143 |   44.8% |   -4.0pp
downtrend mid_range     no        80s    |   37.7%    199     186 |   44.8% |   -7.1pp
downtrend mid_range     no        90s    |   41.1%    107      95 |   44.8% |   -3.7pp
downtrend mid_range     yes       10s    | insuff.      3       3 |   44.8% |        —
downtrend mid_range     yes       20s    |   44.4%     45      44 |   44.8% |   -0.4pp
downtrend mid_range     yes       30s    |   40.6%     69      63 |   44.8% |   -4.2pp
downtrend mid_range     yes       40s    |   55.9%     34      33 |   44.8% |  +11.1pp
downtrend mid_range     yes       50s    |   36.8%     38      37 |   44.8% |   -8.0pp
downtrend mid_range     yes       60s    | insuff.      4       4 |   44.8% |        —
downtrend deep_range    no        30s    | insuff.      1       1 |   44.8% |        —
downtrend deep_range    no        40s    | insuff.      5       5 |   44.8% |        —
downtrend deep_range    no        50s    | insuff.      6       6 |   44.8% |        —
downtrend deep_range    no        60s    | insuff.     26      24 |   44.8% |        —
downtrend deep_range    no        70s    | insuff.     27      27 |   44.8% |        —
downtrend deep_range    no        80s    | insuff.     22      19 |   44.8% |        —
downtrend deep_range    no        90s    |   43.2%     37      32 |   44.8% |   -1.6pp
downtrend deep_range    yes       40s    | insuff.      3       3 |   44.8% |        —
downtrend deep_range    yes       50s    | insuff.      3       3 |   44.8% |        —
downtrend deep_range    yes       60s    | insuff.      1       1 |   44.8% |        —
```

Cells with a number: 26. Cells suppressed by the n < 30 guard: 49.

