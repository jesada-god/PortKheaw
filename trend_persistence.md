# Two rules changed, measured against criteria written before the run

`trend_diagnosis.md` proved where the label was being lost. This file is what was
done about it and what it cost, over the same pinned corpus, the same frozen bars and
the same ground truth. The pass criteria below were fixed before any run and are not
edited afterwards; one of them is reported as a miss inside a criterion that passes.

```
corpus            108 instruments — pinned to 20260818T113633Z
period            2023-04-09 .. 2026-07-27
measured by       npm run signal:trend-agreement   (UNCHANGED — no edit to the probe,
                  the ground truth, or the 27-point grid)
before            .qa/baseline-agreement/trend_agreement-baseline.md  (commit 45aeb84)
after             trend_agreement.md
engine cost       92ms -> 306ms per call on the 1255-bar SPY capture (3.3x, measured)
```

## What changed

```
 src/config/signal.ts                            +110   two new blocks, no threshold moved
 src/lib/analytics/market-signal/calculations.ts +237   the two rules
 src/lib/analytics/market-signal/types.ts         +84   persistence block, raw age
 src/lib/analytics/market-signal/history.ts       +39   the age the card is allowed to show
 src/components/.../MarketSignalSection.tsx       +46   one new sentence, raw age only
 docs/signal-handover.md                          +49   §5 rewritten to match
 supabase/migrations/202608210001_..._raw_state.sql     new, NOT applied
 src/lib/analytics/market-signal/range-direction.test.ts   new
 src/lib/analytics/market-signal/persistence.test.ts       new
```

### A — `zone === 'sideways'` stopped erasing the direction

```diff
 export function zonePresentationState(input: {
   zone; regime; score; scoreBreakdown; adx; relativeVolume;
+  /** P7. Absent -> a sideways zone erases the direction, exactly as before. */
+  gate?: { band; conflicts; previousDirection } | null;
 }): MarketSignalState {
   if (regime.squeeze) return 'SQUEEZE';
   if (regime.overextended) return 'OVEREXTENDED';
-  if (zone === 'sideways') return 'SIDEWAYS';
+  if (zone === 'sideways') {
+    const spoken = gate ? rangeDirection({ ...gate, score }) : null;
+    if (spoken === null) return 'SIDEWAYS';
+    // never STRONG_*: price inside its own frame has no structural confirmation
+    return spoken === 'bullish' ? 'BULLISH' : 'BEARISH';
+  }
   ...
```

`rangeDirection` reuses the bands `MARKET_SIGNAL_GATE` already defines — **no threshold
in `signal.ts` was moved, and the new block holds no number of its own**, only the name
of a band:

```ts
export const MARKET_SIGNAL_RANGE_DIRECTION = {
  minimumBand: 'strong',      // to START naming a direction from inside a frame
  retentionBand: 'moderate',  // to KEEP one the previous bar already named
} as const;
```

Conflicts keep their veto on this path and only on this path: outside the frame price
has actually reached somewhere, and §5 already says a conflict may not erase that.
Inside it the evidence is the only witness, and evidence pointing two ways is not one.

### B — a changed label has to stand for two bars

```ts
export const MARKET_SIGNAL_PERSISTENCE = {
  minDurationBars: 2,
  lookbackBars: 2,
  exceptionAtrMultiple: 2,
} as const;
```

The engine has no memory and does not acquire one: it obtains the previous bars' labels
by calling itself on `finalized.slice(0, -k)`. `context.replayDepth` stops the recursion
being a tree, so the whole mechanism is `lookbackBars` extra evaluations at the top call
and nothing below it. It remains a pure function of the candles in front of it.

```ts
const heldState = (() => {
  if (isReplay || exemption !== null) return state;
  for (let offset = 0; offset + required - 1 < rawSequence.length; offset += 1) {
    let run = 1;
    while (run < required && rawSequence[offset + run] === rawSequence[offset]) run += 1;
    if (run >= required) return rawSequence[offset];
  }
  return state;
})();
```

`exemption` releases the hold on a gap or a true range at or beyond `2 x ATR14` of the
**previous** bar, so a violent bar cannot widen the yardstick it is judged by.

**Nothing downstream reads the held label.** `score`, `evidenceAgreement`,
`confidenceBreakdown`, `regimeClarity`, `reasons`, `flags` and `gate` are all computed
from the raw reading and none is recomputed after the hold. §6.8 forbids label age
feeding a threshold; this is that rule read forwards, so a held label cannot raise its
own confidence.

