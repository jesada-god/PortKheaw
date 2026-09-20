# Known issues

Open defects that are observed and reproducible enough to record, but not yet
root-caused. Each entry states what was ruled out, so the next person starts
from the end of the last investigation rather than the beginning.

Remove an entry when it is fixed — this file is for live issues only.

---

## `market_instruments.provider` is unreliable on rows written before 2026-09-05

**Status:** open, and **not fixable in place** · **Severity:** low for readers,
material for anybody auditing where data came from · **Observed:** 2026-09-05,
dev project `vhhjdzcjczqmvjrgrrom`

### What was wrong

`scripts/sync-instruments.ts` passed the constant `PRIMARY_INSTRUMENT_PROVIDER`
— `'alpha-vantage'` — to `begin_market_instrument_sync` on every run, whichever
provider had actually answered. The seeding run on the dev project fell back to
Nasdaq Trader and wrote **12,636 rows all stamped `alpha-vantage`**, while the
sync's own log line said:

```
{"event":"instrument_sync_complete","providerUsed":"nasdaq-trader",...}
```

The log told the truth and the table did not.

**Fixed forward** — the script now writes `snapshot.providerUsed`, refuses to
attribute a run when no provider answered, and previews against the whole table
rather than one provider's rows. `src/lib/instruments/sync-attribution.test.ts`
holds all three.

### Why the existing rows cannot be corrected

**There is no record of which provider served which row.** The column is the
only per-row provenance the schema has, every row carries the same wrong value,
and the sync run history records the same constant. Nothing in the database or
the logs distinguishes a row that came from Alpha Vantage from one that came
from Nasdaq Trader.

Rewriting them would mean guessing. A guess that happened to be right would be
indistinguishable from the wrong value it replaced, and a guess that was wrong
would be a second false record laid over the first — with the added harm that
it would look freshly written and therefore trustworthy.

So the rows are left as they are, and this entry is the record that they mean
nothing.

### What to do instead

- **Treat `provider` as unknown on any row whose `last_synced_at` predates the
  next full sync.** It is not missing, it is wrong, and it is wrong in one
  specific direction: it says `alpha-vantage` regardless.
- **A full re-sync fixes it — but only after `202609200002` is applied.** ⚠️
  Read the next section before running one anywhere. The sync writes the
  provider that served it now, and until that migration lands the table is keyed
  on `(provider, provider_symbol)`, so a run that falls back does not replace
  the universe: it inserts a second one beside it.
- **Production has not been touched** and is not part of this fix. Its rows
  carry the same wrong value for the same reason; correcting them is the
  owner's call and needs the same full re-sync, not an UPDATE — again, only
  after `202609200002` is applied.

### ⚠️ Do not re-sync before `202609200002` is applied

This is the part that bites.

`market_instruments` is keyed on `(provider, provider_symbol)`, and every join
and deactivation in `finalize_market_instrument_sync` is scoped
`where i.provider = run_record.provider`. The table is partitioned by vendor:
each provider owns a private copy of the instrument universe.

That was invisible while the sync wrote one constant provider string. It became
visible the moment the sync started telling the truth. On 2026-09-05 the dev
re-sync fell back to Nasdaq Trader and **inserted a second full universe** —
12,636 new rows beside the 12,636 already there, 25,272 total, every symbol
twice, search returning AAPL twice. The duplicates were deleted by hand
afterwards and dev is back to 12,636 rows, all `nasdaq-trader`.

**Production has not forked**, checked 2026-09-20 by read-only probe: 12,506
rows, all `alpha-vantage`, none duplicated. It has simply not been re-synced
since the attribution changed. It will fork on its first fallback run.

`supabase/migrations/202609200002_instrument_identity_without_provider.sql`
fixes the cause: `provider_symbol` alone becomes the key, `provider` becomes an
ordinary column recording who last served the row, and finalize replaces the
whole universe whichever vendor answered. It also collapses any existing
duplicates, keeping the most recently synced row per symbol.

`src/lib/instruments/sync-identity.test.ts` reads the migrations and fails if a
later one re-keys on the vendor or puts the provider scope back into finalize —
which is what the regression would look like: a harmless-reading rewrite of the
finalize body that silently re-forks the table.

### Ruled out

| Idea | Why not |
|---|---|
| Infer the provider from row shape | Both parsers produce the same columns. `name`, `exchange` and `asset_type` are identical for AAPL under either source — checked against production. |
| Infer from `ipo_date` being null | Null on **every** row in both projects, from both providers. Carries no signal. |
| Read it off the sync run history | The run rows were written with the same constant. Same defect, same lie. |

---

## Intermittent React #418 on `/tools/what-if`

**Status:** open · **Severity:** low (recoverable; React re-renders the subtree
on the client) · **Observed:** 2026-08-07, local production build

### Symptom

`Error: Minified React error #418` — a hydration mismatch — thrown as a page
error on `/tools/what-if`. Roughly **1 in 3** full runs of
`npm run qa:tools-simulator-mobile`, always on the first viewport pass
(430×932), which is the pass immediately following sign-in. No visible breakage
follows it: React discards the server markup for that subtree and re-renders.

### Not reproducible on demand

About 54 targeted loads across three hypotheses failed to trigger it even once:

| Hypothesis | Setup | Result |
|---|---|---|
| Slow first paint widens the hydration window | 24 loads, fresh context each (cold cache), CPU throttle 8×, network throttled | no #418 |
| Warm cache / repeat navigation | 18 loads, shared context, CPU throttle 6× | no #418 |
| The `localStorage` draft restore replaces the tree mid-hydration | 12 reloads with a real draft present, CPU throttle 6× | no #418 |

### What is known

- All three `/tools*` routes are **dynamic** (`ƒ`) in the build, so this is not
  the "static route freezes build-time HTML" trap recorded for the earlier
  `/tools` #418 pair (58e7631).
- `SimulatorWorkspace` applies the reader's calendar day and any restored draft
  from a `setTimeout(0)` inside a mount effect (see the comment above that
  effect). A state update landing before hydration commits is the mechanism that
  would produce this error, and that effect is the only candidate on the page —
  but it has not been caught doing so.
- The `today` state added alongside the Target Date work is `''` on both the
  server render and the first client render, and is updated inside that same
  pre-existing effect, so it does not add a new mismatch window. **This does not
  amount to proof that the issue predates that change** — establishing that
  needs several full QA runs against the prior build to compare rates.

### Next step

Reproduce with a development build (unminified React names the mismatching
element and prints a diff) rather than guessing at the minified code. Do not
change the mount effect speculatively: it is covered by
`SimulatorWorkspace.hydration.test.tsx`, which encodes the prerender contract it
exists to satisfy.
