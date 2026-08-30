# Phase 2 rollout — the six flags, in the order they are safe to turn on

Every flag here is **default OFF**, and off means *unset*. `featureFlagEnabled`
treats anything that is not the exact string `true` (trimmed, case-insensitive)
as off, and none of the six passes a default argument. `src/config/phase2-flags.test.ts`
asserts both properties against the source, because a default is one token and
would not fail any other test in the repo.

Turning one **off again is the rollback**. Nothing here needs a revert, a
redeploy of old code, or a migration to be undone — an environment variable
change and a redeploy is the whole procedure, which is the reason the flags
exist rather than the branches being merged straight in.

---

## The six

| Flag (env var) | Default | Read in | What it costs when ON |
|---|---|---|---|
| `MARKET_STATUS_CARD` | OFF | [app/page.tsx:351](../app/page.tsx#L351) | **6 provider quotes per render** (SPY, QQQ, DIA, ^VIX, ^TNX, DX-Y.NYB) + one `label_history` read and write |
| `WATCHLIST_V2` | OFF | [app/page.tsx:123](../app/page.tsx#L123), [app/watchlist/page.tsx:38](../app/watchlist/page.tsx#L38) | Nothing extra; on the overview it **reduces** cost by cutting the preview to 5 symbols before prices are fetched |
| `WHAT_CHANGED_CARD` | OFF | [src/lib/watchlist/service.ts:206](../src/lib/watchlist/service.ts#L206) | One daily-bar read per watchlist symbol that has a signal |
| `MARKET_EVENTS_CARD` | OFF | [app/page.tsx:419](../app/page.tsx#L419), [app/market-events/page.tsx:34](../app/market-events/page.tsx#L34) | **Nothing.** The calendar is a static JSON import; the route adds one portfolio row read to count holdings |
| `NEWS_FILTER` | OFF | [app/page.tsx:402](../app/page.tsx#L402) | **No new request.** It changes the parameters of the news request the page already makes (market-wide → personalized) |
| `OVERVIEW_V2` | OFF | [app/page.tsx:422](../app/page.tsx#L422) | **Nothing.** Pure reordering of sections that already render |

All six are defined in [src/config/features.ts](../src/config/features.ts).

### Off means free, not merely hidden

A flag that hides a card while still paying for its data is not a shipping
switch, it is a blindfold. The two flags that gate real spend are guarded by a
ternary, so with the flag off the promise is never constructed — not constructed
and discarded, which would still have been billed.

`WHAT_CHANGED_CARD` is proved **behaviourally** in
[src/lib/watchlist/flag-cost.test.ts](../src/lib/watchlist/flag-cost.test.ts):
the real `loadWatchlistView` runs with every collaborator stubbed and the bar
loader is asserted *not called*. That form survives a refactor that hoists the
work into a shared batch further up the file, which a source scan would not
catch — the guard would still be textually above the call and the reader would
still pay.

---

## Recommended order

The order is by blast radius, cheapest and most reversible first. Each step is
its own deploy; do not batch them, because the whole value of separate flags is
knowing which one caused what.

### 1. `OVERVIEW_V2` — reorders what already renders

Nothing new loads and nothing new is fetched. It is first because if the
sequence reads badly, that is the cheapest possible thing to discover.

**After turning it on, check:** Home renders in the order Market Status → what
changed → watchlist → calendar → upcoming → news; nothing has a blank gap where
a card used to be; the same order on a phone as on a desktop.

**Rollback:** unset, redeploy. No data was written.

### 2. `MARKET_EVENTS_CARD` — the calendar card and its route

Costs nothing at render. It gates the card *and* `/market-events` together, so a
card cannot link to a 404.

**After turning it on, check:** the month grid shows the current month with
events on the right days *in Thai time* — spot-check the December FOMC, which
must appear on **10 December**, not the 9th; `/market-events` returns 200 rather
than a 404; the "ดูทั้งหมด" link and a day cell both land on the feed.

> ⚠️ **The calendar runs out on 31 December 2026.** From 1 January 2027 the card
> shows a coverage note instead of pretending the month is quiet. That is
> correct behaviour, not a bug — but it means somebody has to transcribe the
> 2027 schedules from BLS/BEA/the Fed before then. See
> [PLAN.md](../PLAN.md).

**Rollback:** unset, redeploy. The route 404s again.

### 3. `NEWS_FILTER` — the scope tabs on the overview feed

**After turning it on, check:** four tabs appear (ทั้งหมด / พอร์ต / Watchlist /
ตลาด); switching tabs issues **no** network request (watch the Network panel);
an article with no symbols lands under ตลาด rather than being guessed into a
holding; a signed-out visitor still sees the market-wide feed, because the
server sends empty symbol lists for them.

**Watch for:** the personalized feed fans out to more upstream topic calls than
the market-wide one did. Check the news provider's usage after a day.

**Rollback:** unset, redeploy. The feed returns to market-wide.

### 4. `WATCHLIST_V2` — the rebuilt watchlist

**Requires** `supabase/migrations/202608290003_multi_watchlists.sql` applied to
the target database. The tables are deliberately *not* behind the flag — a
schema that exists conditionally is a schema nobody can reason about — so the
migration goes first and can sit applied indefinitely with the flag off.

**After turning it on, check:** an existing reader lands on their backfilled
default list rather than an empty one; creating a second list works and the
overview preview follows the chosen one; the preview shows at most 5 symbols;
`npm run probe:watchlist-rls` passes against dev (one reader cannot see
another's list).

**Rollback:** unset, redeploy. Lists created while it was on remain in the
database and reappear if it is turned on again — nothing is destroyed, the reader
simply stops being offered a way to make a second one.

### 5. `WHAT_CHANGED_CARD` — the "มีอะไรเปลี่ยน" section

The first flag that costs per-symbol reads. Turn it on *after* `WATCHLIST_V2`,
because the preview cut bounds how many symbols it runs over.

**After turning it on, check:** the section is absent on a quiet day rather than
showing "ไม่มีการเปลี่ยนแปลง"; watchlist page load time has not visibly
regressed; the daily-bar reads are cache hits rather than a second fan-out (see
`what-changed-service.ts`).

**Rollback:** unset, redeploy. Nothing was written.

### 6. `MARKET_STATUS_CARD` — last, because it is the expensive one

Six provider quotes on **every Home render**, plus the only writer of
`label_history` in the codebase.

> This is why `label_history` is empty in production. It is not a broken
> writer — `recordLabel` has exactly one caller,
> `loadMarketStatusWithHistory`, and that only runs when this flag is on.
> Expect the table to stay at zero rows until this step, and treat rows
> appearing here as the confirmation that the step worked.

**Before turning it on:** confirm the provider plan has headroom for six extra
quotes per Home render. This is the one flag that can change the monthly bill.

**After turning it on, check:** the card renders a label rather than
ข้อมูลไม่ครบ; `label_history` starts accumulating one row per evaluation (see
the SQL in
[docs/operations/daily-snapshot-verification.md](operations/daily-snapshot-verification.md),
which includes a `label_history` query); provider usage over the next 24h; the
card's numbers match a public source for SPY and VIX.

**Known duplication:** SPY, QQQ and DIA are then fetched **twice per render** —
once by the market cards through the cached `overview-price:*` pipeline and once
by this card through an uncached `getQuote`. Roughly 3 redundant calls per Home
render. Not merged yet; see [PLAN.md](../PLAN.md) for why.

**Rollback:** unset, redeploy. Rows already in `label_history` stay, which is
harmless — the hold rule reads the most recent run and an older gap does not
corrupt it.

---

## If something looks wrong

1. **Unset the flag and redeploy.** That is the whole rollback for all six.
2. Do not revert the code. The off path is the shipped path and is covered by
   tests; a revert re-opens a merged branch for no gain.
3. Note what you saw before turning it back on — the flags are cheap to toggle,
   which makes it tempting to re-enable before understanding the report.
