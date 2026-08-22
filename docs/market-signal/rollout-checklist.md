# Rollout checklist

`rollout-order.md` says **what order** to turn the flags on, and why. This file
is the other half: the SQL to run, the variables to set, the queries to watch
afterwards, and the two things a person has to look at.

**Nothing here was executed against a database.** Section 4 is the exception and
is marked as such — it is a local, offline replay, and its output is pasted in
verbatim rather than described.

Read `signal-handover.md` §5 before section 2. The ★ there is not a style
preference; it is a behaviour change that file's veto table records.

---

## 1. Migrations

### Order

Apply in filename order, which is also dependency order. Nothing in this
repository applies them — the SQL editor or your normal pipeline does, as
`supabase/README.md` describes.

| # | File | Needed by | Blocking? |
| --- | --- | --- | --- |
| 1 | `202608190002_earnings_calendar_lkg.sql` | `SIGNAL_GATE` — the gate's earnings rules (`earningsProximity`, `daysToEarnings`) come from `loadEarningsSchedule`, which reads `public.analytics_earnings_calendar_lkg` (`service.ts:36`) | **No, but do it first.** `schedule-repository.ts` is "soft about every failure": with no table the calendar degrades to the live provider and the gate quietly loses its durable earnings input. Skipping it means step 1 runs without the calendar it was measured with. |
| 2 | `202608180001_market_signal_history.sql` | `SIGNAL_HISTORY` — creates `public.market_signal_history` and `public.sweep_market_signal_history()` | **Yes** for that flag. The flag with no table logs nothing and shows nothing; it does not break. |
| 3 | `202608210001_market_signal_history_raw_state.sql` | `SIGNAL_HISTORY` — adds `raw_state`, the pre-hold-rule label P8 needs | **Yes**, and it ALTERs the table from #2, so it cannot go first. Its own header states that neither it nor #2 has been applied. |

The Options Signal migrations (`202608190001`, `202608190003`) are a different
engine and a different decision. They are not part of this rollout.

### Verify each one landed

There is no migrations ledger to trust here, so each check asks the schema
itself. Run all four; every one must return `t`.

```sql
-- 1. earnings LKG table exists
select to_regclass('public.analytics_earnings_calendar_lkg') is not null as ok;

-- 2. history table exists, with its columns and the primary key that makes
--    "one row per symbol per day" true of every row, not just of today's.
select
      to_regclass('public.market_signal_history') is not null
  and (select count(*) = 10 from information_schema.columns
        where table_schema = 'public' and table_name = 'market_signal_history'
          and column_name in ('symbol','as_of','state','bias','zone','score',
                              'evidence_agreement','flags','features','recorded_at'))
  and exists (select 1 from pg_constraint
               where conrelid = 'public.market_signal_history'::regclass
                 and contype  = 'p')
  as ok;

-- 3. the retention function exists
select exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'sweep_market_signal_history'
) as ok;

-- 4. raw_state landed. This is the check that tells migration 3 from migration 2.
select exists (
  select 1 from information_schema.columns
   where table_schema = 'public' and table_name = 'market_signal_history'
     and column_name  = 'raw_state'
) as ok;
```

And the check that matters more than any of them. `market_signal_history` has
RLS on with **no policy**, deliberately — the server applies the
`technical.outlook` entitlement before any of it reaches a reader, and the
comment on the table says so.

```sql
select relrowsecurity as rls_on,
       (select count(*) from pg_policies
         where schemaname = 'public' and tablename = 'market_signal_history') as policies
  from pg_class where oid = 'public.market_signal_history'::regclass;
-- expected: rls_on = t, policies = 0
```

A non-zero `policies` means somebody added a client-facing policy to a
disclosure record. Stop and find out who.

Retention, once there is something to retain — reporting mode deletes nothing:

```sql
select * from public.sweep_market_signal_history(400);
```

---

## 2. Environment variables

Every flag defaults OFF, and OFF is production today. `featureFlagEnabled` is
called with no default in `src/config/signal-flags.ts`, so **an unset variable is
off** — which is exactly why unsetting is the rollback, and why no flag may ever
be deleted after its phase lands.

