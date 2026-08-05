# Secret rotation

Scope: every credential the deployed product holds. This is a runbook for a
human to follow deliberately.

> **Nothing here rotates automatically.** There is no scheduled job, no script
> and no code path in this repository that replaces a live credential. Automatic
> rotation of a payment key is how a product stops taking money at 03:00 with
> nobody awake to notice.

---

## 0. Rules that apply to every rotation

1. **Overlap before you revoke.** Wherever the provider allows two valid
   credentials at once, create the new one, deploy it, prove it works, and only
   then revoke the old one. A rotation that revokes first is an outage.
2. **One credential at a time.** Rotating two together means a failure cannot be
   attributed to either.
3. **Never in a Friday evening or during a Thai market session.** Prefer a
   weekday morning, Bangkok time, with the operator console open.
4. **Never paste a secret into this repository**, a commit message, a ticket, a
   chat, an artifact, or an error report. `src/lib/monitoring/sanitize.ts`
   redacts the known shapes from reports, but that is a safety net, not a place
   to put secrets.
5. **Verify with `/api/health` and one real read**, not by assuming the deploy
   succeeded.
6. **Record the rotation** in the log at the bottom. Date and operator only —
   never the value, never a prefix, never a fingerprint.

---

## 1. Ownership

| Credential | Where it lives | Owner | Blast radius if leaked |
| --- | --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel env (server) | Project owner | **Total.** Bypasses every row-level policy: every account's portfolio, mailbox, ticket and billing row. |
| `STRIPE_SECRET_KEY` | Vercel env (server) | Project owner | Money. Read and write on the Stripe account: customers, subscriptions, refunds. |
| `STRIPE_WEBHOOK_SECRET` | Vercel env (server) | Project owner | Forged entitlement. Someone who can sign events can grant themselves a paid plan. |
| `CRON_SECRET` | Vercel env + Supabase `cron.schedule` header | Project owner | Scheduler abuse — repeated alert/reconciliation runs. No data read. |
| `SENTRY_DSN` | Vercel env (server) | Project owner | Log noise only. A public DSN authorizes writing events and nothing else. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Vercel env (public) | Project owner | None on its own — it is public by design and every table behind it is under row-level security. |
| Market-data keys (`ALPACA_*`, `POLYGON_*`, `FMP_*`, `ALPHA_VANTAGE_*`, `FINNHUB_*`, `NEWS_API_KEY`, `GEMINI_API_KEY`) | Vercel env (server) | Project owner | Quota theft and billing on the provider. No customer data. |
| `VAPID_PRIVATE_KEY` | Vercel env (server) | Project owner | Forged push notifications to subscribed devices. |
| Railway gateway variables | Railway service env | Project owner | Market-gateway abuse. No customer data. |

---

## 2. Order

Rotate in this order when rotating several. It runs from "safest to get wrong"
to "most disruptive", so an aborted sequence leaves the product in the least
damaged state:

1. Monitoring token (`SENTRY_DSN`) — nothing depends on it.
2. Market-data keys — a failure degrades data, never money or access.
3. `CRON_SECRET` — a failure delays background work by one tick.
4. `VAPID_PRIVATE_KEY` — a failure stops push; the Inbox still works.
5. `STRIPE_WEBHOOK_SECRET` — supports overlap; see §3.3.
6. `STRIPE_SECRET_KEY` — supports overlap; see §3.4.
7. `SUPABASE_SERVICE_ROLE_KEY` — **last**, and alone. See §3.5.

---

## 3. Procedures

### 3.1 Monitoring token — `SENTRY_DSN`

1. Sentry → Settings → the project → Client Keys → **Generate new key**.
2. Vercel → Project → Settings → Environment Variables → update `SENTRY_DSN`.
3. Redeploy.
4. **Verify:** trigger a harmless capture (an admin search while the database is
   briefly unreachable, or wait for the next natural warning) and confirm it
   arrives. With no DSN at all the reporter still writes a structured line to the
   Vercel log — so an unverified rotation degrades to logging, never to silence.
5. Revoke the old key in Sentry.

### 3.2 Market-data keys

1. Create a new key in the provider's dashboard.
2. Update the Vercel variable. Redeploy.
3. **Verify:** open a stock detail page and confirm the price, the chart and the
   options chain all resolve. `npm run probe:chart-history` and
   `npm run probe:options-chain` exercise the same paths from a terminal.
4. Revoke the old key.

**Rollback:** put the previous key back and redeploy. Keys are stateless; there
is nothing to unwind.

### 3.3 `STRIPE_WEBHOOK_SECRET`

Stripe supports two signing secrets on one endpoint during a roll, which is what
makes this safe.

1. Stripe Dashboard → Developers → Webhooks → the endpoint → **Roll secret**.
   Choose an expiry of 24 hours for the old secret, so both are valid meanwhile.
2. Copy the new signing secret into Vercel as `STRIPE_WEBHOOK_SECRET`. Redeploy.
3. **Verify — this is the important step:**
   - Stripe → the endpoint → **Send test webhook** (`invoice.paid`), and confirm
     a 200 in Stripe's delivery log.
   - `/admin` → *Webhook ที่ยังลองใหม่อยู่* and *Webhook ล้มเหลวถาวร* must both
     stay at their previous values. A signature mismatch appears here first.
   - `/admin/billing` → search a QA account → **ประวัติ webhook** shows the new
     event as processed.
