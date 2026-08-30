# `SIGNAL_HISTORY` — what turning it on would actually do

**A proposal. The flag has not been enabled.**

`มีอะไรเปลี่ยน` defines six detectors. One of them, `trend-change`, reads
`signal.history`, which is only populated when `SIGNAL_HISTORY` is on. With the
flag off that detector can never fire, so the section ships with **five working
detectors out of six**.

The obvious conclusion — "turn the flag on and get the sixth back" — is not
right, for two separate reasons. Both are below.

---

## 1. What enabling it changes

### Tables written

`public.market_signal_history`, upserted on `(symbol, as_of)` by
[`writeSignalSnapshot`](../src/lib/analytics/market-signal/history-repository.ts).
One row per symbol per day; opening the same symbol six times in an afternoon
writes one row, and the last read of the day wins.

Nothing else. `label_history` is a different table with a different writer
(`MARKET_STATUS_CARD` — see [phase2-rollout.md](phase2-rollout.md)).

### Migrations

**None pending.** All three are already applied:

- `202608180001_market_signal_history.sql` — the table
- `202608210001_market_signal_history_raw_state.sql` — the `raw_state` column
- `202608290002_label_history.sql` — unrelated, listed only because it is
  adjacent and easy to confuse

Verified against dev: the table exists and holds **0 rows**.

Retention exists as a manual function that refuses a window under 30 days and
counts before it deletes. It is **not scheduled**, which is correct — but it
means the table grows without bound until somebody runs it.

### Provider calls

**Zero added.** `attachHistory` does one `select` and one `upsert` and touches
no market-data provider. The reading it records was already computed.

### Database round trips — the real cost

One `select` + one `upsert` **per symbol, per signal computation**. That is not
free where the engine runs per-symbol in a loop:

| Surface | Symbols | Extra round trips per render |
|---|---|---|
| Stock detail | 1 | 2 |
| Overview preview (`WATCHLIST_V2`) | ≤5 | ≤10 |
| Watchlist page | N | 2N |

Both calls go through `createAdminClient()`, so they need the service-role key
and no-op without it — history silently stays empty rather than erroring, which
is worth knowing when the first check after enabling shows zero rows.

---

## 2. Will the detector work on gappy data?

**Partly. It is safe, but it is not correct in one case, and for most readers it
will not fire at all.**

Rows exist only for days somebody **with the entitlement** opened that symbol.
`previousTrendLevelOf` takes the newest entry and the newest entry older than
it, within a 30-day window. Behaviour is pinned in
[`src/lib/watchlist/previous-trend-level.test.ts`](../src/lib/watchlist/previous-trend-level.test.ts).

### What holds up

- **Warm-up is silent.** Day one has a single entry, so the detector says
  nothing rather than announcing a change against nothing.
- **No repeated announcements.** After a change is reported, the next visit has
  two newest entries that agree, so it goes quiet. This was the first failure
  mode to suspect and it is not present.
- **Round trips are invisible.** good → bad → good between two visits reads as
  no change, which is correct: nothing changed between the two readings the
  product actually *published*.
- **Bounded.** The 30-day read window caps how stale a comparison can be.

### ⚠️ Problem A — a stale comparison is presented as today's news

Two entries 28 days apart produce
`แนวโน้มเปลี่ยนจาก…เป็น…` with nothing marking the distance, inside a section a
reader reads as a statement about **today**.

The sentence is not false — those genuinely are the last two things the card
said — but it is the kind of true-but-misread claim `what-changed.ts` was
written to avoid, and the module's own comment concedes the gap: *"the sentence
the detector writes makes no claim about when, precisely because this cannot
support one."* A sentence that cannot support a "when" should not appear in a
section whose entire premise is a "when".

**Fix (small, ~10 lines):** bound the comparison by recency in
`previousTrendLevelOf` — return `null` when the previous entry is more than N
trading days old. N=3 keeps a Friday→Monday comparison working across a weekend
and a public holiday, and drops the four-week one. The detector then stays
silent, which is its documented behaviour for "cannot compare honestly".

The alternative — putting the date in the sentence — is worse here: it makes
every row longer to fix a case that should simply not be reported.

### ⚠️ Problem B — most readers still get five detectors

This is the bigger one, and it is not fixable by a flag.

`loadEntitledMarketSignal` returns `null` **without running the engine** for a
reader who has not bought the Technical Outlook (Elite for equities, Pro for the
three commodity contracts). No engine run means no history row written, and
`previousTrendLevelOf(null)` is `null`.

So after enabling `SIGNAL_HISTORY`:

- **Entitled readers** accumulate history and eventually get six detectors.
- **Everyone else** writes no history, reads no history, and keeps five —
  permanently, with the flag on.

"Five of six detectors work" is therefore not a bug that this flag closes. It is
the current state for unentitled readers under **any** flag setting, and the
honest framing is that `trend-change` is an entitled-tier feature rather than a
broken one.

### Density, if you want it dense

History is written by *readers*, so a symbol nobody opens has no history and a
symbol opened daily has a dense one. Making it uniformly dense would need a
scheduled writer running the engine per symbol — which **would** cost provider
calls (five years of candles per symbol), unlike everything else in this
document. That is a different proposal and should not ride along with this flag.

---

## 3. Recommendation

**Do not enable `SIGNAL_HISTORY` to fix the detector count.** It does not fix it
for unentitled readers, and it introduces the stale-comparison sentence for the
readers it does affect.

Suggested order, if it is wanted for the history strip on Stock Detail — which
is its actual purpose and is unaffected by any of the above:

1. **Land the recency bound** in `previousTrendLevelOf` first. Small, testable,
   and it makes `trend-change` correct before it can ever fire in production.
   The `DEFECT:` test flips to `toBeNull()` and loses its prefix.
2. **Decide the retention posture.** The sweep function exists and nothing calls
   it. Either schedule it or write down that unbounded growth is accepted.
3. **Then enable the flag**, on the understanding that it is for the history
   strip, and that `trend-change` becoming live for entitled readers is a
   secondary effect rather than the goal.
4. **Re-check the round-trip cost** on the watchlist page once it is on — 2N
   extra queries per render is the number to watch, and the watchlist is the
   surface where N is largest.

Do not batch step 3 with any of the six Phase 2 flags. It writes to a table on
every render, which none of those do.