| Variable | Set to | Phase | What setting it does |
| --- | --- | --- | --- |
| `SIGNAL_GATE` | `true` | P1 | A directional label must survive its own evidence; confidence becomes a product of six terms; earnings rules apply |
| `SIGNAL_ZONES` | `true` | P2 | Structure names the label; the zone bar appears |
| `SIGNAL_ACTIONABLE` | `true` | P3 | Invalidation and target, derived from the zone frame and nothing else |
| `SIGNAL_HISTORY` | `true` | P6 | Writes one row per symbol per day to `market_signal_history`; the 30-day strip appears |
| `SIGNAL_CONTEXT` | **leave unset** | P5 | **There is no code behind it.** All four candidates failed the P5 measurement and none was built. Setting it does nothing today, and a future reader who finds it set will believe a feature is on. |

Restart the server after changing any of them (`supabase/README.md`, step 5).
They are read from `process.env` at call time on the server, so a process that
was already running when the variable changed is still answering with the old
set.

### ★ `SIGNAL_GATE` and `SIGNAL_ZONES` belong together

**This is the one ordering fact that is not a preference.** `signal-handover.md`
§5's veto table records that `conflicts` does two *different* things depending on
whether ZONES is on beside GATE:

| Veto | What it kills | Active when |
| --- | --- | --- |
| `conflicts` (gate) | **the whole direction** → SIDEWAYS | GATE on **and ZONES off** |
| `conflicts` (gate) | **only `STRONG_*`**, demoted to BULLISH/BEARISH | GATE **and** ZONES on together |
| `band == neutral` (\|score\| < 15) | direction → SIDEWAYS | GATE on **and ZONES off** |

So GATE-alone is not "step 2 without the zone bar". It is a **harsher rule that
step 2 then reverses**: an instrument whose evidence conflicts loses its
direction entirely at step 1 and gets it back at step 2. §5 records the reason —
the zone answers "where has price actually got to", which is a fact, and the gate
answers "how well is that supported", which is a quality. The card shows both
rather than letting one delete the other.

**What each wrong order costs:**

* **GATE alone, left to sit.** Every conflicted instrument reads SIDEWAYS for as
  long as it sits there, then flips back to directional when ZONES lands. Two
  visible label changes for readers, and the first is one the product does not
  intend to keep. `__golden__/preview/gate-only/` captures this state and it is a
  legitimate reference — it is a waypoint, not a destination.
* **ZONES before GATE.** Do not. The P7 in-range direction path is written as
  `ZONES and GATE on and zone == sideways`; with GATE off, the gate's `conflicts`
  and `band` are not computed, and the zone path is being asked to read fields
  nothing populated.
* **ACTIONABLE before ZONES.** Harmless and pointless: it reads the zone frame
  and nothing else, so with ZONES off it changes no byte of the payload.
* **`SIGNAL_HISTORY` before its migration.** Logs nothing, shows nothing, does
  not break. The reverse — migration first, flag on a later day — is what
  `rollout-order.md` recommends and is still the safer order.

`rollout-order.md` steps 1 and 2 are written as separate steps with days between
them, and by label count that spacing is defensible: the gate roughly doubles
SIDEWAYS, zones more than doubles it again. **The two readings do not conflict.**
The gap is a deliberate cost, paid to isolate which flag caused what. What must
not happen is drifting into a long GATE-only period by accident — decide the
length of the gap in advance and treat it as a decision, not a pause.

### Recommended amendment: turn `SIGNAL_HISTORY` on FIRST, not fifth

`rollout-order.md` puts it at step 5. **Section 3 below cannot run before it**,
because `market_signal_history` is the only place any of these rates is recorded.

The table was built for exactly this. Its `features jsonb` column exists —
verbatim from the migration — because *"a SIDEWAYS written with the gate off and
a SIDEWAYS written with it on are different statements, and a strip that mixes
them silently shows a label change on the day a flag was flipped."* Turning
history on while everything else is still off records the **flags-OFF baseline in
the same table**, which is what turns every query in section 3 from an "after"
into a before/after.

Cost of doing it first: the 30-day strip appears on the card before any label
change does. That is a visible change with no measurement behind it, and whether
it is acceptable is the owner's call.