### ★ Two ages, and the card only gets one

The hold makes every published run at least as long as the reading under it, so
`currentLabelDays` now carries the engine's own influence. §6.8 measured that an older
label is not a more accurate one (49.2% against 49.9% at the extremes). So:

| field | counts | who reads it |
| --- | --- | --- |
| `persistence.rawState` | the reading before the hold | `snapshotOf` -> the history row |
| `history.currentLabelDays` | the run of the PUBLISHED label | nobody on the card |
| `history.currentRawLabelDays` | the run of `rawState` | **the card, and only this** |

`currentRawLabelDays` returns `null` rather than guessing when the run reaches a day
that recorded no raw reading — including every row written before P8, which cannot be
backfilled for the same reason the table exists at all. The card then shows no age.
`MarketSignalSection.test.tsx` fails if anyone swaps the number back.

## Choosing A's condition — measured, not preferred

Three conditions were named. Two were run end to end over the full corpus; the third is
excluded by an argument, not by a guess, and is marked as such.

| condition | ON agreement | UP row | DOWN row | SIDEWAYS row | ON flip |
| --- | --- | --- | --- | --- | --- |
| baseline (no change) | 71.2% | 46.2% | 39.2% | 84.1% | 1.17 |
| `minimumBand: 'strong'` (>= 70) | **73.0%** | 55.2% | 46.7% | **82.7%** | 1.30 |
| `minimumBand: 'moderate'` (>= 40) | 68.6% | 84.0% | 76.4% | **62.6%** | 1.67 |
| `minimumBand: 'weak'` (>= 15) | not run — see below | | | | |

`moderate` recovers direction spectacularly and fails two criteria doing it: the
SIDEWAYS row falls to 62.6%, under the 70% floor, and agreement falls below baseline.
`weak` is strictly more permissive than `moderate` — lowering the required band can only
enlarge the set of bars that receive a direction — so its SIDEWAYS row cannot exceed
62.6% and it fails the same floor by construction. It was not run and is not claimed to
have been.

**`strong` was selected.** It was the only measured condition that raised agreement and
both direction rows while keeping the SIDEWAYS row above the floor.

## Before and after — four numbers, two flag states

| | agreement | UP<->DOWN | flip ratio | \|flip - 1.0\| | label changes |
| --- | --- | --- | --- | --- | --- |
| **OFF** before | 42.8% | 0.2% | 1.63 | 0.63 | 13994 |
| **OFF** after | 42.3% | 0.2% | **1.06** | **0.06** | 9121 |
| **ON** before | 71.2% | 0.0% | 1.17 | 0.17 | 10101 |
| **ON** after | **72.5%** | 0.0% | **1.03** | **0.03** | 8879 |

Ground-truth changes are 8603 in every row, before and after — the thing being described
did not move, only the describing did.

## Confusion 3x3, both states

**engine · flags OFF — before**

| truth \ label | UP | DOWN | SIDEWAYS | row total | row correct |
| --- | --- | --- | --- | --- | --- |
| **UP** | 12808 | 42 | 107 | 12957 | 98.9% |
| **DOWN** | 67 | 6740 | 377 | 7184 | 93.8% |
| **SIDEWAYS** | 21307 | 14112 | 7408 | 42827 | 17.3% |

**engine · flags OFF — after**

| truth \ label | UP | DOWN | SIDEWAYS | row total | row correct |
| --- | --- | --- | --- | --- | --- |
| **UP** | 12822 | 27 | 125 | 12974 | 98.8% |
| **DOWN** | 76 | 6752 | 369 | 7197 | 93.8% |
| **SIDEWAYS** | 21512 | 14168 | 7021 | 42701 | 16.4% |

**engine · GATE+ZONES ON — before**

| truth \ label | UP | DOWN | SIDEWAYS | row total | row correct |
| --- | --- | --- | --- | --- | --- |
| **UP** | 5985 | 2 | 6970 | 12957 | 46.2% |
| **DOWN** | 8 | 2816 | 4360 | 7184 | 39.2% |
| **SIDEWAYS** | 3696 | 3107 | 36024 | 42827 | 84.1% |

**engine · GATE+ZONES ON — after**

| truth \ label | UP | DOWN | SIDEWAYS | row total | row correct |
| --- | --- | --- | --- | --- | --- |
| **UP** | 7262 | 2 | 5660 | 12924 | **56.2%** |
| **DOWN** | 6 | 3426 | 3756 | 7188 | **47.7%** |
| **SIDEWAYS** | 4302 | 3591 | 35005 | 42898 | 81.6% |

