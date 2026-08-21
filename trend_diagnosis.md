# Which rule produced the disagreement?

`trend_agreement.md` measured that engine OFF over-speaks (UP 98.9 / DOWN 93.8 /
SIDEWAYS 17.3), engine ON under-speaks (UP 46.2 / DOWN 39.2 / SIDEWAYS 84.1) and the
OFF flip ratio is above 1.0 at all 27 grid points. This file asks WHY, over the same
pinned corpus, the same frozen bars and the same ground truth. It changes no engine
file, no config value, no label, no threshold and no line of copy.

```
corpus            108 instruments — pinned to 20260818T113633Z via its manifest
period            2023-04-09 .. 2026-07-27
bars              72805   (stride 1, left window 600, engine GATE+ZONES ON)
calculatedAt      2026-01-01T00:00:00.000Z   (pinned — no clock, no network)
ground truth      N 20, displacement 1.5 ATR, efficiency 0.3 — unchanged from
                  `trend_agreement.md`, and still a design choice rather than the truth
join check        72805 bars shared with the agreement probe's shards, 0 ON-state
                  mismatches. Must be 0: the OFF column below is joined from that run and
                  would otherwise be describing a different calculation.
config overrides  Part C only, in memory, one process, declared per shard. `src/` untouched.
```

## A. The ten worst conflicts — who is wrong

The ten rows of `trend_agreement.md` §5, in its order and with its ranking. For each:
the 20 bars the ground truth measured over, the engine replayed at every one of them,
the indicators and zone frame at the last bar, and every reason id the engine raised.

**The adjudication rule was fixed before the run** and uses price at two OTHER scales,
nothing else — no EMA, no ADX, no score, no zone, because those belong to one of the
two parties:

```
d5 / d20 / d60    (close_t - close_t-N) / ATR14_t   for N = 5, 20, 60
side(d)           +1 if d >= +0.5 ATR, -1 if d <= -0.5 ATR, 0 otherwise

engine wrong        side(d5) == side(d20) == side(d60)
                    the move reads the same at every scale, so no window makes the
                    engine's word a defensible reading of the chart
ground truth wrong  side(d5) != side(d20) and side(d60) != side(d20), neither flat
                    the 20-bar window is the odd one out
borderline          everything else, including any case where a scale is flat
```

| # | symbol | date | truth | OFF | ON | d5 | d20 | d60 | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | SHOP | 2024-06-05 | DOWN | BEARISH | BULLISH | 1.36 | -7.46 | -6.48 | **borderline** |
| 2 | NFLX | 2026-03-23 | UP | BEARISH | SIDEWAYS | -0.67 | 6.42 | -0.04 | **borderline** |
| 3 | UPS | 2025-02-27 | DOWN | BULLISH | SIDEWAYS | 0.44 | -6.05 | -6.84 | **borderline** |
| 4 | AVGO | 2024-01-05 | UP | BEARISH | SIDEWAYS | -2.84 | 5.82 | 7.58 | **borderline** |
| 5 | SBUX | 2024-05-29 | DOWN | BULLISH | SIDEWAYS | -0.43 | -5.66 | -7.70 | **borderline** |
| 6 | MRK | 2024-08-26 | DOWN | BULLISH | SIDEWAYS | 0.82 | -5.11 | -3.34 | **borderline** |
| 7 | ACN | 2026-07-08 | DOWN | BULLISH | SIDEWAYS | 1.74 | -5.07 | -5.77 | **borderline** |
| 8 | XRP-USD | 2024-10-19 | DOWN | BULLISH | SIDEWAYS | -0.19 | -5.02 | -2.58 | **borderline** |
| 9 | TXN | 2025-12-19 | UP | BEARISH | SIDEWAYS | -0.68 | 5.01 | -0.90 | **ground truth wrong** |
| 10 | IBM | 2026-08-07 | DOWN | BULLISH | SIDEWAYS | 1.33 | -4.90 | 1.76 | **ground truth wrong** |

Tally over the 10 cases that resolved: engine wrong 0 · ground truth wrong 2 · borderline 8.

**Neither side reaches 7 of 10 (engine 0, ground truth 2), so no pooled
statement is made about which side is wrong.** That was the pre-registered bar and it
was not cleared: 8 of the ten are `borderline`, which is the adjudicator declining
to name a side rather than naming one. The per-case rows above stand on their own and
the ten charts still have to be read one at a time.

What the ten DO have in common is not a verdict and is counted rather than eyeballed:

- the fast scale contradicts the 20-bar window on **10 of 10** cases
  (3 of those are flat rather than opposed)
- the slow scale agrees with the 20-bar window on **7 of 10**
- engine ON answers SIDEWAYS on 9 of 10, and its zone is `sideways` on 9
- engine OFF's score is inside the gate's neutral band (|score| < 15) on 7 of 10,
  while it published a direction on every one of them

So these are not backwards descriptions of a steady move. They are bars where the
last week of price went one way and the last month went the other, and the two sources
resolved that split differently — which is a horizon disagreement, and the reason so
many land on `borderline` under a rule that requires all three scales to line up.

### A1. SHOP 2024-06-05 — truth DOWN, OFF BEARISH, ON BULLISH

```
ground truth   displacement -7.46 ATR · efficiency 0.50 · ATR14 2.1184
adjudicator    d5 1.36  d20 -7.46  d60 -6.48  ->  borderline
score          OFF -24.0 · ON -29.0 · band weak · conflicts 2
slopes         ema20 -1.077%  ema50 -4.875%  ema200 -2.734%
strength       ADX 29.2 · +DI 23.1 · -DI 29.4 · RSI 46.5
regime         squeeze false · overextended false · sideways false · nonTrendingFallback false
zone (ON)      uptrend · mode structural · pos 130% · nearest trigger -0.29 ATR · zoneAge 0 · frameAge 0 · S 56.31 / R 60.11 · trig 55.7804 / 60.6396 · lastTested 0b · crossings 34
```

| date | open | high | low | close | EMA20 | EMA50 | EMA200 | OFF | ON |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2024-05-07 | 76.53 | 77.82 | 75.29 | 77.05 | 73.18 | 74.33 | 69.64 | BULLISH | SIDEWAYS |
| 2024-05-08 | 63.67 | 64.20 | 60.64 | 62.73 | 72.18 | 73.87 | 69.57 | BEARISH | BEARISH |
| 2024-05-09 | 63.57 | 63.80 | 61.61 | 62.45 | 71.26 | 73.43 | 69.50 | BEARISH | BEARISH |
| 2024-05-10 | 62.72 | 62.74 | 58.65 | 58.94 | 70.08 | 72.86 | 69.39 | OVEREXTENDED | OVEREXTENDED |
| 2024-05-13 | 59.07 | 59.48 | 58.26 | 58.78 | 69.01 | 72.31 | 69.28 | BEARISH | BEARISH |
| 2024-05-14 | 58.66 | 58.77 | 56.92 | 58.03 | 67.96 | 71.75 | 69.16 | BEARISH | BEARISH |
| 2024-05-15 | 59.17 | 59.67 | 58.35 | 58.77 | 67.09 | 71.24 | 69.05 | BEARISH | BEARISH |
| 2024-05-16 | 58.65 | 58.99 | 57.78 | 57.81 | 66.20 | 70.71 | 68.93 | BEARISH | BEARISH |
| 2024-05-17 | 57.95 | 58.59 | 57.04 | 58.53 | 65.47 | 70.23 | 68.82 | BEARISH | BEARISH |
| 2024-05-20 | 58.87 | 59.21 | 58.30 | 58.91 | 64.85 | 69.79 | 68.72 | BEARISH | SIDEWAYS |
| 2024-05-21 | 58.50 | 58.62 | 57.01 | 57.02 | 64.10 | 69.29 | 68.60 | BEARISH | SIDEWAYS |
| 2024-05-22 | 58.88 | 60.11 | 58.21 | 58.70 | 63.59 | 68.87 | 68.49 | BEARISH | SIDEWAYS |
| 2024-05-23 | 58.61 | 59.08 | 57.48 | 57.64 | 63.02 | 68.43 | 68.38 | BEARISH | SIDEWAYS |
| 2024-05-24 | 57.11 | 58.06 | 56.91 | 56.97 | 62.44 | 67.98 | 68.26 | BEARISH | SIDEWAYS |
| 2024-05-28 | 57.01 | 58.22 | 56.31 | 58.19 | 62.04 | 67.60 | 68.16 | BEARISH | SIDEWAYS |
| 2024-05-29 | 57.55 | 58.57 | 57.26 | 58.37 | 61.69 | 67.24 | 68.06 | BEARISH | SIDEWAYS |
| 2024-05-30 | 58.41 | 58.78 | 57.91 | 58.54 | 61.39 | 66.90 | 67.96 | BEARISH | SIDEWAYS |
| 2024-05-31 | 58.80 | 59.23 | 57.75 | 59.15 | 61.18 | 66.59 | 67.86 | BEARISH | SIDEWAYS |
| 2024-06-03 | 59.41 | 59.94 | 58.38 | 59.70 | 61.04 | 66.32 | 67.78 | BEARISH | SIDEWAYS |
| 2024-06-04 | 59.46 | 60.69 | 59.21 | 60.68 | 61.00 | 66.10 | 67.70 | BEARISH | SIDEWAYS |
| 2024-06-05 | 61.18 | 61.70 | 60.28 | 61.25 | 61.03 | 65.91 | 67.63 | BEARISH | BULLISH |