**This is a recommendation. `rollout-order.md` is unedited.**

---

## 3. What to watch once a flag is on

All of section 3 reads `public.market_signal_history`, so it needs
`SIGNAL_HISTORY` on and migrations 2 and 3 applied.

### Read this before reading any number below

**The table records visits, not a universe.** Its own header says so: a row is
written when somebody opens the card, there is no trading-calendar column, and no
attempt is made to tell a market holiday from an unvisited symbol. Therefore:

* "share of 108 instruments" is **not answerable from this table.** What is
  answerable is *share of the instruments somebody looked at*, which is biased
  toward whatever readers happened to be interested in that day.
* The full-universe figure comes from replaying `__golden__/corpus/` (109 frozen
  instruments) instead. That is what `rollout-order.md` §0c was built from.

Both are given below. They answer different questions and neither substitutes for
the other.

### 3a. SIDEWAYS share, by flag state

```sql
-- Every distinct flag combination the table has seen, and what each produced.
-- Grouping BY features is the whole point: rows written under different flags
-- are different statements and must never be averaged together.
select
  features->>'gate'       as gate,
  features->>'zones'      as zones,
  features->>'actionable' as actionable,
  count(distinct symbol)                                          as symbols,
  count(*)                                                        as readings,
  count(*) filter (where state = 'SIDEWAYS')                      as sideways,
  round(100.0 * count(*) filter (where state = 'SIDEWAYS')
        / nullif(count(*), 0), 1)                                 as sideways_pct,
  count(*) filter (where state in ('BULLISH', 'STRONG_BULLISH'))  as bullish,
  count(*) filter (where state in ('BEARISH', 'STRONG_BEARISH'))  as bearish
from public.market_signal_history
where as_of >= current_date - 30
group by 1, 2, 3
order by 1, 2, 3;
```

Expected **shape** — not expected numbers — from the corpus replay in
`rollout-order.md` §0c, which is one frozen day over 109 instruments:

| | all OFF | GATE | GATE+ZONES |
| --- | --- | --- | --- |
| SIDEWAYS | 13.8% | 31.2% | **73.4%** |
| BULLISH | 66.1% | 49.5% | 18.3% |
| BEARISH | 13.8% | 12.8% | **1.8%** |

BEARISH falling from 15 instruments to 2 at step 2 is the line to check against
reality. `rollout-order.md` already flags it as the thing to find out about at
step 2 if it was not intended.

The full-universe version is a corpus replay rather than a query.
`__golden__/corpus/` holds the 109 frozen instruments, and
`npm run signal:sensitivity` is the corpus-wide label harness in this repo —
§0c's per-combination table was produced by replaying that corpus at each flag
combination, so reproducing it means running the replay per combination rather
than one command.

### 3b. `stale_zone` and `narrow_range` rates

Both are flags, so both are in the `flags text[]` column. Both are supposed to be
uncommon; either becoming common means the frame rules met a market they were not
measured on.

```sql
select
  as_of,
  count(*)                                                       as readings,
  count(*) filter (where 'stale_zone'   = any(flags))            as stale_zone,
  count(*) filter (where 'narrow_range' = any(flags))            as narrow_range,
  round(100.0 * count(*) filter (where 'stale_zone'   = any(flags))
        / nullif(count(*), 0), 1)                                as stale_pct,
  round(100.0 * count(*) filter (where 'narrow_range' = any(flags))
        / nullif(count(*), 0), 1)                                as narrow_pct
from public.market_signal_history
where as_of >= current_date - 14
  and (features->>'zones')::boolean is true   -- both flags exist only with ZONES on
group by as_of
order by as_of desc;
```

Broken down by day rather than averaged: a rate that is fine on average and 80%
on one day is a market event, and an average hides it.

### 3c. Is the card changing its word more often than the market changes?

Not asked for, and the cheapest query here to add — P8's hold rule exists
precisely to hold this number down. `trend_agreement.md` §1 measured a flip ratio
of 1.63 with every flag off, above 1.0 at all 27 definitions of "move" it tested.

