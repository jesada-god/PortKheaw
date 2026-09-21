# Phase 2 deploy runbook

Written for the operator running this by hand. Every command here is one you
type; nothing in this file runs itself.

Thirteen commits go to production. Eleven are Phase 2 — the company-profile
snapshot, the translation root-cause fix, the public/authenticated split, the
cache-header default, the cache bound, the settlement idempotency key, the back
buttons — plus the alerts/cron consolidation. Two are from 2026-09-20 and have
never shipped.

---

## 0. What this actually deploys

### Thirteen commits, not forty-one

An earlier reading of this said forty-one, measured against
`origin/feat/phase2-foundation`. **That pointer is stale at 2026-09-03 and has
not moved through nineteen merges since.** Measured against the branch that
reaches production:

```
git rev-list --left-right --count HEAD...origin/main
13    20
```

The twenty on the right are almost all merge commits of this branch's own
earlier rounds; `git merge origin/main` brings in **no file changes at all**
(verified on a throwaway worktree: clean merge, empty diff). The thirteen on
the left are the real payload:

| Commit | |
|---|---|
| `787ab3a` | docs: what dev reports for the two new tables |
| `510aba8` | test: declare the two new Supabase construction sites |
| `ffe0a79` | fix(navigation): back buttons on five dead-end pages |
| `e97116c` | fix(portfolio): one settlement is one key |
| `c03640d` | fix(cache): bound SharedRequestCache |
| `af99150` | fix(market-data): shared cache is opt-in |
| `efca2b5` | feat(auth): public/authenticated split + dock |
| `3faf7a1` | fix(translate): server chooses the text |
| `d6c2c0a` | feat(market-data): company-profile snapshot + cost meter |
| `ea3d958` | test: corpus replay timeouts |
| `a20f387` | feat(alerts): one alert system, one sweep |
| `c40917e` | fix(test): shipped set is tracked files that still exist |
| `5084605` | fix(instruments): an instrument is a symbol, not a symbol-and-a-vendor |

### Production is `main`, not this branch

`origin/HEAD → origin/main`, there is no `.github/workflows`, and `vercel.json`
carries only a cron entry — no `git.deploymentEnabled`, no `ignoreCommand`.
Vercel's default is to treat the Git default branch as the production branch, so
pushing `feat/phase2-foundation` produces a **preview**, and production comes
from `main`.

**Confirm this before step 1**, at Vercel → Project → Settings → Git →
Production Branch. It is a dashboard setting and nothing in this repository can
prove it.

### Four migrations, in two groups, and the grouping is the whole plan

| | Migration | When | Why |
|---|---|---|---|
| **A** | `202609200001_unify_alert_rules.sql` | **with the deploy** | the code does NOT fail open — see below |
| **A** | `202609200002_instrument_identity_without_provider.sql` | **with the deploy** | `5084605` ships the code that assumes it |
| **B** | `202609200003_company_profile_snapshot.sql` | 24h after | fails open, and the wait buys the baseline |
| **B** | `202609200004_company_profile_translation_cache.sql` | 24h after | same |

**Group A is not optional and not deferrable.** `202609200001` replaces
`trigger_price_alert_service` with a ten-argument version;
[`background.ts`](../../src/lib/alerts/background.ts) calls it with ten. Until
the migration runs, production has the nine-argument function, PostgREST answers
`PGRST202`, `/api/cron/alerts` returns 503, and a `failed` row lands in
`alert_evaluation_runs` every fifteen minutes. **No price alert fires for the
whole gap.** `earnings` alerts also cannot be saved — the column CHECK refuses
the condition, though that one degrades politely because `actions.ts` maps the
`23514` to a readable message rather than a retry.
[`phase2-flag-rollout.md`](phase2-flag-rollout.md) says the same thing; this is
not a new discovery, it is a constraint that was written down and must be
honoured by the deploy order.