reason ids · OFF: swing-structure(n,15), macd-histogram(p,8.33), macd-signal(p,8.33), ema20-slope(n,7.5), ema200-slope(n,7.5), ema50-slope(n,7.5), obv-trend(p,7.5), adx-dmi(n,6.88), bullish-divergence(c,4), ema-structure(n,2.5), rsi14(n,1.18)

reason ids · ON: swing-structure(n,15), macd-histogram(p,8.33), macd-signal(p,8.33), ema20-slope(n,7.5), ema200-slope(n,7.5), ema50-slope(n,7.5), obv-trend(p,7.5), component-conflict(c,7), adx-dmi(n,6.88), ema-structure(n,2.5), bullish-divergence(c,1.25), rsi14(n,1.18)

flags · OFF: bullish_divergence, weak_confirmation · ON: weak_confirmation, conflicting_evidence, low_volume_confirmation

**A1: borderline.**

### A2. NFLX 2026-03-23 — truth UP, OFF BEARISH, ON SIDEWAYS

```
ground truth   displacement 6.42 ATR · efficiency 0.50 · ATR14 2.7055
adjudicator    d5 -0.67  d20 6.42  d60 -0.04  ->  borderline
score          OFF -10.0 · ON -10.0 · band neutral · conflicts 1
slopes         ema20 0.542%  ema50 1.697%  ema200 -1.216%
strength       ADX 27.9 · +DI 27.8 · -DI 20.6 · RSI 55.4
regime         squeeze false · overextended false · sideways false · nonTrendingFallback false
zone (ON)      sideways · mode structural · pos 73% · nearest trigger 2.77 ATR · zoneAge 8 · frameAge 9 · S 75.01 / R 100.19 · trig 74.3336 / 100.8664 · lastTested 11b · crossings 51
```

| date | open | high | low | close | EMA20 | EMA50 | EMA200 | OFF | ON |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-02-23 | 77.79 | 77.83 | 75.01 | 76.02 | 80.55 | 87.37 | 100.53 | BEARISH | SIDEWAYS |
| 2026-02-24 | 75.73 | 78.12 | 75.21 | 78.04 | 80.31 | 87.01 | 100.31 | BEARISH | SIDEWAYS |
| 2026-02-25 | 79.43 | 83.12 | 79.25 | 82.70 | 80.54 | 86.84 | 100.13 | BEARISH | SIDEWAYS |
| 2026-02-26 | 83.20 | 86.50 | 82.80 | 84.59 | 80.93 | 86.75 | 99.98 | BULLISH | SIDEWAYS |
| 2026-02-27 | 94.30 | 96.75 | 90.58 | 96.24 | 82.38 | 87.12 | 99.94 | OVEREXTENDED | OVEREXTENDED |
| 2026-03-02 | 95.26 | 98.07 | 95.20 | 97.09 | 83.78 | 87.51 | 99.91 | OVEREXTENDED | OVEREXTENDED |
| 2026-03-03 | 96.01 | 98.46 | 95.33 | 97.70 | 85.11 | 87.91 | 99.89 | OVEREXTENDED | OVEREXTENDED |
| 2026-03-04 | 97.11 | 99.75 | 96.99 | 98.66 | 86.40 | 88.33 | 99.88 | OVEREXTENDED | OVEREXTENDED |
| 2026-03-05 | 98.50 | 100.19 | 98.10 | 99.17 | 87.62 | 88.76 | 99.88 | OVEREXTENDED | OVEREXTENDED |
| 2026-03-06 | 99.33 | 99.88 | 97.40 | 99.02 | 88.70 | 89.16 | 99.87 | OVEREXTENDED | OVEREXTENDED |
| 2026-03-09 | 97.70 | 98.94 | 96.58 | 98.32 | 89.62 | 89.52 | 99.85 | BULLISH | BULLISH |
| 2026-03-10 | 97.81 | 98.49 | 96.29 | 96.94 | 90.32 | 89.81 | 99.83 | BULLISH | BULLISH |
| 2026-03-11 | 97.41 | 98.00 | 94.69 | 94.89 | 90.75 | 90.01 | 99.78 | BULLISH | SIDEWAYS |
| 2026-03-12 | 94.86 | 95.40 | 93.87 | 94.31 | 91.09 | 90.18 | 99.73 | BULLISH | SIDEWAYS |
| 2026-03-13 | 94.64 | 95.68 | 94.24 | 95.31 | 91.49 | 90.38 | 99.68 | BULLISH | SIDEWAYS |
| 2026-03-16 | 95.58 | 96.10 | 94.36 | 95.20 | 91.85 | 90.57 | 99.64 | BULLISH | SIDEWAYS |
| 2026-03-17 | 95.30 | 96.34 | 94.01 | 94.36 | 92.08 | 90.72 | 99.59 | BULLISH | SIDEWAYS |
| 2026-03-18 | 94.45 | 95.34 | 93.61 | 94.70 | 92.33 | 90.87 | 99.54 | BULLISH | SIDEWAYS |
| 2026-03-19 | 94.31 | 95.75 | 90.78 | 91.74 | 92.28 | 90.91 | 99.46 | BEARISH | SIDEWAYS |
| 2026-03-20 | 91.31 | 91.88 | 90.69 | 91.82 | 92.23 | 90.94 | 99.39 | BEARISH | SIDEWAYS |
| 2026-03-23 | 92.04 | 93.98 | 91.86 | 93.38 | 92.34 | 91.04 | 99.33 | BEARISH | SIDEWAYS |

reason ids · OFF: macd-histogram(n,8.33), macd-signal(n,8.33), ema200-slope(n,7.5), ema50-slope(p,7.5), obv-trend(n,7.5), adx-dmi(p,5.9), ema20-slope(p,4.06), bullish-divergence(c,4), ema-structure(p,2.5), rsi14(p,1.79)

reason ids · ON: macd-histogram(n,8.33), macd-signal(n,8.33), ema200-slope(n,7.5), ema50-slope(p,7.5), obv-trend(n,7.5), component-conflict(c,7), adx-dmi(p,5.9), ema20-slope(p,4.06), ema-structure(p,2.5), rsi14(p,1.79), bullish-divergence(c,0.8)

flags · OFF: bullish_divergence · ON: conflicting_evidence

**A2: borderline.**

### A3. UPS 2025-02-27 — truth DOWN, OFF BULLISH, ON SIDEWAYS

```
ground truth   displacement -6.05 ATR · efficiency 0.40 · ATR14 2.1715
adjudicator    d5 0.44  d20 -6.05  d60 -6.84  ->  borderline
score          OFF 3.0 · ON -2.0 · band neutral · conflicts 1
slopes         ema20 0.054%  ema50 -1.690%  ema200 -2.373%
strength       ADX 25.9 · +DI 22.1 · -DI 25.1 · RSI 49.3
regime         squeeze false · overextended false · sideways false · nonTrendingFallback false
zone (ON)      sideways · mode structural · pos 35.9% · nearest trigger 4.39 ATR · zoneAge 13 · frameAge 14 · S 99.2827 / R 124.3212 · trig 98.7398 / 124.864 · lastTested 17b · crossings 22
```

| date | open | high | low | close | EMA20 | EMA50 | EMA200 | OFF | ON |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2025-01-29 | 123.45 | 123.95 | 121.27 | 121.41 | 118.40 | 117.58 | 120.79 | BULLISH | BULLISH |
| 2025-01-30 | 106.53 | 107.07 | 99.48 | 104.27 | 117.06 | 117.06 | 120.63 | OVEREXTENDED | OVEREXTENDED |
| 2025-01-31 | 104.37 | 105.81 | 102.88 | 103.67 | 115.78 | 116.53 | 120.46 | OVEREXTENDED | OVEREXTENDED |
| 2025-02-03 | 101.94 | 102.15 | 99.28 | 101.00 | 114.37 | 115.92 | 120.26 | OVEREXTENDED | OVEREXTENDED |
| 2025-02-04 | 101.04 | 101.78 | 100.02 | 101.43 | 113.14 | 115.36 | 120.08 | OVEREXTENDED | OVEREXTENDED |
| 2025-02-05 | 101.39 | 102.25 | 100.74 | 101.55 | 112.04 | 114.81 | 119.89 | OVEREXTENDED | OVEREXTENDED |
| 2025-02-06 | 101.96 | 103.34 | 101.89 | 102.98 | 111.17 | 114.35 | 119.72 | BEARISH | BEARISH |
| 2025-02-07 | 103.34 | 103.42 | 102.20 | 102.65 | 110.36 | 113.89 | 119.55 | BEARISH | SIDEWAYS |
| 2025-02-10 | 103.02 | 104.16 | 102.33 | 103.60 | 109.72 | 113.49 | 119.39 | BEARISH | SIDEWAYS |
| 2025-02-11 | 103.46 | 104.10 | 102.93 | 103.94 | 109.17 | 113.11 | 119.24 | BEARISH | SIDEWAYS |
| 2025-02-12 | 102.87 | 104.22 | 102.81 | 103.69 | 108.65 | 112.74 | 119.08 | BEARISH | SIDEWAYS |
| 2025-02-13 | 103.95 | 105.39 | 103.77 | 104.95 | 108.29 | 112.44 | 118.94 | BEARISH | SIDEWAYS |
| 2025-02-14 | 105.33 | 105.96 | 104.96 | 105.47 | 108.03 | 112.16 | 118.81 | BEARISH | SIDEWAYS |
| 2025-02-18 | 105.44 | 106.58 | 104.86 | 106.25 | 107.86 | 111.93 | 118.68 | BEARISH | SIDEWAYS |
| 2025-02-19 | 105.82 | 106.26 | 105.17 | 105.86 | 107.67 | 111.69 | 118.56 | BEARISH | SIDEWAYS |
| 2025-02-20 | 105.83 | 107.36 | 105.72 | 107.33 | 107.63 | 111.52 | 118.45 | BEARISH | SIDEWAYS |
| 2025-02-21 | 107.19 | 107.56 | 106.10 | 107.08 | 107.58 | 111.35 | 118.33 | BEARISH | SIDEWAYS |
| 2025-02-24 | 107.31 | 108.69 | 106.65 | 106.93 | 107.52 | 111.18 | 118.22 | BEARISH | SIDEWAYS |
| 2025-02-25 | 107.20 | 108.93 | 107.20 | 108.72 | 107.63 | 111.08 | 118.13 | BEARISH | SIDEWAYS |
| 2025-02-26 | 108.71 | 109.14 | 107.44 | 107.60 | 107.63 | 110.94 | 118.02 | BEARISH | SIDEWAYS |
| 2025-02-27 | 107.70 | 109.29 | 107.69 | 108.28 | 107.69 | 110.84 | 117.92 | BULLISH | SIDEWAYS |

