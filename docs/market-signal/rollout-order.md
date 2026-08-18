# Recommended order for turning the flags on

Nothing in this repository turns a flag on. Every one of the five defaults to
off, `signal-flags.test.ts` asserts that, and the flags-OFF payload is held
byte-identical to `__golden__/signal/` by `gate.test.ts`. This file is a
recommendation for whoever sets the environment variables, not a plan that runs.

The ordering principle: **each step should be undoable by unsetting one variable,
and no step should change two things a reader would notice at once.**

---

## 0. Before anything

```
npm run test && npm run typecheck && npm run lint
npm run snapshot:signal -- --check      # flags OFF still matches the baseline
```

The last one is the gate. If it fails, nothing below should be turned on,
because the thing being rolled out is no longer the thing that was measured.

Each step of the rollout also has its own reference, captured per combination:

```
SIGNAL_GATE=true npm run snapshot:signal -- --check
SIGNAL_GATE=true SIGNAL_ZONES=true npm run snapshot:signal -- --check
SIGNAL_GATE=true SIGNAL_ZONES=true SIGNAL_ACTIONABLE=true npm run snapshot:signal -- --check
```

These write to and compare against `__golden__/preview/<combination>/` and are
NOT the pre-deploy gate — the gate is the flags-OFF run, because flags-OFF is
what production is. They answer the question the gate cannot: before turning the
next flag on, is this step still doing what it did when it was measured. Run the
matching one immediately before each step below.

## 0b. The copy — DONE, before step 1

The four items in `prediction-language-audit.md` were approved and applied:
both `upgrade-copy.ts` benefit lines, the card's own locked-preview summary, and
the glossary cross-reference. `technical-outlook-copy.test.ts` and the card's
locked-preview test now fail if any of them drifts back.

This had to happen BEFORE `SIGNAL_GATE`, not after: all four were live with every
flag off, and the locked-preview one sat a few centimetres above the footer
saying the card does not forecast.

What is still outstanding is the owner's:

* **release notes in the database** — not in this repository, so not sweepable
  from here. Check the admin console before step 1.
* the drafts in `changelog.md`, `in-app-notice.md` and `pricing-copy.md`, which
  are wording decisions rather than code.

## 0c. What each step does to the labels, measured before turning anything on

Every combination below was replayed over the cached 109-instrument corpus in
`__golden__/corpus/` at a pinned `calculatedAt`. These are label counts on frozen
bars, not a forecast of production: the corpus is one day's worth of history for
109 liquid instruments, and the live universe is larger and moves. Read them as
the shape of the change, not as the number you will see.

| | all OFF (today) | GATE | GATE+ZONES | +ACTIONABLE |
| --- | --- | --- | --- | --- |
| BULLISH | 72 (66.1%) | 54 (49.5%) | 20 (18.3%) | 20 (18.3%) |
| **SIDEWAYS** | **15 (13.8%)** | **34 (31.2%)** | **80 (73.4%)** | **80 (73.4%)** |
| BEARISH | 15 (13.8%) | 14 (12.8%) | 2 (1.8%) | 2 (1.8%) |
| SQUEEZE | 6 (5.5%) | 6 (5.5%) | 6 (5.5%) | 6 (5.5%) |
| OVEREXTENDED | 1 (0.9%) | 1 (0.9%) | 1 (0.9%) | 1 (0.9%) |

72 of the 109 change label at some point in the rollout.

**Two things to know before step 1.**

`SIGNAL_ZONES` is the bigger change, not `SIGNAL_GATE`. The gate roughly doubles
SIDEWAYS, 13.8% to 31.2%. Zones more than doubles it again, to 73.4% — nearly
three instruments in four. Step 1 is described above as "the largest single
change a reader sees", and by label count that is step 2. Plan the questions
accordingly.

BEARISH nearly disappears at step 2: 15 instruments to 2. Almost every bearish
label is a directional read that zone structure declines to confirm. If that is
not intended, step 2 is where to find out, and it is a reason to sit on step 1
for longer than it feels like it needs.

`SIGNAL_ACTIONABLE` changes no label at all — the two right-hand columns are
identical. It still changes the payload (invalidation and target fields), so the
snapshots differ; it just never renames anything.

Regenerate with the snapshot harness per combination, below.

## 1. `SIGNAL_GATE`

The largest single change a reader sees, and the one everything else assumes.
A directional label now has to survive its own evidence, so instruments that
read BULLISH off a +1 score become SIDEWAYS. Confidence becomes a multiplicative
product, so the numbers fall.

Turn this on alone and leave it alone for a few days. If anything is going to
generate questions, it is this.

**Watch:** the share of instruments reading SIDEWAYS, and whether anybody reports
the card as "broken" — which is what a correct label that contradicts a
familiar one looks like from the outside.

## 2. `SIGNAL_ZONES`

Structure names the label instead of the score, and the zone bar appears. Depends
on nothing, but it is much easier to read a zone-driven label once the gate has
already removed the thin directional ones.

**Watch:** `stale_zone` and `narrow_range` rates. Both are supposed to be
uncommon; either one becoming common means the frame rules are meeting a market
they were not measured on.

## 3. `SIGNAL_ACTIONABLE`

Reads the zone frame and nothing else, so turning it on with `SIGNAL_ZONES` off
changes no byte of the payload. Four instruments in five stay silent, by design —
a level that cannot be derived from traded structure is not published.

**Watch:** how often the invalidation and target rows are actually drawn. If the
silence rate moves a long way from four in five, the anchoring changed.

## 4. The user-facing communication

Before or with step 5, not after. The three drafts above are waiting on your
wording.

## 5. `SIGNAL_HISTORY` — **and the migration first**

This is the only step that touches the database, and it is a stop-and-report:

```
supabase/migrations/202608180001_market_signal_history.sql
```

Read it, then apply it, then set the flag — in that order, on separate days if
you like. The flag with no table logs nothing and shows nothing; it does not
break. Its tests run the migration against a real Postgres, so what is being
applied has been executed before.

After a month, run the retention sweep in reporting mode to see it working long
before it has anything to delete:

```sql
select * from public.sweep_market_signal_history(400);   -- counts, deletes nothing
```

Scheduling it is a separate migration and a separate decision, and there is over
a year before it matters.

## 6. `SIGNAL_CONTEXT` — nothing to turn on

The flag exists and has no code behind it. All four candidates failed the P5
measurement and none was built; see `p5-context-findings.md`. Leave it off, and
if a later corpus makes the volatility-compression result worth re-testing, that
is a new measurement rather than a flag flip.

---

## Rolling back

Unset the variable. Every phase is additive at the payload level — no field was
removed and no field changed type, which `entitled-service.test.ts` asserts — so
a reader who had the flag on and then off sees the card they saw before it, not
a broken one.

The exception is `SIGNAL_HISTORY`, where unsetting the flag stops the recording
but leaves the rows. That is the right way round: the data is the only part that
cannot be recreated afterwards.