```sql
-- How often the PUBLISHED label differs from the previous one, against how
-- often the RAW reading did. raw_state is why migration 3 exists.
select
  count(*) filter (where state     is distinct from prev_state) as published_flips,
  count(*) filter (where raw_state is distinct from prev_raw)   as raw_flips
from (
  select state, raw_state,
         lag(state)     over (partition by symbol order by as_of) as prev_state,
         lag(raw_state) over (partition by symbol order by as_of) as prev_raw
    from public.market_signal_history
   where as_of >= current_date - 30
) t;
-- published_flips must be materially BELOW raw_flips. Equal means the hold rule
-- is doing nothing and something is bypassing it.
```

### 3d. ACTIONABLE silence rate — **not answerable from the database**

The design target is that roughly **four instruments in five publish nothing**: a
level that cannot be derived from traded structure is not emitted, and `null` is
the honest output.

`market_signal_history` does not store the invalidation or the target. It stores
`symbol`, `as_of`, `state`, `bias`, `zone`, `score`, `evidence_agreement`,
`flags`, `features`, `recorded_at` and `raw_state` — so the silence rate cannot
be computed from it, and any SQL claiming to would be measuring something else.

Measure it offline, over the same corpus P3 was measured on:

```
npm run signal:actionable
```

`scripts/signal-actionable-probe.ts` replays the 108-instrument corpus and prints
the share that gets a figure, split by the reason each refusal happened.

If a time series of this matters, that is a column and a migration, and it should
be decided **before** `SIGNAL_ACTIONABLE` goes on rather than after — a silence
rate is only interesting over time.

---

## 4. Rollback proof — run, with real output

The claim under test: **unsetting the variables restores the v1 payload
byte-for-byte**, not approximately.

Run locally and offline. `snapshot-signal --check` replays the frozen candles in
`__golden__/candles/` at a pinned `calculatedAt`, so it touches no network and no
database. `.env.local` was **not modified** — the variables were passed to the
child process on the command line, which wins over `--env-file-if-exists`.

### Step 1 — flags OFF, the pre-deploy gate

```
$ SIGNAL_GATE=false SIGNAL_ZONES=false SIGNAL_ACTIONABLE=false \
  SIGNAL_CONTEXT=false SIGNAL_HISTORY=false npm run snapshot:signal -- --check

mode: check
signal flags: all OFF
IREN     ok · available · BULLISH · score 16 · conf 62
SPY      ok · available · BULLISH · score 59 · conf 74
QQQ      ok · available · BULLISH · score 54 · conf 70
DIA      ok · available · BULLISH · score 57 · conf 73
IWM      ok · available · BULLISH · score 58 · conf 73
REMX     ok · available · BULLISH · score 4 · conf 62
GC-F     ok · available · BULLISH · score 53 · conf 70
SI-F     ok · available · BULLISH · score 41 · conf 63
CL-F     ok · available · SIDEWAYS · score 7 · conf 69
BTC-USD  ok · available · SQUEEZE · score -12 · conf 74

GATE PASSED · 10 symbol(s) byte-identical
```

### Step 2 — GATE+ZONES on, so step 3 is not comparing two identical runs

```
$ SIGNAL_GATE=true SIGNAL_ZONES=true SIGNAL_ACTIONABLE=false \
  SIGNAL_CONTEXT=false SIGNAL_HISTORY=false npm run snapshot:signal -- --check

mode: check
signal flags: SIGNAL_GATE, SIGNAL_ZONES
comparing against __golden__/preview/gate-zones/
PREVIEW check, not the pre-deploy gate; the gate is the flags-OFF run
IREN     ok · available · BULLISH · score 11 · conf 27
SPY      ok · available · SIDEWAYS · score 54 · conf 38
QQQ      ok · available · SIDEWAYS · score 49 · conf 41
DIA      ok · available · SIDEWAYS · score 52 · conf 37
IWM      ok · available · SIDEWAYS · score 53 · conf 42
REMX     ok · available · SIDEWAYS · score -1 · conf 22
GC-F     ok · available · SIDEWAYS · score 48 · conf 48
SI-F     ok · available · BULLISH · score 36 · conf 51
CL-F     ok · available · SIDEWAYS · score 2 · conf 42
BTC-USD  ok · available · SQUEEZE · score -12 · conf 56

PREVIEW gate-zones PASSED · 10 symbol(s) byte-identical
```