reason ids · OFF: macd-histogram(p,8.33), macd-signal(p,8.33), ema200-slope(n,7.5), ema50-slope(n,7.5), obv-trend(p,7.5), adx-dmi(n,4.46), bullish-divergence(c,4), ema-structure(n,2.5), ema20-slope(p,0.41), rsi14(n,0.23)

reason ids · ON: macd-histogram(p,8.33), macd-signal(p,8.33), ema200-slope(n,7.5), ema50-slope(n,7.5), obv-trend(p,7.5), component-conflict(c,7), adx-dmi(n,4.46), ema-structure(n,2.5), bullish-divergence(c,0.89), ema20-slope(p,0.41), rsi14(n,0.23)

flags · OFF: bullish_divergence, weak_confirmation · ON: weak_confirmation, conflicting_evidence, low_volume_confirmation

**A3: borderline.**

### A4. AVGO 2024-01-05 — truth UP, OFF BEARISH, ON SIDEWAYS

```
ground truth   displacement 5.82 ATR · efficiency 0.39 · ATR14 2.5054
adjudicator    d5 -2.84  d20 5.82  d60 7.58  ->  borderline
score          OFF -17.0 · ON -17.0 · band weak · conflicts 1
slopes         ema20 0.122%  ema50 4.722%  ema200 6.566%
strength       ADX 33.1 · +DI 25.8 · -DI 27.0 · RSI 49.8
regime         squeeze false · overextended false · sideways false · nonTrendingFallback false
zone (ON)      sideways · mode structural · pos 59.8% · nearest trigger 4.18 ATR · zoneAge 7 · frameAge 8 · S 87.5849 / R 112.0875 · trig 86.9585 / 112.7139 · lastTested 11b · crossings 36
```

| date | open | high | low | close | EMA20 | EMA50 | EMA200 | OFF | ON |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2023-12-06 | 89.26 | 89.32 | 87.58 | 87.64 | — | — | — | — | — |
| 2023-12-07 | 87.82 | 89.62 | 87.64 | 89.44 | — | — | — | — | — |
| 2023-12-08 | 89.98 | 92.20 | 88.31 | 91.58 | — | — | — | — | — |
| 2023-12-11 | 92.81 | 100.81 | 92.72 | 99.82 | — | — | — | — | — |
| 2023-12-12 | 99.70 | 104.68 | 99.37 | 103.99 | — | — | — | — | — |
| 2023-12-13 | 103.58 | 106.66 | 103.05 | 105.68 | — | — | — | — | — |
| 2023-12-14 | 105.92 | 108.76 | 105.74 | 107.31 | — | — | — | — | — |
| 2023-12-15 | 106.22 | 111.52 | 106.16 | 109.56 | — | — | — | — | — |
| 2023-12-18 | 108.70 | 111.71 | 108.49 | 111.24 | — | — | — | — | — |
| 2023-12-19 | 111.26 | 112.09 | 110.34 | 111.03 | — | — | — | — | — |
| 2023-12-20 | 110.36 | 111.20 | 108.07 | 108.18 | — | — | — | — | — |
| 2023-12-21 | 110.35 | 110.62 | 108.63 | 109.83 | — | — | — | — | — |
| 2023-12-22 | 109.90 | 110.29 | 108.49 | 109.31 | — | — | — | — | — |
| 2023-12-26 | 109.53 | 110.63 | 109.41 | 110.28 | — | — | — | — | — |
| 2023-12-27 | 110.68 | 111.03 | 109.41 | 109.72 | — | — | — | — | — |
| 2023-12-28 | 110.26 | 110.31 | 109.03 | 109.35 | — | — | — | — | — |
| 2023-12-29 | 109.26 | 109.55 | 108.60 | 108.75 | — | — | — | — | — |
| 2024-01-02 | 106.40 | 107.37 | 104.94 | 105.75 | — | — | — | — | — |
| 2024-01-03 | 104.27 | 104.74 | 102.82 | 103.14 | — | — | — | — | — |
| 2024-01-04 | 103.08 | 104.20 | 102.04 | 102.20 | 104.07 | 97.57 | 82.37 | BULLISH | SIDEWAYS |
| 2024-01-05 | 102.46 | 102.83 | 101.47 | 102.23 | 103.90 | 97.76 | 82.57 | BEARISH | SIDEWAYS |

reason ids · OFF: adx-dmi(n,9.8), macd-histogram(n,8.33), macd-signal(n,8.33), ema200-slope(p,7.5), ema50-slope(p,7.5), obv-trend(n,7.5), bearish-divergence(c,4), ema-structure(p,2.5), ema20-slope(p,0.91), rsi14(n,0.06)

reason ids · ON: adx-dmi(n,9.8), macd-histogram(n,8.33), macd-signal(n,8.33), ema200-slope(p,7.5), ema50-slope(p,7.5), obv-trend(n,7.5), component-conflict(c,7), ema-structure(p,2.5), ema20-slope(p,0.91), bearish-divergence(c,0.8), rsi14(n,0.06)

flags · OFF: bearish_divergence, weak_confirmation · ON: weak_confirmation, conflicting_evidence

**A4: borderline.**

### A5. SBUX 2024-05-29 — truth DOWN, OFF BULLISH, ON SIDEWAYS

```
ground truth   displacement -5.66 ATR · efficiency 0.34 · ATR14 1.8261
adjudicator    d5 -0.43  d20 -5.66  d60 -7.70  ->  borderline
score          OFF 8.0 · ON 3.0 · band neutral · conflicts 1
slopes         ema20 0.056%  ema50 -2.513%  ema200 -3.296%
strength       ADX 24.0 · +DI 22.3 · -DI 24.4 · RSI 42.7
regime         squeeze false · overextended false · sideways false · nonTrendingFallback false
zone (ON)      sideways · mode structural · pos 31.6% · nearest trigger 3.16 ATR · zoneAge 14 · frameAge 12 · S 67.3519 / R 84.1711 · trig 66.8954 / 84.6276 · lastTested 14b · crossings 27
```