Group B genuinely does fail open: with those two tables absent,
`CompanyProfileService` and `CompanyProfileTranslationService` fall back to the
provider chain they used before. That is what makes the 24-hour wait safe, and
the wait is what produces a **before** number for §7.

### What is already true

* All four migrations are applied on **dev**. None has touched **production**.
* At `787ab3a`: `tsc --noEmit` clean, `next build` exit 0, full suite
  **619/619 files, 7,595/7,595 tests**.
* `npm run sync:instruments` has **no** scheduler behind it — the only scheduled
  jobs are `/api/cron/daily-snapshot` (Vercel), and `portkheaw-background-notifications`,
  `portkheaw-trial-retention`, `portkheaw-portfolio-purge` (pg_cron). Deploying
  `5084605` does not pull that trigger. Just do not run it by hand before
  `202609200002` is applied.
* No Search Console property exists, so nothing measures what `/industry/*` was
  earning from search before it went behind a session. Accepted knowingly.

---

## 1. Before you open the window — prepare the reversal

Do this **before** step 5. Under an incident is the worst time to be reading a
migration for its rollback recipe.

### The file already exists — you do not assemble it under an incident

```
docs/operations/phase2-rollback-alerts-migration.sql
```

It sits beside this runbook, in the repository, so whoever is reverting has it
whether or not they are the person who wrote it. **Verify it is the file this
runbook describes before you start:**

```bash
wc -l docs/operations/phase2-rollback-alerts-migration.sql   # expect 188
md5sum docs/operations/phase2-rollback-alerts-migration.sql  # expect c61a09111e8f000c925a189709c130e0
```

One transaction, four things: it refuses to run if any reader has created an
`earnings` alert, narrows the condition CHECK back, drops the ten-argument
`trigger_price_alert_service`, and restores the nine-argument one verbatim from
`202608020001` together with its `revoke`/`grant`.

`202609200001` ships a rollback recipe of its own, in a comment at the end of
the file. That recipe is where this came from; it ended with "then re-run the
nine-argument definition from `202608020001`", and the point of the file above
is that the definition is already in it.

**It has been executed** — on 2026-09-21, against dev, which had
`202609200001` applied, so the reversal was doing real work — inside a
transaction that was rolled back:

```bash
npm run db:validate -- docs/operations/phase2-rollback-alerts-migration.sql
#   docs/operations/phase2-rollback-alerts-migration.sql ... executes
#   rolled back - the development database is unchanged.
```

That establishes it runs. It does not establish that production's schema is
identical to dev's, which is the standing caveat on everything `db:validate`
answers.

### What the reversal cannot undo

**`202609200001` drops `overview_alert_rules` and `overview_alert_hits`, and
nothing brings back rows that were in them.** The migration rests on both being
empty, which the 2026-09-20 probe counted — but that was sixteen days before
this deploy. §2 makes re-counting them a STOP condition rather than a note,
because this is the one step in the whole plan that destroys data if the
assumption has gone stale.

For `202609200002` the reversal is two statements, and it is only needed if a
sync has already forked the table:

```sql
alter table public.market_instruments drop constraint if exists market_instruments_provider_symbol_key;
alter table public.market_instruments add constraint market_instruments_provider_symbol_key
  unique (provider, provider_symbol);
-- and re-run finalize_market_instrument_sync from 202607180007.
```

**Never drop a table as part of a rollback.** It is the one irreversible step
anywhere in this runbook.

---

## 2. Time the window against the cron

`/api/cron/alerts` runs every fifteen minutes, driven by pg_cron
(`portkheaw-background-notifications`, `*/15 * * * *`). Steps 3–6 are the gap
where production has the new code and the old function, so the window has to
open **immediately after a run finishes**.

In the production SQL editor:

```sql
select id, started_at, completed_at, status
from public.alert_evaluation_runs
order by started_at desc
limit 3;
```