The row totals move by a few dozen bars between runs because the hold rule changes which
bars land in the SQUEEZE/OVEREXTENDED bucket, which is excluded from the 3x3 by the
probe's own frozen mapping. It is not a change of corpus.

## VERDICT — one line per criterion

| # | criterion (written before the run) | before | after | verdict |
| --- | --- | --- | --- | --- |
| 1 | ON: agreement increases | 71.2% | 72.5% | **PASS** |
| 1 | ON: UP row increases | 46.2% | 56.2% | **PASS** |
| 1 | ON: DOWN row increases | 39.2% | 47.7% | **PASS** |
| 2 | ON: SIDEWAYS row not below 70% | 84.1% | 81.6% | **PASS** |
| 3 | OFF: UP<->DOWN at most 0.5% | 0.2% | 0.2% | **PASS** |
| 3 | ON: UP<->DOWN at most 0.5% | 0.0% | 0.0% | **PASS** |
| 4 | OFF: \|flip - 1.0\| decreases | 0.63 | 0.06 | **PASS** |
| 4 | ON: \|flip - 1.0\| decreases | 0.17 | 0.03 | **PASS** |
| 5 | 27-point grid: at most 3 verdict flips | — | **0** | **PASS** |

**All five pass. Nothing was reverted.**

### What passed but should be read anyway

**OFF agreement fell 0.5pp (42.8% -> 42.3%) and its SIDEWAYS row fell 0.9pp (17.3% ->
16.4%).** No criterion covers OFF agreement — criterion 1 is scoped to ON, because A
cannot reach the flags-OFF path at all — so this is not a failure by the rule that was
written. It is still a real cost and it belongs to B: holding a label for two bars makes
the flags-OFF engine slightly later to arrive at a word it was already getting right
98.8% of the time on UP. The trade bought the OFF flip ratio going from 1.63 to 1.06,
which is the number `trend_agreement.md` §4 found above 1.0 at all 27 grid points.

**The verdict is still FAIL at every grid point, both states.** The probe's pass rule
requires beating the better baseline on agreement AND on flip ratio, and B1/B2 sit at
0.38 and 0.33 — below 1.0, which appendix §5 of `trend_agreement.md` already explained
is what a two-state labeller looks like rather than what a good one looks like. This
round moved both engines from "speaks far too often" to "speaks about as often as the
thing it describes" (1.06 and 1.03). It did not make the comparator meaningful, and
nothing here should be read as having passed that verdict.

**A did not fire on any of the ten golden captures.** In `__golden__/preview/gate-zones`
the five symbols in a sideways frame carry scores of 48-54, under the 70 the `strong`
band needs. The rule is conservative by construction and its effect is visible over 108
instruments and 72,805 bars, not on ten last-bars.

## Payload proof

`persistence` is the only key added. Stripping it from the regenerated flags-OFF golden
and comparing against the pre-change files, byte for byte:

```
signal/IREN: identical after stripping [persistence]
signal/SPY: identical after stripping [persistence]
signal/QQQ: identical after stripping [persistence]
signal/DIA: identical after stripping [persistence]
signal/IWM: identical after stripping [persistence]
signal/REMX: identical after stripping [persistence]
signal/GC-F: identical after stripping [persistence]
signal/SI-F: identical after stripping [persistence]
signal/CL-F: identical after stripping [persistence]
signal/BTC-USD: identical after stripping [persistence]

PROOF: every pre-existing value is byte-identical.
```

Not one existing value moved on the shipping baseline — state, score, confidence,
metrics, zones and reasons are all unchanged on all ten. No field was removed and no
type was changed anywhere; `rawState` on the history entry and `raw_state` on the table
are both nullable, and the migration never backfills them.

```
npm run snapshot:signal -- --check   GATE PASSED · 10 symbol(s) byte-identical
npx tsc --noEmit                     clean
npx eslint src scripts eslint-rules  clean
npx vitest run                       539 files · 6114 tests · all passed
```

The one new sentence on the card — for the reading that was previously impossible, a
direction while the frame still says price has not left it — is 34 words in both
directions, passes `market-signal/no-unsourced-frame-word`, and contains none of
สวิง / ไดเวอร์เจนซ์ / เทรนด์ / โมเมนตัม or the rest of the card's ban list. Three tests
hold it there.

## Reproduce

```
npm run signal:trend-agreement -- --shard=0/4   (0..3, in parallel)
npm run signal:trend-agreement
```