| date | open | high | low | close | EMA20 | EMA50 | EMA200 | OFF | ON |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2024-04-30 | 82.18 | 83.48 | 81.78 | 83.01 | 82.60 | 84.12 | 87.70 | BULLISH | SIDEWAYS |
| 2024-05-01 | 71.12 | 72.22 | 68.17 | 69.83 | 81.39 | 83.56 | 87.52 | OVEREXTENDED | OVEREXTENDED |
| 2024-05-02 | 70.26 | 70.49 | 68.81 | 70.29 | 80.33 | 83.04 | 87.35 | OVEREXTENDED | OVEREXTENDED |
| 2024-05-03 | 70.61 | 70.83 | 68.47 | 68.58 | 79.21 | 82.47 | 87.16 | OVEREXTENDED | OVEREXTENDED |
| 2024-05-06 | 68.77 | 69.59 | 68.20 | 68.38 | 78.18 | 81.92 | 86.97 | OVEREXTENDED | OVEREXTENDED |
| 2024-05-07 | 68.34 | 68.34 | 67.35 | 68.01 | 77.21 | 81.37 | 86.78 | OVEREXTENDED | OVEREXTENDED |
| 2024-05-08 | 67.81 | 69.86 | 67.77 | 68.95 | 76.42 | 80.88 | 86.60 | OVEREXTENDED | OVEREXTENDED |
| 2024-05-09 | 69.01 | 71.07 | 68.54 | 70.99 | 75.91 | 80.50 | 86.44 | BEARISH | SIDEWAYS |
| 2024-05-10 | 70.64 | 71.58 | 70.41 | 71.39 | 75.48 | 80.14 | 86.29 | BEARISH | SIDEWAYS |
| 2024-05-13 | 71.50 | 72.08 | 71.10 | 71.46 | 75.09 | 79.80 | 86.14 | BEARISH | SIDEWAYS |
| 2024-05-14 | 71.51 | 71.98 | 70.84 | 70.94 | 74.70 | 79.45 | 85.99 | BEARISH | SIDEWAYS |
| 2024-05-15 | 71.20 | 71.32 | 70.65 | 71.01 | 74.35 | 79.12 | 85.83 | BEARISH | SIDEWAYS |
| 2024-05-16 | 71.07 | 71.41 | 70.38 | 71.15 | 74.04 | 78.81 | 85.69 | BEARISH | SIDEWAYS |
| 2024-05-17 | 71.14 | 73.72 | 70.81 | 73.58 | 74.00 | 78.60 | 85.56 | BEARISH | SIDEWAYS |
| 2024-05-20 | 73.42 | 74.03 | 72.50 | 73.29 | 73.93 | 78.40 | 85.44 | BEARISH | SIDEWAYS |
| 2024-05-21 | 73.31 | 73.93 | 73.25 | 73.46 | 73.89 | 78.20 | 85.32 | BEARISH | SIDEWAYS |
| 2024-05-22 | 73.44 | 76.58 | 73.19 | 76.29 | 74.12 | 78.13 | 85.22 | BULLISH | SIDEWAYS |
| 2024-05-23 | 75.71 | 76.27 | 73.38 | 74.02 | 74.11 | 77.97 | 85.11 | BULLISH | SIDEWAYS |
| 2024-05-24 | 74.20 | 74.88 | 73.83 | 74.55 | 74.15 | 77.83 | 85.00 | BULLISH | SIDEWAYS |
| 2024-05-28 | 74.47 | 74.48 | 73.17 | 73.23 | 74.06 | 77.65 | 84.88 | BULLISH | SIDEWAYS |
| 2024-05-29 | 72.87 | 74.03 | 72.62 | 72.66 | 73.93 | 77.46 | 84.76 | BULLISH | SIDEWAYS |

reason ids · OFF: swing-structure(p,15), macd-signal(p,8.33), ema-structure(n,7.5), ema200-slope(n,7.5), ema50-slope(n,7.5), obv-trend(p,7.5), macd-histogram(p,4.17), bullish-divergence(c,4), adx-dmi(n,3.03), rsi14(n,2.45), ema20-slope(p,0.42)

reason ids · ON: swing-structure(p,15), macd-signal(p,8.33), ema-structure(n,7.5), ema200-slope(n,7.5), ema50-slope(n,7.5), obv-trend(p,7.5), component-conflict(c,7), macd-histogram(p,4.17), adx-dmi(n,3.03), rsi14(n,2.45), bullish-divergence(c,1.74), ema20-slope(p,0.42)

flags · OFF: bullish_divergence, weak_confirmation · ON: weak_confirmation, conflicting_evidence, low_volume_confirmation

**A5: borderline.**

### A6. MRK 2024-08-26 — truth DOWN, OFF BULLISH, ON SIDEWAYS

```
ground truth   displacement -5.11 ATR · efficiency 0.37 · ATR14 2.1067
adjudicator    d5 0.82  d20 -5.11  d60 -3.34  ->  borderline
score          OFF 2.0 · ON -3.0 · band neutral · conflicts 1
slopes         ema20 -0.131%  ema50 -2.024%  ema200 -0.965%
strength       ADX 24.3 · +DI 22.8 · -DI 23.2 · RSI 45.9
regime         squeeze false · overextended false · sideways false · nonTrendingFallback false
zone (ON)      sideways · mode structural · pos 30.8% · nearest trigger 2.72 ATR · zoneAge 9 · frameAge 10 · S 103.639 / R 120.4972 · trig 103.1123 / 121.0239 · lastTested 13b · crossings 27
```

| date | open | high | low | close | EMA20 | EMA50 | EMA200 | OFF | ON |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2024-07-29 | 117.74 | 119.80 | 116.93 | 119.61 | 118.49 | 119.02 | 113.03 | SQUEEZE | SQUEEZE |
| 2024-07-30 | 115.58 | 116.01 | 106.63 | 107.88 | 117.48 | 118.58 | 112.97 | OVEREXTENDED | OVEREXTENDED |
| 2024-07-31 | 108.58 | 110.30 | 105.04 | 105.89 | 116.37 | 118.08 | 112.90 | OVEREXTENDED | OVEREXTENDED |
| 2024-08-01 | 105.89 | 107.15 | 104.28 | 106.54 | 115.44 | 117.63 | 112.84 | STRONG_BEARISH | STRONG_BEARISH |
| 2024-08-02 | 107.80 | 109.80 | 107.05 | 107.83 | 114.71 | 117.25 | 112.79 | STRONG_BEARISH | STRONG_BEARISH |
| 2024-08-05 | 107.60 | 107.76 | 104.22 | 105.13 | 113.80 | 116.77 | 112.71 | BEARISH | BEARISH |
| 2024-08-06 | 105.12 | 105.85 | 103.83 | 104.04 | 112.87 | 116.27 | 112.63 | BEARISH | BEARISH |
| 2024-08-07 | 104.54 | 105.35 | 103.64 | 105.30 | 112.15 | 115.84 | 112.55 | BEARISH | BEARISH |
| 2024-08-08 | 105.70 | 106.92 | 105.37 | 106.63 | 111.62 | 115.48 | 112.49 | BEARISH | BEARISH |
| 2024-08-09 | 106.50 | 107.38 | 105.65 | 107.22 | 111.21 | 115.16 | 112.44 | BEARISH | BEARISH |
| 2024-08-12 | 107.37 | 107.37 | 105.88 | 106.22 | 110.73 | 114.81 | 112.38 | BEARISH | BEARISH |
| 2024-08-13 | 106.31 | 107.52 | 105.62 | 107.07 | 110.38 | 114.50 | 112.32 | BEARISH | SIDEWAYS |
| 2024-08-14 | 106.39 | 106.64 | 104.38 | 106.32 | 110.00 | 114.18 | 112.26 | BEARISH | SIDEWAYS |
| 2024-08-15 | 106.87 | 107.18 | 105.37 | 106.06 | 109.62 | 113.86 | 112.20 | BEARISH | SIDEWAYS |
| 2024-08-16 | 106.34 | 106.45 | 105.42 | 106.40 | 109.31 | 113.57 | 112.14 | BEARISH | SIDEWAYS |
| 2024-08-19 | 106.39 | 107.27 | 106.06 | 107.10 | 109.10 | 113.32 | 112.09 | BEARISH | SIDEWAYS |
| 2024-08-20 | 107.42 | 107.93 | 107.22 | 107.78 | 108.98 | 113.10 | 112.05 | BEARISH | SIDEWAYS |
| 2024-08-21 | 107.44 | 109.14 | 107.22 | 108.61 | 108.94 | 112.92 | 112.01 | BEARISH | SIDEWAYS |
| 2024-08-22 | 108.86 | 109.26 | 107.85 | 109.10 | 108.96 | 112.77 | 111.99 | BULLISH | SIDEWAYS |
| 2024-08-23 | 109.33 | 109.34 | 108.51 | 109.14 | 108.97 | 112.63 | 111.96 | SIDEWAYS | SIDEWAYS |
| 2024-08-26 | 109.26 | 110.36 | 108.73 | 108.83 | 108.96 | 112.48 | 111.93 | BULLISH | SIDEWAYS |

reason ids · OFF: macd-histogram(p,8.33), macd-signal(p,8.33), ema50-slope(n,7.5), obv-trend(p,7.5), ema200-slope(n,7.23), bearish-divergence(c,4), adx-dmi(n,3.24), ema-structure(n,2.5), rsi14(n,1.36), ema20-slope(n,0.98)

reason ids · ON: macd-histogram(p,8.33), macd-signal(p,8.33), ema50-slope(n,7.5), obv-trend(p,7.5), ema200-slope(n,7.23), component-conflict(c,7), adx-dmi(n,3.24), ema-structure(n,2.5), rsi14(n,1.36), ema20-slope(n,0.98), bearish-divergence(c,0.8)

flags · OFF: bearish_divergence, weak_confirmation · ON: weak_confirmation, conflicting_evidence, low_volume_confirmation

**A6: borderline.**

### A7. ACN 2026-07-08 — truth DOWN, OFF BULLISH, ON SIDEWAYS

```
ground truth   displacement -5.07 ATR · efficiency 0.40 · ATR14 7.2536
adjudicator    d5 1.74  d20 -5.07  d60 -5.77  ->  borderline
score          OFF 1.0 · ON -4.0 · band neutral · conflicts 1
slopes         ema20 -2.660%  ema50 -8.018%  ema200 -6.646%
strength       ADX 28.0 · +DI 26.3 · -DI 32.7 · RSI 40.6
regime         squeeze false · overextended false · sideways false · nonTrendingFallback false
zone (ON)      sideways · mode structural · pos 23.8% · nearest trigger 2.84 ATR · zoneAge 7 · frameAge 8 · S 116.7462 / R 195.6475 · trig 114.9328 / 197.4609 · lastTested 11b · crossings 28
```