Wait until the newest row has a `completed_at` and a non-failed `status`, then
start. That leaves roughly fourteen minutes before the next tick — comfortably
more than steps 3–6 need, and if you overrun, the cost is one failed evaluation
row, not a broken database.

**If the newest row is already `failed`, stop.** Something is wrong before you
have changed anything, and deploying on top of it will make the cause
unreadable.

### STOP condition: the two tables `202609200001` drops must be empty

```sql
select count(*) as rules from public.overview_alert_rules;
select count(*) as hits  from public.overview_alert_hits;
```

**Both must be zero. If either is not, stop — do not apply `202609200001`.**

The migration drops both tables and nothing recreates their rows. They were
counted empty on 2026-09-20; anything that arrived since is somebody's alert
configuration, and deleting it to keep a deploy on schedule is not a trade this
runbook gets to make. A non-zero count means going back to decide whether to
migrate those rows into `price_alerts` or to amend the migration — a
conversation, not a command.

---

## 3. Merge and push

```bash
git fetch origin
git rev-list --left-right --count HEAD...origin/main     # expect "13  20"
git status --porcelain                                    # expect empty

git switch main
git merge --ff-only origin/main                           # main must match the remote
git merge --no-ff feat/phase2-foundation
git push origin main
```

`--no-ff` matches this project's nineteen previous merges, so the history keeps
reading the same way and the merge commit is the thing you revert in §8.

If `git merge` reports a conflict, **stop and abort** — the probe on
2026-09-21 was clean, so a conflict means something changed since.

---

## 4. Confirm which build is live

```bash
SHA=$(git rev-parse HEAD)          # the merge commit
HOST=https://<production-host>

curl -s "$HOST/api/version" | jq
```

`commitSha` must equal `$SHA`.

**`"unknown"` is a blocker — stop here.** It means neither
`PORTKHEAW_COMMIT_SHA` nor `VERCEL_GIT_COMMIT_SHA` reached the runtime. The site
may be serving fine, but every check below asserts something about "the new
build", and you cannot tell which build answered. Fix the env var and redeploy
before continuing.

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$HOST/api/health"
curl -s "$HOST/api/health" | jq
```

Expect `200`. `status: "degraded"` does not block — the endpoint deliberately
fails only on an unreachable database — but note which of `database` /
`billing` / `scheduler` is degraded and why before going on.

---

## 5. Apply group A, immediately

There is no tool for this and that is deliberate: `npm run db:apply` targets dev
only, and [`db-target.ts`](../../src/lib/dev/db-target.ts) refuses a production
URL, because `supabase/.temp/` on this repository is linked to production and a
bare `supabase db push` would go there silently.

In the **production** SQL editor, in filename order, one run each:

1. `supabase/migrations/202609200001_unify_alert_rules.sql`
2. `supabase/migrations/202609200002_instrument_identity_without_provider.sql`

Both are wrapped in `begin; … commit;`, so each is atomic on its own.

---

## 6. Prove the alert path is alive — before anything else

This is the check the whole window exists for.

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer $CRON_SECRET" "$HOST/api/cron/alerts"
```

Expect **200**.

```sql
select id, started_at, completed_at, status, error
from public.alert_evaluation_runs
order by started_at desc
limit 2;
```

The newest row must be non-failed.

**A 503, or `PGRST202` anywhere in the logs, means group A did not land.** Do
not continue to §7 and do not wait for the next cron tick — either re-apply the
migration or execute the reversal from §1. Every fifteen minutes spent
diagnosing is another evaluation cycle in which no price alert fires.

Also confirm the function arity directly, which is faster than reading logs:

```sql
select p.oid::regprocedure
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'trigger_price_alert_service';
```

Exactly one row, and it must show ten argument types including `integer`.

---

## 7. The rest of the smoke test

### 7a. The two pages that must stay public

```bash
for p in "/stock/AAPL" "/search"; do
  printf '%-14s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "$HOST$p")"
done
```