4. Let the old secret expire on its own. Do not revoke it early.

**Rollback:** the old secret is still valid inside the overlap window — restore
the previous Vercel value and redeploy. After the window closes, roll again.

**If deliveries failed during the window:** they are not lost. Stripe retries for
about three days, and this product's own bounded retry ledger records each
attempt. Once the correct secret is deployed, use Stripe → Webhooks → **Resend**
for anything already dead-lettered, then confirm the reconciliation list at
`/admin` is empty.

### 3.4 `STRIPE_SECRET_KEY`

1. Stripe Dashboard → Developers → API keys → **Create restricted key** or roll
   the secret key. Stripe keeps the old key working until you revoke it.
2. Update `STRIPE_SECRET_KEY` in Vercel. Redeploy.
   - The key must match `BILLING_PROVIDER_MODE`: `sk_live_…` for `live`,
     `sk_test_…` for `test`. A mismatch is detected at startup and billing
     refuses to enable rather than taking money in the wrong mode.
3. **Verify:**
   - `/api/health` → `checks.billing` is `ok`.
   - `/settings/subscription` on a QA account renders the plan cards.
   - Open the billing portal from a QA account that has a customer record. It
     round-trips through Stripe with the new key.
   - **Do not run a real checkout, refund or dispute to verify.** Use Stripe's
     own test mode for that, on a separate deployment.
4. Revoke the old key in Stripe.

**Rollback:** restore the previous key in Vercel and redeploy, before revoking.

### 3.5 `SUPABASE_SERVICE_ROLE_KEY`

The highest-blast-radius credential in the product. Rotate it alone, with
nothing else in flight.

1. Supabase Dashboard → Project Settings → API → **JWT keys / service role** →
   generate a new service key.
   - On projects using legacy JWT secrets, rotating the JWT secret invalidates
     **every** existing session and signs all readers out. Expect that, and say so
     in advance rather than discovering it from support tickets.
2. Update `SUPABASE_SERVICE_ROLE_KEY` in Vercel. Redeploy.
3. Update it anywhere else it is held — the Railway gateway service, and any
   local `.env.local` used for probes.
4. **Verify:**
   - `/api/health` → `checks.database` is `ok`.
   - Sign in on a QA account; the portfolio and watchlist load.
   - Trigger the scheduler once (`GET /api/cron/alerts` with `CRON_SECRET`) and
     confirm `/api/health` → `checks.scheduler` returns to `ok` within an hour.
   - `/admin` renders its aggregates.
5. Revoke the old key.

**Rollback:** restore the previous key in Vercel and redeploy. If the JWT secret
itself was rotated, sessions cannot be un-invalidated — readers sign in again.

### 3.6 `CRON_SECRET`

The scheduler is called from two places, and both must be updated or the tick
silently stops.

1. Generate a new value: `openssl rand -hex 32`.
2. Update `CRON_SECRET` in Vercel. Redeploy.
3. Update the header in the Supabase scheduled job that calls the route — see
   `supabase/migrations/202608020003_supabase_notification_cron.sql` and
   `…04_notification_cron_vercel_alias.sql` for how the schedule is declared.
   Re-run `cron.schedule` with the new header value.
4. **Verify:** within one scheduling interval, `/api/health` →
   `checks.scheduler` is `ok`. If it goes to `degraded` and then `unavailable`,
   the two halves disagree — recheck step 3.

### 3.7 `VAPID_PRIVATE_KEY`

Rotating the VAPID pair invalidates every existing push subscription; devices
re-subscribe on their next visit.

1. Generate a new pair (`npx web-push generate-vapid-keys`).
2. Update `VAPID_PRIVATE_KEY` and `NEXT_PUBLIC_VAPID_PUBLIC_KEY` **together** —
   a mismatched pair fails every send.
3. Redeploy, then send a test push to a QA device from the notification settings.

### 3.8 Railway gateway variables

1. Railway → the `market-gateway` service → Variables → update.
2. Railway redeploys automatically. Watch the deploy log for a clean start.
3. **Verify:** the gateway's `/healthz` and `/readyz`, then open a stock detail
   page and confirm the header shows a live price.

---

## 4. If a secret has actually leaked

Order changes: revoke first, ask questions second.

1. Revoke the exposed credential immediately, accepting the outage.
2. Rotate it by the procedure above.
3. Check for use you did not make:
   - Stripe → Developers → **Logs**, filtered to the exposure window.
   - Supabase → Logs → Postgres and Auth, same window.
   - `/admin` → *การกระทำล่าสุดของผู้ดูแลระบบ*, and the full audit feed. The
     admin audit is append-only, so what is there cannot have been edited away.
4. If customer data may have been read, follow the disclosure duties in
   `/privacy` rather than deciding ad hoc.
5. Purge the secret from wherever it leaked — including git history, if it was
   committed. A revoked key in history is still a signal about the shape of your
   infrastructure.

---

## 5. Rotation log

Date and operator only. Never a value, a prefix or a fingerprint.

| Date | Credential | Operator | Verified by | Notes |
| --- | --- | --- | --- | --- |
| _(none yet)_ | | | | |