| date | open | high | low | close | EMA20 | EMA50 | EMA200 | OFF | ON |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-08 | 174.85 | 178.04 | 172.30 | 172.36 | 177.34 | 183.47 | 222.55 | BEARISH | SIDEWAYS |
| 2026-06-09 | 171.40 | 174.26 | 168.31 | 171.41 | 176.77 | 183.00 | 222.03 | BEARISH | SIDEWAYS |
| 2026-06-10 | 168.08 | 171.47 | 165.86 | 168.47 | 175.98 | 182.43 | 221.50 | BEARISH | SIDEWAYS |
| 2026-06-11 | 165.11 | 168.81 | 161.64 | 165.53 | 174.99 | 181.77 | 220.94 | BEARISH | SIDEWAYS |
| 2026-06-12 | 166.44 | 169.73 | 162.69 | 168.26 | 174.35 | 181.24 | 220.41 | BEARISH | SIDEWAYS |
| 2026-06-15 | 165.61 | 170.54 | 163.09 | 163.40 | 173.30 | 180.54 | 219.84 | BEARISH | SIDEWAYS |
| 2026-06-16 | 163.66 | 167.77 | 163.07 | 163.55 | 172.38 | 179.87 | 219.27 | BEARISH | SIDEWAYS |
| 2026-06-17 | 162.94 | 164.89 | 154.06 | 154.16 | 170.64 | 178.86 | 218.62 | BEARISH | SIDEWAYS |
| 2026-06-18 | 125.00 | 133.10 | 124.11 | 126.46 | 166.43 | 176.81 | 217.70 | OVEREXTENDED | OVEREXTENDED |
| 2026-06-22 | 123.51 | 124.34 | 116.75 | 123.35 | 162.33 | 174.71 | 216.75 | OVEREXTENDED | OVEREXTENDED |
| 2026-06-23 | 123.31 | 126.31 | 122.94 | 125.50 | 158.82 | 172.78 | 215.84 | OVEREXTENDED | OVEREXTENDED |
| 2026-06-24 | 124.99 | 130.31 | 124.31 | 127.62 | 155.85 | 171.01 | 214.96 | OVEREXTENDED | OVEREXTENDED |
| 2026-06-25 | 126.83 | 128.26 | 124.19 | 124.33 | 152.85 | 169.18 | 214.05 | OVEREXTENDED | OVEREXTENDED |
| 2026-06-26 | 124.75 | 127.71 | 124.22 | 127.45 | 150.43 | 167.54 | 213.18 | BEARISH | SIDEWAYS |
| 2026-06-29 | 129.03 | 130.81 | 122.96 | 123.26 | 147.84 | 165.81 | 212.28 | OVEREXTENDED | OVEREXTENDED |
| 2026-06-30 | 121.80 | 123.99 | 120.33 | 122.96 | 145.47 | 164.13 | 211.39 | BEARISH | SIDEWAYS |
| 2026-07-01 | 124.70 | 132.22 | 124.55 | 129.57 | 143.96 | 162.77 | 210.57 | BEARISH | SIDEWAYS |
| 2026-07-02 | 131.56 | 137.25 | 131.36 | 135.72 | 143.17 | 161.71 | 209.82 | BEARISH | SIDEWAYS |
| 2026-07-06 | 134.34 | 136.47 | 131.91 | 135.33 | 142.43 | 160.68 | 209.07 | BEARISH | SIDEWAYS |
| 2026-07-07 | 138.73 | 142.26 | 138.72 | 140.45 | 142.24 | 159.88 | 208.39 | BEARISH | SIDEWAYS |
| 2026-07-08 | 138.09 | 139.95 | 135.53 | 135.56 | 141.60 | 158.93 | 207.66 | BULLISH | SIDEWAYS |

reason ids · OFF: swing-structure(p,15), macd-histogram(p,8.33), macd-signal(p,8.33), ema-structure(n,7.5), ema20-slope(n,7.5), ema200-slope(n,7.5), ema50-slope(n,7.5), obv-trend(p,7.5), adx-dmi(n,5.98), bullish-divergence(c,4), rsi14(n,3.12)

reason ids · ON: swing-structure(p,15), macd-histogram(p,8.33), macd-signal(p,8.33), ema-structure(n,7.5), ema20-slope(n,7.5), ema200-slope(n,7.5), ema50-slope(n,7.5), obv-trend(p,7.5), component-conflict(c,7), adx-dmi(n,5.98), rsi14(n,3.12), bullish-divergence(c,2)

flags · OFF: bullish_divergence, weak_confirmation · ON: bullish_divergence, weak_confirmation, conflicting_evidence, low_volume_confirmation

**A7: borderline.**

### A8. XRP-USD 2024-10-19 — truth DOWN, OFF BULLISH, ON SIDEWAYS

```
ground truth   displacement -5.02 ATR · efficiency 0.45 · ATR14 0.0195
adjudicator    d5 -0.19  d20 -5.02  d60 -2.58  ->  borderline
score          OFF 0.0 · ON -5.0 · band neutral · conflicts 1
slopes         ema20 -0.364%  ema50 -1.338%  ema200 -0.404%
strength       ADX 11.7 · +DI 20.2 · -DI 18.6 · RSI 46.9
regime         squeeze false · overextended false · sideways false · nonTrendingFallback false
zone (ON)      sideways · mode structural · pos 22.5% · nearest trigger 2 ATR · zoneAge 12 · frameAge 13 · S 0.5101 / R 0.6622 · trig 0.5052 / 0.6671 · lastTested 16b · crossings 20
```

| date | open | high | low | close | EMA20 | EMA50 | EMA200 | OFF | ON |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2024-09-29 | 0.61 | 0.66 | 0.61 | 0.64 | 0.59 | 0.58 | 0.56 | BULLISH | SIDEWAYS |
| 2024-09-30 | 0.64 | 0.65 | 0.61 | 0.61 | 0.59 | 0.58 | 0.56 | BULLISH | SIDEWAYS |
| 2024-10-01 | 0.61 | 0.63 | 0.58 | 0.60 | 0.59 | 0.58 | 0.56 | SQUEEZE | SQUEEZE |
| 2024-10-02 | 0.60 | 0.61 | 0.53 | 0.54 | 0.59 | 0.58 | 0.56 | SQUEEZE | SQUEEZE |
| 2024-10-03 | 0.54 | 0.54 | 0.51 | 0.52 | 0.58 | 0.57 | 0.56 | SIDEWAYS | BEARISH |
| 2024-10-04 | 0.52 | 0.54 | 0.52 | 0.53 | 0.58 | 0.57 | 0.56 | SIDEWAYS | BEARISH |
| 2024-10-05 | 0.53 | 0.53 | 0.53 | 0.53 | 0.57 | 0.57 | 0.56 | SIDEWAYS | BEARISH |
| 2024-10-06 | 0.53 | 0.54 | 0.53 | 0.53 | 0.57 | 0.57 | 0.55 | BEARISH | BEARISH |
| 2024-10-07 | 0.53 | 0.55 | 0.53 | 0.53 | 0.56 | 0.57 | 0.55 | BEARISH | SIDEWAYS |
| 2024-10-08 | 0.53 | 0.53 | 0.52 | 0.53 | 0.56 | 0.57 | 0.55 | BEARISH | SIDEWAYS |
| 2024-10-09 | 0.53 | 0.53 | 0.52 | 0.52 | 0.56 | 0.56 | 0.55 | BEARISH | SIDEWAYS |
| 2024-10-10 | 0.52 | 0.54 | 0.52 | 0.53 | 0.56 | 0.56 | 0.55 | BEARISH | SIDEWAYS |
| 2024-10-11 | 0.53 | 0.54 | 0.53 | 0.54 | 0.55 | 0.56 | 0.55 | BEARISH | SIDEWAYS |
| 2024-10-12 | 0.54 | 0.54 | 0.54 | 0.54 | 0.55 | 0.56 | 0.55 | BEARISH | SIDEWAYS |
| 2024-10-13 | 0.54 | 0.54 | 0.53 | 0.53 | 0.55 | 0.56 | 0.55 | BEARISH | SIDEWAYS |
| 2024-10-14 | 0.53 | 0.55 | 0.53 | 0.55 | 0.55 | 0.56 | 0.55 | SIDEWAYS | SIDEWAYS |
| 2024-10-15 | 0.55 | 0.55 | 0.53 | 0.54 | 0.55 | 0.56 | 0.55 | SIDEWAYS | SIDEWAYS |
| 2024-10-16 | 0.54 | 0.55 | 0.54 | 0.55 | 0.55 | 0.56 | 0.55 | SIDEWAYS | SIDEWAYS |
| 2024-10-17 | 0.55 | 0.56 | 0.54 | 0.54 | 0.55 | 0.56 | 0.55 | BEARISH | SIDEWAYS |
| 2024-10-18 | 0.54 | 0.55 | 0.54 | 0.55 | 0.55 | 0.56 | 0.55 | SIDEWAYS | SIDEWAYS |
| 2024-10-19 | 0.55 | 0.55 | 0.54 | 0.54 | 0.55 | 0.56 | 0.55 | BULLISH | SIDEWAYS |