`200` for both, **with no cookie sent**. A redirect here means the split caught
a page it should not have — §8 rollback trigger.

### 7b. The pages that now require a session

```bash
for p in "/" "/industry/semiconductors" "/tools" "/tools/monte-carlo"; do
  printf '%-26s -> %s\n' "$p" "$(curl -s -o /dev/null -w '%{redirect_url}' "$HOST$p")"
done
```

Each must answer **307** with a `Location` of
`/auth/sign-in?next=<the path asked for>`, URL-encoded.

307, not 302: the redirect comes from middleware, and Next.js preserves the
method. A 302 would be the wrong answer here — it lets a browser turn a POST
into a GET and follow it into a page render, which is the bypass the
maintenance and assurance gates avoid for the same reason.

Check `next` specifically: without it a bookmark to `/` becomes a page nobody
can land on after signing in.

### 7c. The dock — eyes, not curl

The dock is a client component; the markup `curl` returns is not what a reader
sees. In a **private window**:

1. Open `$HOST/stock/AAPL`. The dock must show **exactly two** buttons: ค้นหา
   and เข้าสู่ระบบ. Five means the `authenticated` prop is not reaching it.
2. The second button's `href` must be `/auth/sign-in?next=%2Fstock%2FAAPL`.
3. Click it, sign in, and confirm you land back on `/stock/AAPL`.
4. Signed in, the dock must show **five** buttons again.

### 7d. The API surface

Newly authenticated — expect **401** with `error.code: "unauthenticated"`:

```bash
for p in "/api/market/fx?base=USD&quote=THB" \
         "/api/news?scope=market-wide" \
         "/api/news/market-summary" \
         "/api/market/industry/semiconductors/chart"; do
  printf '%-48s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "$HOST$p")"
done
```

Still public — expect `200`, or a genuine upstream `502`/`503`, but **never
401**:

```bash
for p in "/api/market/profile/AAPL" "/api/market/quote/AAPL" \
         "/api/market/search?q=apple" \
         "/api/market/candles?symbol=AAPL&interval=5m&range=1d" \
         "/api/market/history/AAPL?range=1y" \
         "/api/analytics/key-statistics/AAPL" \
         "/api/analytics/analyst-target/AAPL" "/api/news/summary/AAPL"; do
  printf '%-52s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "$HOST$p")"
done
```

A `401` here breaks the public stock page — §8 rollback trigger.

Cache headers:

```bash
curl -sI "$HOST/api/market/profile/AAPL" | grep -i '^cache-control\|^vary'
curl -sI "$HOST/api/market/fx?base=USD&quote=THB" | grep -i '^cache-control\|^vary'
```

`fx` must say `private` **and** `Vary: Cookie`. `public` on `fx` means a
shared cache can hand one reader's 200 to a caller with no session, which is
the authentication undone by a header — §11 rollback trigger. This is the one
that matters.

**`profile` will read `Cache-Control: public` with no `s-maxage`, and that is
correct.** Vercel consumes `s-maxage` for its own edge cache and rewrites the
client-facing header, so the value the route sets is not the value you see.
Production answers the same way today, before any of this shipped. The evidence
that shared caching is working is the CDN's own headers, not `s-maxage`:

```bash
curl -sI "$HOST/api/market/profile/AAPL" | grep -iE '^x-vercel-cache|^age|^cache-control'
```

A second request should show `X-Vercel-Cache: HIT` and a non-zero `Age`.

The write endpoint that gained a session requirement — expect **404**,
deliberately not 401, so an unauthenticated caller does not learn it exists:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$HOST/api/instruments/logo-invalidate" \
  -H 'content-type: application/json' \
  -d '{"symbol":"AAPL","url":"https://example.test/a.png"}'
```

Translation, which changed contract:

```bash
# The retired shape — a tab left open across the deploy sends this. Expect 400.
curl -s -X POST "$HOST/api/translate/company-profile" -H 'content-type: application/json' \
  -d '{"symbol":"AAPL","sourceText":"Apple designs phones.","targetLanguage":"th"}' | jq

