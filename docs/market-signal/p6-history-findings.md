# P6 step 0 — does a label that has stood for longer say more?

`npm run signal:history` · `scripts/signal-history-probe.ts` · the same replay as
P4a: 108 instruments from run `20260818T092020Z`'s manifest, 14,154 observations,
3,629 of them directional, stride 5 bars, horizons 5/10/20.

**Answer: no.** Not one age bucket beats the base rate by more than its own
sampling error, and the buckets old enough to be interesting barely exist.

**Consequence, which is binding on the UI:** P6 ships as a disclosure. The strip
may show what the card said and when it changed. Nothing may present a
long-standing label as a more trustworthy one — no ranking, no colour ramp by
age, no wording that implies endurance is corroboration.

---

## 1. Directional accuracy by how long the label had already stood

```
label age                | hor |  signal      n   clust |    base |    edge |    ±adj | sig?
-------------------------|-----|------------------------|---------|---------|---------|-----
0-5 bars  (just changed) |   5 |   51.3%   3104    3104 |   51.1% |  +0.2pp |  ±2.7pp |   no
0-5 bars  (just changed) |  10 |   50.5%   3104    2147 |   51.3% |  -0.7pp |  ±3.3pp |   no
0-5 bars  (just changed) |  20 |   50.5%   3106    1786 |   51.6% |  -1.1pp |  ±3.6pp |   no
10-15 bars               |   5 |   51.1%    442     442 |   52.4% |  -1.3pp |  ±7.2pp |   no
10-15 bars               |  10 |   55.2%    442     323 |   52.9% |  +2.3pp |  ±8.4pp |   no
10-15 bars               |  20 |   58.8%    442     322 |   53.6% |  +5.2pp |  ±8.3pp |   no
20-30 bars               |   5 |   56.6%     76      76 |   54.1% |  +2.4pp | ±17.2pp |   no
20-30 bars               |  10 |   60.5%     76      53 |   54.9% |  +5.6pp | ±20.3pp |   no
20-30 bars               |  20 |   52.6%     76      47 |   56.1% |  -3.5pp | ±22.1pp |   no
35-60 bars               |   *  | insuff.      4         |         |         |         |
65+ bars                 |   *  | insuff.      0         |         |         |         |
```

The +5.2pp at 10-15 bars is the sort of number a feature gets built on. It sits
inside a ±8.3pp interval, and the split underneath it reads train +3.8pp against
test +7.1pp on 187 and 138 independent observations. The 20-30 bucket is worse
behaved still: train **−15.3pp**, test **+10.5pp** at the same horizon, on 24 and
23 independent observations. That is a bucket with no signal in it and enough
room to produce any headline you would like.

## 2. The finding that decides the UI: directional labels do not get old

```
directional observations                    3629
whose zone changed at this very sample      2169   (59.8%)
that reached 20+ bars of age                  80   ( 2.2%)
that reached 35+ bars of age                   4   ( 0.1%)
that reached 65+ bars of age                   0
```

Three out of five directional readings are on their first sampled day. One in
forty-five lasts a month. So "this label has stood for N days", shown next to an
uptrend or a downtrend, is almost always going to be a small number — and on the
rare occasion it is large, there is no evidence behind it at all, because the
whole corpus produced eighty such observations.

Where the number will actually be large is SIDEWAYS, which is the label that
persists. That is the reading a user is most likely to over-interpret and the
one the harness is most confident carries nothing.

## 3. Sideways, by age — an older frame does not hold price better either

```
label age                | hor | still sideways | inside frame |      n
-------------------------|-----|----------------|--------------|-------
0-5 bars  (just changed) |   5 |          80.0% |        72.5% |   3852
0-5 bars                 |  20 |          74.5% |        49.9% |   3781
10-15 bars               |  20 |          77.3% |        52.5% |   2350
20-30 bars               |  20 |          74.0% |        52.5% |   2004
35-60 bars               |  20 |          74.0% |        55.6% |   1605
65+ bars                 |  20 |          73.1% |        49.2% |    457
```

Between a label one day old and one three months old, the chance price is still
inside the frame twenty bars later moves from 49.9% to 49.2%. A sideways label
that has stood for 65 days is not describing a quieter market than one that
appeared this morning; it is describing an engine that has not changed its mind.

This is the same gap P4a found and the reason P6 was made conditional in the
first place: at twenty bars the LABEL holds about 74% of the time and the FRAME
it named holds about 50%, at every age. The label outlives its own subject, and
age does not fix that — age is the symptom.

## 4. What P6 is therefore allowed to be

Permitted, and worth shipping:

* the 30-day strip, showing what was published and when it changed;
* `label นี้ยืนมา N วัน`, stated as a plain fact beside the three ages already on
  the card (zone, frame, last touch);
* `recent_flip`, as a caution that the reading is unsettled — a warning is a
  different claim from a ranking, and this direction is the safe one;
* gaps drawn as gaps.

Forbidden by this measurement:

* any ordering, scoring, sorting or highlighting by label age;
* colour, weight or size that grows with age;
* copy along the lines of "ยืนมานาน จึงน่าเชื่อถือ", "ยืนยันแล้ว", or any phrasing
  where duration is offered as evidence;
* using age as an input to `evidenceAgreement`, the gate, or any threshold.

## 5. The limit this run cannot get past

The replay samples every fifth bar, so an age is known to within 5 bars and never
better. The `recent_flip` threshold the brief sets is **3 days**, which is finer
than anything measured here — the youngest bucket above is "changed within five
bars". Nothing in this document is evidence about a 3-day threshold specifically.

Three days is therefore a product choice and is written down as one in
`MARKET_SIGNAL_HISTORY.recentFlipDays`. Measuring it properly would mean a
stride-1 replay, which is five times the engine runs for a figure that changes a
caution chip. That is a reasonable thing not to do, as long as nobody later
quotes the 5-bar figures as though they settled the 3-day question.