reason ids · OFF: ema50-slope(n,7.5), obv-trend(p,7.5), macd-histogram(p,5.03), bearish-divergence(c,4), macd-signal(p,3.93), ema200-slope(n,3.03), ema20-slope(n,2.73), ema-structure(n,2.5), rsi14(n,1.02)

reason ids · ON: ema50-slope(n,7.5), obv-trend(p,7.5), component-conflict(c,7), macd-histogram(p,5.03), macd-signal(p,3.93), ema200-slope(n,3.03), ema20-slope(n,2.73), ema-structure(n,2.5), rsi14(n,1.02), bearish-divergence(c,0.8)

flags · OFF: bearish_divergence, weak_confirmation · ON: conflicting_evidence, low_volume_confirmation

**A8: borderline.**

### A9. TXN 2025-12-19 — truth UP, OFF BEARISH, ON SIDEWAYS

```
ground truth   displacement 5.01 ATR · efficiency 0.47 · ATR14 4.5101
adjudicator    d5 -0.68  d20 5.01  d60 -0.90  ->  ground truth wrong
score          OFF -22.0 · ON -22.0 · band weak · conflicts 1
slopes         ema20 0.689%  ema50 1.563%  ema200 -0.516%
strength       ADX 23.0 · +DI 19.0 · -DI 19.0 · RSI 55.3
regime         squeeze false · overextended false · sideways false · nonTrendingFallback false
zone (ON)      sideways · mode structural · pos 73.6% · nearest trigger 2.1 ATR · zoneAge 6 · frameAge 7 · S 150.2034 / R 181.7035 · trig 149.0759 / 182.8311 · lastTested 9b · crossings 53
```

| date | open | high | low | close | EMA20 | EMA50 | EMA200 | OFF | ON |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2025-11-20 | 155.54 | 156.62 | 150.20 | 150.79 | 158.87 | 166.90 | 177.01 | BEARISH | SIDEWAYS |
| 2025-11-21 | 150.88 | 158.49 | 150.87 | 156.76 | 158.67 | 166.50 | 176.81 | BEARISH | SIDEWAYS |
| 2025-11-24 | 157.08 | 160.01 | 156.34 | 158.59 | 158.66 | 166.19 | 176.63 | SQUEEZE | SQUEEZE |
| 2025-11-25 | 157.08 | 159.27 | 156.06 | 159.09 | 158.70 | 165.91 | 176.45 | SQUEEZE | SQUEEZE |
| 2025-11-26 | 159.63 | 164.28 | 159.37 | 162.61 | 159.07 | 165.78 | 176.31 | SQUEEZE | SQUEEZE |
| 2025-11-28 | 163.29 | 166.45 | 162.68 | 165.49 | 159.68 | 165.77 | 176.20 | BULLISH | SIDEWAYS |
| 2025-12-01 | 164.08 | 166.86 | 163.78 | 165.38 | 160.23 | 165.76 | 176.09 | BULLISH | BULLISH |
| 2025-12-02 | 165.92 | 174.94 | 165.23 | 172.36 | 161.38 | 166.02 | 176.05 | BULLISH | BULLISH |
| 2025-12-03 | 173.89 | 179.97 | 172.68 | 179.58 | 163.12 | 166.55 | 176.09 | OVEREXTENDED | OVEREXTENDED |
| 2025-12-04 | 180.21 | 180.87 | 175.98 | 177.14 | 164.45 | 166.96 | 176.09 | BULLISH | BULLISH |
| 2025-12-05 | 177.88 | 181.70 | 177.64 | 179.52 | 165.89 | 167.46 | 176.13 | BULLISH | BULLISH |
| 2025-12-08 | 180.47 | 180.66 | 176.56 | 177.95 | 167.03 | 167.87 | 176.14 | BULLISH | BULLISH |
| 2025-12-09 | 176.93 | 178.87 | 176.43 | 176.55 | 167.94 | 168.21 | 176.14 | BULLISH | BULLISH |
| 2025-12-10 | 174.89 | 179.70 | 174.56 | 178.66 | 168.96 | 168.62 | 176.16 | BULLISH | BULLISH |
| 2025-12-11 | 177.30 | 179.01 | 176.22 | 178.66 | 169.89 | 169.01 | 176.19 | BULLISH | SIDEWAYS |
| 2025-12-12 | 178.78 | 180.20 | 175.69 | 176.45 | 170.51 | 169.30 | 176.19 | BULLISH | SIDEWAYS |
| 2025-12-15 | 172.45 | 176.39 | 171.12 | 175.03 | 170.94 | 169.53 | 176.17 | BULLISH | SIDEWAYS |
| 2025-12-16 | 175.39 | 176.07 | 173.09 | 174.62 | 171.29 | 169.73 | 176.15 | BULLISH | SIDEWAYS |
| 2025-12-17 | 174.93 | 176.67 | 170.82 | 171.60 | 171.32 | 169.80 | 176.10 | BEARISH | SIDEWAYS |
| 2025-12-18 | 173.88 | 175.94 | 172.99 | 173.28 | 171.51 | 169.94 | 176.07 | BEARISH | SIDEWAYS |
| 2025-12-19 | 172.81 | 175.29 | 172.69 | 173.37 | 171.69 | 170.07 | 176.04 | BEARISH | SIDEWAYS |

reason ids · OFF: swing-structure(n,15), ema50-slope(p,7.5), obv-trend(n,7.5), relative-volume(n,7.5), ema20-slope(p,5.16), macd-histogram(n,4.17), bullish-divergence(c,4), ema200-slope(n,3.87), macd-signal(n,2.79), ema-structure(p,2.5), adx-dmi(p,2.22), rsi14(p,1.75)

reason ids · ON: swing-structure(n,15), ema50-slope(p,7.5), obv-trend(n,7.5), relative-volume(n,7.5), component-conflict(c,7), ema20-slope(p,5.16), macd-histogram(n,4.17), ema200-slope(n,3.87), macd-signal(n,2.79), ema-structure(p,2.5), adx-dmi(p,2.22), rsi14(p,1.75)

flags · OFF: high_volume, bullish_divergence · ON: high_volume, conflicting_evidence

**A9: ground truth wrong.**

### A10. IBM 2026-08-07 — truth DOWN, OFF BULLISH, ON SIDEWAYS

```
ground truth   displacement -4.90 ATR · efficiency 0.33 · ATR14 10.1780
adjudicator    d5 1.33  d20 -4.90  d60 1.76  ->  ground truth wrong
score          OFF 6.0 · ON 1.0 · band neutral · conflicts 1
slopes         ema20 0.043%  ema50 -3.072%  ema200 -2.651%
strength       ADX 22.9 · +DI 27.6 · -DI 31.4 · RSI 49.8
regime         squeeze false · overextended false · sideways false · nonTrendingFallback false
zone (ON)      sideways · mode structural · pos 33.8% · nearest trigger 3.97 ATR · zoneAge 12 · frameAge 8 · S 197.7713 / R 309.5792 · trig 195.2268 / 312.1237 · lastTested 11b · crossings 27
```

| date | open | high | low | close | EMA20 | EMA50 | EMA200 | OFF | ON |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-07-10 | 295.14 | 296.64 | 285.45 | 285.51 | 279.97 | 267.39 | 260.91 | BULLISH | SIDEWAYS |
| 2026-07-13 | 288.43 | 295.38 | 287.04 | 288.16 | 280.75 | 268.20 | 261.18 | BULLISH | SIDEWAYS |
| 2026-07-14 | 224.76 | 228.28 | 211.70 | 215.52 | 274.54 | 266.14 | 260.72 | OVEREXTENDED | OVEREXTENDED |
| 2026-07-15 | 219.40 | 222.22 | 209.53 | 209.70 | 268.36 | 263.92 | 260.21 | OVEREXTENDED | OVEREXTENDED |
| 2026-07-16 | 207.33 | 218.38 | 202.98 | 217.49 | 263.52 | 262.10 | 259.79 | BEARISH | BEARISH |
| 2026-07-17 | 214.08 | 215.62 | 208.72 | 211.16 | 258.53 | 260.10 | 259.30 | BEARISH | BEARISH |
| 2026-07-20 | 208.57 | 214.74 | 207.33 | 211.48 | 254.05 | 258.20 | 258.82 | BEARISH | BEARISH |
| 2026-07-21 | 209.22 | 213.44 | 207.69 | 209.00 | 249.76 | 256.27 | 258.32 | BEARISH | BEARISH |
| 2026-07-22 | 206.20 | 210.83 | 203.27 | 204.30 | 245.43 | 254.23 | 257.78 | BEARISH | SIDEWAYS |
| 2026-07-23 | 201.20 | 206.07 | 197.77 | 205.18 | 241.60 | 252.31 | 257.26 | BEARISH | SIDEWAYS |
| 2026-07-24 | 207.79 | 214.56 | 205.33 | 212.66 | 238.84 | 250.75 | 256.81 | BEARISH | SIDEWAYS |
| 2026-07-27 | 216.20 | 218.07 | 213.76 | 214.74 | 236.55 | 249.34 | 256.39 | BEARISH | SIDEWAYS |
| 2026-07-28 | 218.16 | 227.35 | 213.58 | 225.93 | 235.53 | 248.42 | 256.09 | BEARISH | SIDEWAYS |
| 2026-07-29 | 226.08 | 229.32 | 222.35 | 224.83 | 234.51 | 247.50 | 255.77 | BEARISH | SIDEWAYS |
| 2026-07-30 | 220.42 | 223.26 | 218.63 | 220.16 | 233.15 | 246.42 | 255.42 | BEARISH | SIDEWAYS |
| 2026-07-31 | 219.57 | 223.16 | 215.05 | 222.06 | 232.09 | 245.47 | 255.08 | BEARISH | SIDEWAYS |
| 2026-08-03 | 226.70 | 226.92 | 223.27 | 224.70 | 231.39 | 244.65 | 254.78 | BEARISH | SIDEWAYS |
| 2026-08-04 | 223.16 | 233.63 | 221.71 | 233.48 | 231.59 | 244.22 | 254.56 | BEARISH | SIDEWAYS |
| 2026-08-05 | 234.42 | 237.26 | 231.80 | 234.24 | 231.84 | 243.82 | 254.36 | BEARISH | SIDEWAYS |
| 2026-08-06 | 227.97 | 232.80 | 226.81 | 231.77 | 231.83 | 243.35 | 254.13 | BEARISH | SIDEWAYS |
| 2026-08-07 | 233.70 | 235.63 | 231.06 | 235.59 | 232.19 | 243.05 | 253.95 | BULLISH | SIDEWAYS |