# The current shape. Expect 200 with Thai text.
curl -s -X POST "$HOST/api/translate/company-profile" -H 'content-type: application/json' \
  -d '{"symbol":"AAPL","targetLanguage":"th"}' | jq
```

Then open `$HOST/stock/AAPL` in a private window. The profile card must show a
description — Thai if the translation succeeded, English if it did not. **A card
showing an error, or a page that fails to render, is a §8 rollback trigger**:
the whole point of the fallback is that a translation failure is never fatal.

### 7e. The four orphan routes

```bash
for p in "/api/market/overview" "/api/market/chart?symbol=AAPL" \
         "/api/market/session/AAPL" \
         "/api/market/history/intraday?symbol=AAPL&interval=5m"; do
  printf '%-56s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "$HOST$p")"
done
```

`401` for all four. They log `market_route_orphan_called` **after** the gate, so
a signed-out scanner never produces a line. Search the logs over the next two to
four weeks for:

```
"event":"market_route_orphan_called"
```

Nothing in that window means the four can be deleted with evidence rather than a
guess. Something means the `route` field names which one, and something outside
this repository depends on it.

---

## 7b. What preview already answered — compare production against this

The same build was deployed to a preview on 2026-09-21 and checked through a
Protection Bypass header, so the numbers below are measured, not predicted.
Production should match the middle column. Where it does not, that difference
is the finding.

Preview ran against the PRODUCTION database (its `NEXT_PUBLIC_SUPABASE_URL`
names `jjmenqktnabmajpqxzhr`, confirmed from the CSP `connect-src` it serves),
so every check was a GET. Nothing was written and no model was called.

### Pages

| Path | production before (`82fdac8`) | preview (`abe83cb`) |
|---|---|---|
| `/search` | 200 | 200 |
| `/stock/AAPL` | 200 | 200 |
| `/` | 200 | **307** → `/auth/sign-in?next=%2F` |
| `/industry/semiconductors` | 200 | **307** → `?next=%2Findustry%2Fsemiconductors` |
| `/tools` | 200 | **307** → `?next=%2Ftools` |
| `/tools/monte-carlo` | — | **307** → `?next=%2Ftools%2Fmonte-carlo` |

The first two staying 200 is as much the point as the other four changing.

### API

All four newly authenticated routes answered **401** with
`{"code":"unauthenticated"}`. All four orphans answered **401**. Six of the
eight public routes answered 200.

**The two that did not are pre-existing and are NOT regressions.** Both answer
identically on production today, at `82fdac8`, before any of this shipped:

| Endpoint | Both | Body |
|---|---|---|
| `/api/market/candles?symbol=AAPL&interval=5m&range=1d` | **501** | `unsupported: No configured provider supports this timeframe/range/adjustment combination` |
| `/api/analytics/key-statistics/AAPL` | **404** | `feature-disabled: Key Statistics feature is disabled` |

Do not spend the window diagnosing them. What would be a real failure is either
of them answering **401**, which would mean the split caught a public route.

### Cache headers

`fx` answered `Cache-Control: private, no-store` with `Vary: Cookie`.
`profile`, `history` and `search` answered `Cache-Control: public`, with
`X-Vercel-Cache: HIT` and `Age: 14` on a repeat — see the note in §7 about why
`s-maxage` is not visible.

### Dock

Read out of the server-rendered HTML rather than a browser, which is faster and
leaves a quotable artefact:

```bash
curl -s -H "..." "$HOST/stock/AAPL" | grep -oE '<a[^>]*dock__item[^>]*>'
```

Preview returned exactly two anchors on each public page:

```
/stock/AAPL
  <a aria-label="ค้นหา"      class="dock__item" href="/search">
  <a aria-label="เข้าสู่ระบบ" class="dock__item" href="/auth/sign-in?next=%2Fstock%2FAAPL">

