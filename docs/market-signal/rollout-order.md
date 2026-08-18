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

Before or with step 5, not after. `docs/market-signal/changelog.md`,
`in-app-notice.md` and `pricing-copy.md` are drafts waiting on your wording. The
pricing strings in `src/lib/subscription/upgrade-copy.ts` currently promise
"ความมั่นใจ" directly above a card that deliberately no longer shows it, and that
is true today with every flag off.

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