reason ids · OFF: macd-histogram(p,8.33), macd-signal(p,8.33), ema200-slope(n,7.5), ema50-slope(n,7.5), obv-trend(p,7.5), structure-breakout(p,7.5), swing-structure(n,7.5), bullish-divergence(c,4), structure-volume-unconfirmed(c,3), ema-structure(n,2.5), adx-dmi(n,2.2), ema20-slope(p,0.32)

reason ids · ON: macd-histogram(p,8.33), macd-signal(p,8.33), ema200-slope(n,7.5), ema50-slope(n,7.5), obv-trend(p,7.5), structure-breakout(p,7.5), swing-structure(n,7.5), component-conflict(c,7), structure-volume-unconfirmed(c,3), ema-structure(n,2.5), adx-dmi(n,2.2), bullish-divergence(c,0.82)

flags · OFF: bullish_divergence, weak_confirmation · ON: weak_confirmation, conflicting_evidence, low_volume_confirmation

**A10: ground truth wrong.**

## B. The veto that eats the trend when ON

Of 72805 bars, the ground truth calls **23487** a move (UP or DOWN). Engine ON
answers SIDEWAYS on **11330** of them — UP 6970, DOWN 4360 — which is
48.2% of every move in the corpus. A further 3346 moves are covered by
SQUEEZE / OVEREXTENDED; those are the regime veto, they are not SIDEWAYS, and they are
reported here rather than folded in.

Of the 11330 lost bars, engine OFF named the ground truth's direction on **10792**
(95.3%) — the same engine, the same bars, one flag apart. So these are not bars where
the evidence was absent: the direction was available and something declined to publish
it. That is measured bar for bar here rather than inferred from the two row-correct
percentages, and it is what the rest of this section is looking for.

### Overlapping — how many of the lost bars each condition is TRUE on

A bar can satisfy several and is counted in every column it satisfies.

| condition | bars | % of the 11330 lost |
| --- | --- | --- |
| band == neutral (\|score\| < 15) | 535 | 4.7% |
| conflicts non-empty | 2029 | 17.9% |
| zone == sideways | 11330 | 100.0% |
| regime.sideways | 23 | 0.2% |
| nonTrendingFallback | 565 | 5.0% |
| regime.sideways OR nonTrendingFallback | 584 | 5.2% |
| no zone at all (ATR unavailable) | 0 | 0.0% |

### Non-overlapping — which one the engine actually returned on

Attribution follows the ENGINE's own order of evaluation, not a preference. With zones
on, `state` comes from `zonePresentationState`, and its body is four lines: squeeze,
overextended, `zone === 'sideways'`, then a direction. The gate never gets asked. So a
condition that is true on a bar but sits below the line that returned is a **passenger**,
and the gap between this table and the one above it is the finding.

| cause | bars | % of the 11330 lost |
| --- | --- | --- |
| zone == sideways (zonePresentationState returned first) | 11330 | 100.0% |
| gate neutral/conflict — reachable only with no zone | 0 | 0.0% |
| regime.sideways / nonTrendingFallback — same branch | 0 | 0.0% |
| unattributed (falsifies the precedence model above) | 0 | 0.0% |

### Inside the winning cause — which zone rule held the frame

The 11330 bars claimed by `zone == sideways`, split by what kept the zone sideways.

| frame mode | bars | % |
| --- | --- | --- |
| structural (a real swing high/low pair) | 11158 | 98.5% |
| atr_band (no usable pivot pair, or narrower than 1 ATR) | 172 | 1.5% |

Pending a confirmation that never came — close already beyond a trigger, waiting on
`confirmation.barsWithoutVolume`: **748** bars (6.6%).

Distance from the close to the nearest trigger, in ATR. This is the quantity
`triggerAtrMultiple` (0.25) and the frame width jointly decide, so it is where a knob
would have to bite:

| nearest trigger (ATR) | bars | % |
| --- | --- | --- |
| < 0 — close already past the trigger, confirmation not met | 742 | 6.5% |
| 0 .. 0.25 — inside the trigger buffer (triggerAtrMultiple) | 713 | 6.3% |
| 0.25 .. 0.5 | 963 | 8.5% |
| 0.5 .. 1 | 2311 | 20.4% |
| 1 .. 2 | 4000 | 35.3% |
| 2 .. 3 | 1683 | 14.9% |
| >= 3 — deep inside a frame nothing is near | 918 | 8.1% |

A wide frame and a moving frame produce the same number in that table, and they are
different diagnoses. These separate them:

| | p10 | median | p90 | max |
| --- | --- | --- | --- | --- |
| `frameAgeBars` — bars since the frame last re-anchored | 1 | 5 | 25 | 108 |
| `zoneAgeBars` — bars price has held this zone | 1 | 6 | 35 | 114 |
| `lastTestedBarsAgo` — bars since a bar's range reached an edge | 0 | 3 | 20 | 82 |

Only **74** of the 11330 (0.7%) sit on a frame older than
`anchor.untestedReanchorBars` (60), and none of them has an untested frame — the median
frame is a handful of bars old and was touched days ago. **So the frame is not stale and
it is not wide by neglect: it re-anchors constantly, and it re-anchors under the move.**
A confirmed pivot forming outside the frame re-anchors it, and a trend manufactures
exactly those pivots as it goes, so the boundary travels with price and the close stays
a median of 1.19 ATR inside it for as long as the move lasts.

### The mirror — why OFF over-speaks, measured the same way

B is scoped to the ON state because that is where the trend goes missing. But the two
states fail in OPPOSITE directions and a cause that explains only one of them is half
an answer, so the same question was asked of OFF on the same bars: **the ground truth
says SIDEWAYS, what does OFF say?**

Of 42827 quiet bars OFF labels, it names a direction on **35419**
(82.7%) and says SIDEWAYS on 7408. Of the 7408 it does keep quiet on,
7408 (100.0%) are `regime.sideways` or `nonTrendingFallback` — which is the whole
of the flags-OFF path to the word SIDEWAYS. There is no other one:
`presentationState` ends `return score >= 0 ? 'BULLISH' : 'BEARISH'`, with no dead
band anywhere above it.

The obvious next guess is that those calls are thin — a direction published off a
score of +3, which is what case A3 shows. The distribution says otherwise. Absolute
score over the 35419 quiet bars OFF named a direction on:

| bucket | bars | % |
| --- | --- | --- |
| abs(score) 0 .. 5 | 1577 | 4.5% |
| abs(score) 5 .. 10 | 1757 | 5.0% |
| abs(score) 10 .. 15   <- the gate neutral band ends here | 1748 | 4.9% |
| abs(score) 15 .. 20 | 1822 | 5.1% |
| abs(score) 20 .. 40 | 13142 | 37.1% |
| abs(score) >= 40 | 15373 | 43.4% |

Median absolute score 36.0. Only **5082** of them
(14.3%) sit inside the gate's neutral band (absolute score < 15), so a
missing band is not the explanation: 85.7% of these calls would clear that band and
still be published. **A thin score is a real defect and it is not the big one.**

The big one is on the other side of the same count. Every one of the
7408 bars OFF does say SIDEWAYS on — 100.0%, all of them — arrives through
`regime.sideways || nonTrendingFallback`, because with the gate off that branch is the
ONLY route to the word. And `regime.sideways` is a unanimity test:
`classifyRegimeEvidence` scores five items — EMA compression, flat slopes, low ADX,
mid RSI, a flat histogram — and `sideways.evidenceRequired` demands 4 of them true
with at least 4 computable. Four of five simultaneously is close to unanimity, almost
nothing in a real corpus clears it, so almost nothing reaches SIDEWAYS and
`presentationState` ends `return score >= 0 ? 'BULLISH' : 'BEARISH'` with no third
option. **OFF over-speaks because its quiet branch demands unanimity, not because its
loud branch is thin.**

## C. Sensitivity of the thresholds B named

Only the knobs that appear in B, moved +-20%, engine GATE+ZONES ON, everything else
identical. The override is applied to the config OBJECT IN MEMORY for the life of one
collection process and is written into each shard file; `src/config/signal.ts` on disk
is unchanged. **No value below is a proposal.** This section reports what moving the
knob does and stops there.

