# `expected_move_observations` — what it is and when to open it

**Do not read this table before 12 months of collection.** That is not a
formality; the arithmetic is below and it is the whole reason the table exists in
this shape.

| | |
| --- | --- |
| Table | `public.expected_move_observations` |
| Migration | `supabase/migrations/202608180002_expected_move_collection.sql` — **not yet applied** |
| Written by | `npm run collect:expected-move`, once per trading day, after the US close |
| Read by | **nothing** |
| Flag | none — there is no flag, because there is nothing to switch on |

---

## Why it exists

P5 evaluated four context candidates. Three failed a measurement. The fourth —
options / Expected Move — **could not be given one**: `__golden__/corpus/` is
OHLCV, no provider in this project backfills a historical options chain, and
there is therefore no way to compute what an expected-move band would have said
on 2024-03-15 and no way to score it against what happened next.

An untestable feature does not get built, so nothing was built. But "untestable"
here is a property of the data we happen to hold, not of the idea, and the fix is
boring: start writing down what the market prices, and the question becomes
answerable later.

That is all this is. Four numbers per symbol per trading day.

## What is stored

| Column | What it is |
| --- | --- |
| `spot` | The underlying price the chain was priced against |
| `expiration`, `days_to_expiry` | Which expiry the reading is about |
| `atm_iv` | Implied volatility at the strike nearest spot, call and put averaged |
| `implied_move`, `implied_move_pct` | `spot · iv · √(days/365)`, in price units and as a share of spot |
| `atm_strike` | The strike the IV was read at, so the ATM choice is auditable |
| `provider` | So a later break in the series is attributable rather than mysterious |

**The percentage is the one that survives a corporate action.** An absolute move
recorded before a 4-for-1 split is not comparable with one recorded after it, and
this series is meant to be read years later by somebody who was not here.

**No forward outcome column.** What price did next is already in the candles, and
a second copy here could disagree with the first — and this copy is the one an
analysis would read.

### The one modelling choice, and how to undo it

A chain carries weeklies and monthlies together, so "the front expiry" is one day
out on a Thursday and thirty on the Monday after. A series built that way is not
comparable with itself and no later normalisation repairs it.

So the collector takes **the nearest expiry at least 7 days out**, and stores the
actual `days_to_expiry` beside every row. A later analysis can filter on it,
normalise by it, or discard the rule entirely and use something else. Recording
the input is the collector's job; deciding what it means is not.

## When it can answer something

To conclude anything, a 95% interval has to exclude zero, so its half-width must
be smaller than the edge being looked for. On a rate near 50% that is
`n > 0.96 / d²` **independent** observations.

```
edge to detect | independent observations needed
---------------|--------------------------------
        2.0pp  |   2,401
        1.0pp  |   9,604      <- the bar the P5 criterion actually used
```

Independent means non-overlapping outcome windows: `252 / horizon` per instrument
per year. Of the 108 instruments in the corpus, roughly 85 have options liquid
enough to quote a usable expected move — the three futures contracts, the crypto
pairs and the thinner ETFs drop out. One year of daily collection therefore buys
about:

```
horizon | independent observations per year
--------|----------------------------------
      5 |  ~4,300
     10 |  ~2,100
     20 |  ~1,070
```

Which gives the wait:

```
                        | 5 bars | 10 bars | 20 bars
------------------------|--------|---------|--------
detect a 2pp edge       |  ~7 mo |  ~14 mo |  ~27 mo
detect a 1pp edge (P5)  | ~27 mo |  ~55 mo | ~110 mo
```

**The bottom-right corner is the number that matters.** The P5 criterion requires
an edge to hold at every horizon, so the binding figure is the 20-bar column:
about **three years** before a 2pp effect could be established across all three,
and roughly a decade for the 1pp bar this programme actually used.

### And the sampling arithmetic is not the only constraint

P4a's regime rule applies on top: an effect has to hold with the same sign on
both halves of a time split. A collection window spanning a single market state
cannot satisfy that however many rows it holds. P5 found four unrelated features
flipping sign at the same date, which is what a period difference looks like, so
this is not a hypothetical.

**Practically: the collection needs to span a drawdown as well as a rise before
any result from it is worth acting on.**

## What to do, and when

| When | What |
| --- | --- |
| Now | Apply the migration, schedule the collector daily, forget about it |
| Every run | The script prints how many days remain before the first look. Nothing else needs watching |
| ~12 months | First look, **5-bar horizon only**, and treat it as suggestive |
| ~3 years, spanning both a rise and a drawdown | A verdict at the 2pp level across all three horizons |
| If it fails | Delete the table. The cost was a few kilobytes a day |

## If you found this table and do not know why it is here

It is a deliberate, low-cost bet that a question worth answering will become
answerable. It has no reader, no flag and no UI **on purpose** — that is not an
unfinished feature, it is the finished shape of a collection.

**Do not drop it to tidy up.** The collection cannot be rebuilt: the chains it
came from are not stored anywhere and no provider sells them back. Dropping it
resets the clock in the table above to zero.