Six of the ten change label and every confidence falls.

### Step 3 — flags OFF again

```
$ SIGNAL_GATE=false SIGNAL_ZONES=false SIGNAL_ACTIONABLE=false \
  SIGNAL_CONTEXT=false SIGNAL_HISTORY=false npm run snapshot:signal -- --check

CL-F     ok · available · SIDEWAYS · score 7 · conf 69
BTC-USD  ok · available · SQUEEZE · score -12 · conf 74

GATE PASSED · 10 symbol(s) byte-identical
```

### File comparison, and proof the three runs wrote nothing

```
$ cmp -s __golden__/signal/SPY.json  __golden__/preview/gate-zones/SPY.json
SPY differs (flag does something)
$ cmp -s __golden__/signal/CL-F.json __golden__/preview/gate-zones/CL-F.json
CL-F differs (flag does something)

$ git status --porcelain __golden__
(no output — three --check runs mutated nothing)
```

### What this proves, and what it does not

**Proves.** Turning GATE+ZONES on and off again returns the engine's output to
byte-identical v1 across all ten snapshot symbols. The rollback is a real
rollback at the payload level, and `--check` is read-only.

**Does not prove.**

* Ten symbols, not 108. The snapshot set is the pinned instrument mix, not the
  corpus.
* `SIGNAL_ACTIONABLE` was off in step 2, so this exercises the GATE+ZONES round
  trip only. `__golden__/preview/gate-zones-actionable/` exists and the same
  three steps can be run against it.
* **`SIGNAL_HISTORY` is not covered and cannot be.** Unsetting it stops the
  recording and **leaves the rows** — which `rollout-order.md` states and is the
  right way round, since the data is the only part that cannot be recreated.
* Nothing here exercises the server. This is `calculateMarketSignal` replayed
  over frozen input, not a request through `entitled-service`.

---

## 5. Things a person has to look at, before the first flag

Neither can be checked by any test in this repository.

### 5a. The card on a real phone

`MarketSignalSection.test.tsx` asserts that no line of the disclosure carries
`truncate`, `line-clamp-*`, `hidden`, a nowrap, or `max-h` + `overflow-hidden`,
and that the not-a-forecast sentence renders as one unbroken string rather than
fragments a clamp could split. **That is the honest limit of jsdom**: there is no
layout engine, so it checks the classes that would cause a collapse, not the
collapse. Recorded as item 5 in `open-work.md`.

Real pixels at 390×844 are `npm run qa:ui-redesign-auth`, which needs a running
server and a signed-in Elite account, and **has never been run against this
card.**

What to look at, in this order — each is a specific way a long Thai sentence can
fail in a narrow column:

1. The two lines at the foot of the card, `signal-short-note` and
   `signal-card-disclaimer`: both fully visible, neither clipped or ellipsised.
2. The dialog's first block, `signal-numbers`: the axis line under the score
   (`ช่วง -100 ถึง +100 · …`) wraps rather than overflowing, and the number stays
   on the same row as its label.
3. **A negative score.** Every symbol in the snapshot set reads positive except
   BTC-USD at −12, and the label was written to read at −45. No screenshot of a
   strongly negative card exists. Pick a symbol reading negative on the day, or
   force one.
4. The zone bar at 320px, the narrowest case its label-placement arithmetic
   handles.
5. `ดูรายละเอียดการคำนวณ`, the longest button label on the card, not wrapping into
   the header.

### 5b. Release notes in the database

Release notes live in the database and are written through
`ReleaseNoteEditor.tsx`, **not in this repository**, so no sweep from here can
reach them. Any existing note describing the Technical Outlook in predictive
terms needs the treatment the four items in `prediction-language-audit.md` got.

Words to search for in the admin console — the same list
`technical-outlook-copy.test.ts` enforces in code:

```
ความมั่นใจ · Confidence · แม่นยำ · ทำนาย · พยากรณ์ · คาดการณ์
```

**The owner has this.** `open-work.md` item 2 records it, and it is the one item
on this checklist that cannot be verified from a terminal.