### Why these two, and not the other thirty-eight

B attributes 100% of the loss to `zone == sideways`, so the candidate set is the
numbers `calculateTrendZones` reads and nothing else. Of those, B measured the cost of
each, and two survive a +-20% move as a MEANINGFUL move:

| knob | why it is in, or out |
| --- | --- |
| `zone.triggerAtrMultiple` (0.25) | **in.** The `0 .. 0.25 ATR` bucket is literally the bars this number holds inside the frame. |
| `zone.confirmation.highVolumeRelative` (1.2) | **in.** Continuous, and the other half of the entry rule that produced the pending bars. |
| `zone.confirmation.barsWithoutVolume` (2) | **out.** A loop bound. 1.6 rounds to the same behaviour as 2 and 2.4 to the same as 3, so +-20% is one inert point and one point that is a different rule, not a smaller one. |
| `structure.pivotWindow` (3) | **out.** A half-window index. At 2.4 the `offset === window` self-exclusion never matches and the detector returns no pivots at all — that is a broken engine, not a sensitivity reading. |
| `zone.narrowRange.minimumAtrWidth` (1) | **out.** B measures it: it decides `atr_band` mode, which is 1.5% of the lost bars. |
| `zone.anchor.lookbackBars` (120), `anchor.untestedReanchorBars` (60) | **out.** B measures them: the median lost bar sits on a frame 5 bars old that was touched 3 bars ago, so a staleness bound is not what is binding. |
| everything in `MARKET_SIGNAL_GATE`, `MARKET_SIGNAL_THRESHOLDS` | **out.** B shows the gate never runs on this path. |

| variant | knob | from | to | agreement | flip ratio | labels changed of 72805 |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | — | — | — | 71.2% | 1.17 | — |
| trigger-hi | `zone.triggerAtrMultiple` | 0.25 | 0.3 | 71.3% | 1.16 | 326 (0.4%) |
| trigger-lo | `zone.triggerAtrMultiple` | 0.25 | 0.2 | 71.1% | 1.19 | 338 (0.5%) |
| volconf-hi | `zone.confirmation.highVolumeRelative` | 1.2 | 1.44 | 71.4% | 1.14 | 697 (1.0%) |
| volconf-lo | `zone.confirmation.highVolumeRelative` | 1.2 | 0.96 | 71.0% | 1.22 | 972 (1.3%) |

Label churn is not the question B asked, though. B asked how many MOVES the zone rule
swallows, so this is how many of those exact 11330 bars each knob gives back — and,
beside it, how many moves the SAME knob takes away somewhere else, because a knob that
trades one for the other has moved bars around rather than fixed anything:

| variant | recovers (of 11330 lost) | surrenders (moves the baseline named) | net |
| --- | --- | --- | --- |
| trigger-hi | 0 (0.0%) | 137 | -137 |
| trigger-lo | 138 (1.2%) | 1 | +137 |
| volconf-hi | 4 (0.0%) | 271 | -267 |
| volconf-lo | 428 (3.8%) | 0 | +428 |

The confusion matrix for each, ground truth down the side and label across the top:

**baseline · engine GATE+ZONES ON, config as it ships**

| truth \ label | UP | DOWN | SIDEWAYS | row total | row correct |
| --- | --- | --- | --- | --- | --- |
| **UP** | 5985 | 2 | 6970 | 12957 | 46.2% |
| **DOWN** | 8 | 2816 | 4360 | 7184 | 39.2% |
| **SIDEWAYS** | 3696 | 3107 | 36024 | 42827 | 84.1% |

n 62968 · clustered 3579 · SQUEEZE/OVEREXTENDED (outside the 3x3) 9837 · ground-truth changes 8603 · label changes 10101

**trigger-hi · `zone.triggerAtrMultiple` 0.25 -> 0.3**

| truth \ label | UP | DOWN | SIDEWAYS | row total | row correct |
| --- | --- | --- | --- | --- | --- |
| **UP** | 5891 | 2 | 7064 | 12957 | 45.5% |
| **DOWN** | 5 | 2773 | 4406 | 7184 | 38.6% |
| **SIDEWAYS** | 3593 | 3026 | 36208 | 42827 | 84.5% |

n 62968 · clustered 3579 · SQUEEZE/OVEREXTENDED (outside the 3x3) 9837 · ground-truth changes 8603 · label changes 9938

**trigger-lo · `zone.triggerAtrMultiple` 0.25 -> 0.2**

| truth \ label | UP | DOWN | SIDEWAYS | row total | row correct |
| --- | --- | --- | --- | --- | --- |
| **UP** | 6072 | 2 | 6883 | 12957 | 46.9% |
| **DOWN** | 8 | 2866 | 4310 | 7184 | 39.9% |
| **SIDEWAYS** | 3805 | 3193 | 35829 | 42827 | 83.7% |

n 62968 · clustered 3579 · SQUEEZE/OVEREXTENDED (outside the 3x3) 9837 · ground-truth changes 8603 · label changes 10252

**volconf-hi · `zone.confirmation.highVolumeRelative` 1.2 -> 1.44**

| truth \ label | UP | DOWN | SIDEWAYS | row total | row correct |
| --- | --- | --- | --- | --- | --- |
| **UP** | 5821 | 2 | 7134 | 12957 | 44.9% |
| **DOWN** | 7 | 2713 | 4464 | 7184 | 37.8% |
| **SIDEWAYS** | 3514 | 2882 | 36431 | 42827 | 85.1% |

n 62968 · clustered 3579 · SQUEEZE/OVEREXTENDED (outside the 3x3) 9837 · ground-truth changes 8603 · label changes 9838

**volconf-lo · `zone.confirmation.highVolumeRelative` 1.2 -> 0.96**

| truth \ label | UP | DOWN | SIDEWAYS | row total | row correct |
| --- | --- | --- | --- | --- | --- |
| **UP** | 6277 | 2 | 6678 | 12957 | 48.4% |
| **DOWN** | 9 | 2952 | 4223 | 7184 | 41.1% |
| **SIDEWAYS** | 3990 | 3350 | 35487 | 42827 | 82.9% |

n 62968 · clustered 3579 · SQUEEZE/OVEREXTENDED (outside the 3x3) 9837 · ground-truth changes 8603 · label changes 10479

## The one line

Every number in this sentence is from a table above it.

> **ต้นเหตุหลักคือบรรทัด `zone === 'sideways'` ใน `zonePresentationState` —
> 100.0% ของ 11330 แท่งที่ ground truth บอกว่าเป็นเทรนด์แต่ engine ON ตอบ SIDEWAYS
> มาจากบรรทัดนี้บรรทัดเดียว และมันตัดจบก่อนที่ band, conflicts, regime หรือ score
> จะถูกอ่าน (band==neutral จริงแค่ 4.7% · conflicts 17.9% · regime/fallback 5.2%
> — ทั้งหมดเป็นผู้โดยสาร ไม่ใช่สาเหตุ) โดยที่ engine OFF เรียกทิศถูกบน 95.3% ของแท่งเดียวกัน
> และกรอบโซนก็ไม่ได้เก่าหรือกว้างเพราะถูกทิ้ง — มัน re-anchor ใหม่ทุก 5 แท่ง (มัธยฐาน)
> ตาม pivot ที่เทรนด์สร้างขึ้นเอง จึงวาดขอบหนีราคาไปเรื่อย ๆ และราคาไม่เคยปิดทะลุมัน**

**และมันไม่ใช่ค่า threshold ตัวไหน**: knob ที่ B ชี้ ขยับ +-20% ทั้งสองตัว กู้แท่งที่หายไปคืนได้
มากที่สุด 428 จาก 11330 แท่ง (3.8%, `zone.confirmation.highVolumeRelative`)
— โครงสร้างของกฎเป็นตัวกำหนด ไม่ใช่ตัวเลขในกฎ

ฝั่ง OFF เป็นภาพกลับด้านของกฎเดียวกัน: ทางเดียวที่จะพูดว่า SIDEWAYS ได้คือ
`regime.sideways || nonTrendingFallback` (100.0% ของแท่งที่ OFF เงียบ) ซึ่งต้องการหลักฐาน
4 ใน 5 อย่างพร้อมกัน — แทบไม่มีอะไรผ่าน OFF จึงพูดทิศบน 82.7% ของแท่งที่เงียบจริง
**ทั้งสองสถานะจึงพังด้วยเหตุเดียวกัน: แต่ละสถานะมีทางไปสู่คำตอบเดียวเท่านั้น และไม่มี
ทางที่สาม.**

---

```
shards            4 base + 4 off-side + 16 variant files under .qa/trend-diagnosis/
agreement join    72805 rows read from .qa/trend-agreement/ (OFF labels only)
reproduce         npm run signal:trend-diagnosis -- --cases                         (A)
                  npm run signal:trend-diagnosis -- --shard=0/4                     (B, 0..3)
                  npm run signal:trend-diagnosis -- --shard=0/4 --offside           (B mirror)
                  npm run signal:trend-diagnosis -- --shard=0/4 --variant=trigger-lo
                      --set=zone.triggerAtrMultiple=0.2                             (C)
                  npm run signal:trend-diagnosis                                    (report)
```