/search
  <a aria-label="ค้นหา"      aria-current="page" data-active="true" href="/search">
  <a aria-label="เข้าสู่ระบบ" class="dock__item" href="/auth/sign-in?next=%2Fsearch">
```

Note the active item carries `aria-current="page"` and `data-active="true"`,
which a rigid grep will miss — count `dock__item` rather than matching a fixed
attribute order, or you will report one button where there are two.

### What preview could NOT answer

Its database is production's, so every write was skipped: no
`POST /api/translate/company-profile` (it calls a paid model),
no `POST /api/instruments/logo-invalidate`, no `/api/cron/alerts`. The
signed-in dock, the translation round trip and the alert path are first
exercised on production, in §6 and §7.

---

## 8. Wait 24 hours, then read the meter

Group B is still unapplied, on purpose. This is the **before** number.

Two log shapes, both `console.info`, so they land in Vercel's runtime logs:

```json
{"event":"provider_call","provider":"financial-modeling-prep","operation":"company-profile","source":"provider","outcome":"success","durationMs":412,"timestamp":"..."}
```

```json
{"event":"provider_call_rollup","windowStartedAt":"...","windowEndedAt":"...","rows":[{"provider":"gemini","operation":"company-profile-translation","source":"provider","calls":37,"errors":0,"avgDurationMs":880}]}
```

Vercel → Project → Logs, range = last 24 hours, filter on `provider_call_rollup`.
With a log drain, query the same string there. The rollup is the cheaper read:
one line per minute per instance rather than one per call.

`source` is the field this whole exercise turns on:

| `source` | Meaning |
|---|---|
| `provider` | the upstream was called — **this one costs money** |
| `db-snapshot` | answered from the shared table, no upstream call |
| `memory` | answered from this instance's cache, no upstream call |

Record total `calls` per `(provider, operation, source)`. Before group B,
`provider` should dominate and `db-snapshot` should be **absent** — the tables
do not exist yet and both services are failing open by design. If
`db-snapshot` appears now, something is wrong with this runbook's model and you
should stop and say so rather than continue.

Write the numbers down. This is the baseline.

---

## 9. Apply group B

```bash
npm run db:validate -- supabase/migrations/202609200003_company_profile_snapshot.sql
npm run db:validate -- supabase/migrations/202609200004_company_profile_translation_cache.sql
```

Each runs on dev inside a transaction it rolls back. Both are
`create table if not exists`, so passing against a dev that already has them is
itself the confirmation that re-applying is safe.

Then, in the **production** SQL editor, in filename order, one run each:

1. `supabase/migrations/202609200003_company_profile_snapshot.sql`
2. `supabase/migrations/202609200004_company_profile_translation_cache.sql`

Verify:

```sql
select c.relname, c.relrowsecurity as rls,
       (select count(*) from pg_policies p
         where p.schemaname = 'public' and p.tablename = c.relname) as policies
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('market_instrument_profiles', 'market_instrument_profile_translations');

select grantee, table_name, string_agg(privilege_type, ',' order by privilege_type)
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('market_instrument_profiles', 'market_instrument_profile_translations')
  and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
group by grantee, table_name order by table_name, grantee;
```

Required: `rls = true` and one policy each; `anon` and `PUBLIC` with **no row at
all**; `authenticated` with `SELECT` only. `service_role` shows more than the
migration grants — Supabase's default privileges give it everything on a new
table — which is expected and is the same on every other table here.

Then update the `STATUS` headers in all four migrations and the pending list in
[`migration-state.md`](migration-state.md), and commit that. Headers left saying
`NOT YET APPLIED` after they have run are the exact drift
`migration-order.test.ts` exists to catch.

---

## 10. Read the meter again after 24 hours

Same procedure as §8. Report both windows:

```
                                     before (§8)     after (§10)
