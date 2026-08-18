# P4b — the calibration that did not happen

`npm run signal:calibrate -- --like=20260818T092020Z` → run `20260818T113633Z`.

**Outcome: nothing was calibrated, and nothing should be.** No threshold moved,
no mapping was fitted, and `evidenceAgreement` stays what P4.5 made it — a
measure of how well the engine's own evidence agrees with itself, not a
probability.

---

## 1. The re-run reproduced P4a exactly

P4b's premise was "re-run the harness on the engine including whatever passed
P5". Nothing passed P5, so the engine under test is the same one P4a measured
plus P3's actionable layer (which P4a already had) and P4.5's additive fields.
The expectation was therefore that the numbers would not move. They did not
move at all:

```
$ diff <report from 20260818T092020Z> <report from 20260818T113633Z>
6c6
< corpus             108 instruments
---
> corpus             108 instruments — pinned to the list run 20260818T092020Z measured
```

One line, and it is the line naming the pin. Every table, every bucket, every
rate, every clustered count and the window self-check are byte-identical, and
the manifests differ only in `runId`.

That is worth more than a formality. It says the engine's directional behaviour
did not move under P3, P4.5 or P5, and it says the harness is genuinely
deterministic rather than deterministic-looking — the same corpus, the same
seeded control draws and the same pinned `calculatedAt` produce the same
document twice, eight hours and four commits apart.

The `--like` pin is why this comparison means anything. `__golden__/corpus/` is a
cache and it grew by one instrument during P5, when a different probe fetched its
own list. An unpinned re-run would have measured 109 instruments and produced
slightly different numbers everywhere, and the difference would have been read as
the engine moving.

## 2. The headline, unchanged

```
horizon |  signal      n   clust |    base      n |     edge
--------|------------------------|----------------|---------
      5 |   51.4%   3626    3626 |   51.3%  14143 |   +0.0pp
     10 |   51.4%   3626    2510 |   51.6%  14146 |   -0.2pp
     20 |   51.5%   3628    1853 |   51.9%  14148 |   -0.4pp
```

Every gap is well inside its own sampling error — ±2.3pp at 20 bars on 1,853
independent observations. The brief's instruction for this case is explicit, and
it is the right one: **do not calibrate `evidenceAgreement` into a probability.
Report that there is nothing to calibrate.**

## 3. Why a remap would be worse than nothing, concretely

The obvious remap is to fit reported agreement onto measured hit rate, so that
"85" comes to mean "85% of the time this was right". Here is what that mapping
would be fitted to, at a 5-bar horizon:

```
agreement | reported |     hit
----------|----------|--------
    20-29 |   25.2%  |   53.0%
    30-39 |   34.5%  |   47.3%
    40-49 |   44.6%  |   53.4%
    50-59 |   54.5%  |   53.1%
    60-69 |   64.8%  |   45.8%
    70-79 |   75.6%  |   53.8%
    80-89 |   84.6%  |   49.9%
    90-99 |   93.5%  |   53.3%
```

Two things are fatal, and they are different things.

**It is flat.** Hit rate spans 45.8% to 53.8% across the whole range of
agreement, against a base rate of about 51%. A calibrated mapping fitted to this
would map every bucket to roughly the same number, which is a constant wearing a
function's clothes.

**It is not even monotone.** The 60-69 bucket hits 45.8% and the 20-29 bucket
hits 53.0%. Fitting a monotone curve would be fitting away the data; fitting the
actual shape would produce a "probability" that goes DOWN as the evidence agrees
more, between 50-59 and 60-69, and up again after. Either way the output is not a
probability, and printing one would restore in calibrated clothing exactly the
misreading P4.5 removed.

There is nothing here to remap onto. The number is not a bad probability that
needs correcting; it is not a probability.

## 4. What `evidenceAgreement` is left as

What P4.5 made it, unchanged by this run:

* a 0-100 measure of how well the five evidence components agree with each other;
* named `ความสอดคล้องของหลักฐาน`, shown on the card as a WORD;
* the figure itself in the breakdown, beside the terms that produce it, with
  `— ไม่ใช่ % โอกาสที่ราคาจะไปทางนั้น` next to it;
* `confidence` retained as a deprecated alias, because removing a field is not
  additive.

The multiplicative confidence terms in `MARKET_SIGNAL_GATE.confidence` were
described at the close of P1 as "the obvious calibration surface for P4". They
are, and P4b declines to use it: there is no outcome signal to fit those floors
against, so moving them would be moving numbers until an internal measure looked
nicer, which is the definition of the thing this whole phase exists to avoid.

## 5. The caveat that has to travel with any future P4b

**The train half is the half the signal underperformed on.**

```
split | horizon |     edge
------|---------|---------
train |       5 |   -0.8pp
train |      10 |   -1.7pp
train |      20 |   -2.3pp
test  |       5 |   +1.2pp
test  |      10 |   +1.9pp
test  |      20 |   +2.2pp
```

A calibration fitted on train and verified on test would be fitted on the
pessimistic half and verified on the optimistic one, which produces a flattering
verification by construction and not by skill. P5 then found the same sign flip
in four unrelated features, which settles what it is: a property of the two
periods, not of the engine.

So any future fit has to be reported with this split visible, and a fit that
"works" must be shown to work on train as well — otherwise it has discovered
that 2025-2026 was kinder to trend-following than 2023-2025, which is already
known and is not a calibration.

## 6. What would have to be true before a remap is proposed

Not a wish list — a checklist, so the next person does not have to re-derive it:

1. a directional edge outside its own interval at **more than one horizon**;
2. the same sign on both halves of the split;
3. hit rate **monotone** in whatever is being calibrated, or the mapping is not a
   probability;
4. enough independent observations per bucket that the guard (`n >= 30`) is not
   the thing deciding which buckets exist;
5. the remap written down and agreed BEFORE it is implemented, per the brief.

None of the five holds today. The first fails outright.