fmp / company-profile     provider          ?               ?
fmp / company-profile     db-snapshot       ?               ?
gemini / translation      provider          ?               ?
gemini / translation      db-snapshot       ?               ?
```

`db-snapshot` should go from absent to dominant. If `provider` does not fall,
the read-through is not being reached — look for
`company_profile_snapshot_read_failed` or
`profile_translation_cache_read_failed`, which is what a missing grant or an
unreachable table looks like.

**Do not claim a saving without both columns filled in.** A cache added without
a before-number is a cache nobody can show worked.

---

## 11. Rollback

### Triggers

| Symptom | Severity | Action |
|---|---|---|
| `/api/cron/alerts` 503, or `PGRST202` in logs, after §5 | **immediate** | re-apply group A, or run the §1 reversal |
| `alert_evaluation_runs` newest row `failed` after §5 | **immediate** | same |
| `/stock/{symbol}` or `/search` redirects for anonymous | **immediate** | revert `efca2b5` |
| A public market API answers `401` | **immediate** | revert `efca2b5` |
| Profile card errors, or the stock page fails to render | **immediate** | revert `3faf7a1` |
| `/api/market/fx` answers `Cache-Control: public` | **immediate** | revert `af99150` |
| Settlement writes duplicate ledger rows | **immediate** | revert `e97116c` |
| `/api/version` reads `unknown` | blocks verification, not serving | fix env, redeploy |
| Instrument sync duplicates the universe | **immediate** | stop syncing; check `202609200002` landed |
| Provider calls rise rather than fall after §9 | investigate | see §10 |
| A dock button 404s | next working day | revert `efca2b5` |
| A back button points at the wrong parent | next working day | revert `ffe0a79` |

### Fastest path: revert the merge commit

Steps 3–6 produced one merge commit on `main`. Reverting it removes all thirteen
at once:

```bash
git switch main
git revert -m 1 <merge-commit-sha>
git push origin main
```

`-m 1` keeps `main`'s side as the parent. Use this when you do not yet know
which commit is at fault and the product is misbehaving now.

**If `202609200001` has already been applied, reverting the code is not
enough** — production would then have the ten-argument function and code that
calls nine. Run the §1 reversal in the same window.

### Reverting one commit

| Commit | Independent? | Notes |
|---|---|---|
| `787ab3a` docs | yes | documentation only |
| `510aba8` supabase-host declaration | **no** | only **with** `d6c2c0a` and `3faf7a1`; alone it declares files that no longer exist and the test fails |
| `ffe0a79` back buttons | yes | |
| `e97116c` settlement key | yes | |
| `c03640d` cache bound | yes | |
| `af99150` cache headers | yes | restores the `public` default; the industry chart stays private because `efca2b5` set that in its own file |
| `efca2b5` split + dock | yes | large. Restores anonymous access to `/`, `/industry/*`, `/tools/*` and the five-button dock together — one commit precisely so they cannot be separated |
| `3faf7a1` translate + logo auth | yes | restores the old request contract, so any browser tab loaded from the new build becomes the one sending the wrong shape — **hard-refresh after reverting** |
| `d6c2c0a` snapshot + meter | yes, but | falls back to per-instance caching cleanly. Also removes the meter, so you lose the measurement |
| `ea3d958` test timeouts | yes | reintroduces the flaky corpus failures |
| `a20f387` alerts | **paired with migration** | code and `202609200001` must move together in either direction |
| `c40917e` tracked-files test fix | yes | |
| `5084605` instrument identity | **paired with migration** | pairs with `202609200002` |

### The group B migrations do not need reverting

Both tables are additive `create table if not exists`, hold only cached copies
of public facts, and nothing references them. Reverting the code leaves two
empty unused tables, which costs nothing. **Do not drop them** — a `drop table`
is irreversible, and rolling forward again would just recreate them.

### Never force-push

These commits are public the moment §3 runs. `git revert` adds a commit;
rewriting published history is a second incident on top of the first.
