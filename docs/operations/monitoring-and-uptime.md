# Error monitoring and uptime

Scope: what the product reports when something fails, and what an external
monitor may ask it.

---

## 1. Current state

There is **no monitoring provider connected**. That is a configuration gap, not
a code gap: every capture point, the redaction, and the tests for both are in the
repository and running today. With no DSN configured the reporter writes one
structured, sanitized JSON line to the platform log — which on Vercel is a real,
searchable destination — and connecting a provider later is an environment
change, not a code change.

Release was not blocked on this. See §5 for what a human still has to do.

---

## 2. What is captured

`captureServerError()` in `src/lib/monitoring/report.ts` is the single entry
point. It is called from:

| Scope | Where | Level | Why it is worth a page |
| --- | --- | --- | --- |
| `billing.checkout` | `app/settings/subscription/billing-actions.ts` | error | A reader tried to pay and could not. Revenue and trust. |
| `billing.portal` | same | error | A subscriber cannot reach cancellation or their invoices. |
| `billing.promptpay-renewal` | same | error | A PromptPay subscriber cannot renew and will lapse. |
| `billing.webhook.dead-letter` | `app/api/billing/webhook/route.ts` | error | A paid invoice may never have opened a plan. |
| `billing.reconciliation` | `src/lib/alerts/background.ts` | error | The daily comparison of billed-vs-granted did not run. |
| `billing.reconciliation.issues` | same | warning | It ran and found critical disagreements. |
| `scheduler.background-run` | same | error | The whole tick died: alerts, summaries, renewal reminders and reconciliation all skipped. |
| `beta.access` | `src/lib/beta/beta-server.ts` | warning | The rollout gate could not be read and failed open. |
| `admin.*` | `src/lib/admin/admin-repository.ts` | warning | An operator panel could not load during an incident. |

Nothing in the request path waits on a report: `captureServerError` returns
`void`, is never awaited, and cannot throw.

---

## 3. What is never sent

Enforced by `src/lib/monitoring/sanitize.ts` and asserted in
`sanitize.test.ts`:

- **Redacted from every message and stack:** provider secret and restricted keys
  (`sk_…`, `rk_…`), webhook secrets (`whsec_…`), JWTs (which is what a Supabase
  service key is), `Authorization`/`apikey` header values, Stripe object ids
  (`cus_…`, `sub_…`, `in_…`, `pi_…`, `ch_…`, `evt_…`), card-shaped digit runs,
  mailboxes, and `token=`/`secret=`/`password=` query parameters.
- **Context is an allowlist, not a denylist.** Only `scope`, `route`,
  `operation`, `code`, `outcome`, `planKey`, `paymentRail`, `providerMode`,
  `eventType`, `stage`, `attempt`, `status`, `requestId` and `featureKey` survive.
  A call site that passes `email` or `userId` has that field dropped, silently
  and by construction — a denylist would miss whichever field nobody thought of.
- Values are stringified and truncated (120 characters), so an object passed by
  mistake cannot become the report.

---

## 4. Connecting Sentry

The integration is Sentry-compatible by envelope format; the SDK is deliberately
not a dependency. It is large, it instruments globals, and everything needed here
is one POST of a well-specified document.

1. Create a Sentry project (platform: **Node.js**).
2. Copy the **public DSN** — the `https://<key>@<host>/<project>` form. It
   authorizes writing events and nothing else.
3. Vercel → Project → Settings → Environment Variables:

   ```dotenv
   SENTRY_DSN=https://<key>@<org>.ingest.sentry.io/<project>
   SENTRY_ENVIRONMENT=production
   ```

   Server-side only. Do not add a `NEXT_PUBLIC_` variant: a public ingest
   endpoint in the browser bundle invites noise, and none of the capture points
   are client-side.
4. Redeploy. `release` is tagged automatically from `VERCEL_GIT_COMMIT_SHA`, so
   an event points at the exact commit serving it.
5. Verify with §6.

To use a different provider, replace `sentryEnvelope()` in
`src/lib/monitoring/report.ts`. Nothing else changes — the capture points, the
allowlist and the redactor are provider-agnostic.

### Suggested alert rules

- Any event with `scope:billing.webhook.dead-letter` → page immediately.
- Any event with `scope:scheduler.background-run` → page immediately.
- `scope:billing.checkout` more than 3 times in 15 minutes → page.
- `scope:billing.reconciliation.issues` → daily digest, not a page. It is a list
  for an operator to work, and it is already on `/admin`.

---

## 5. Uptime monitoring

`GET /api/health` is public, unauthenticated, and answers in a fixed shape:

```json
{
  "status": "ok",
  "checks": { "app": "ok", "database": "ok", "billing": "ok", "scheduler": "ok" }
}
```

- `status` is `ok`, `degraded` or `unavailable`.
- Each check is `ok`, `degraded` or `unavailable`.
- **200** while the product can serve readers; **503** once the database is
  unreachable.
- A stale scheduler or incomplete billing configuration reports as `degraded`
  and still answers **200**. An uptime provider paging at 03:00 because a
  background job lagged — while every reader is served perfectly — is a worse
  outcome than the lag.

It deliberately reveals no variable name, provider name, error text, row count or
timestamp. An unauthenticated caller learns that the service is healthy or that
it is not.

### Configuring a provider

No uptime provider is configured. Any of Better Stack, Checkly, UptimeRobot or
Pingdom works with:

| Setting | Value |
| --- | --- |
| URL | `https://<production-origin>/api/health` |
| Method | `GET` |
| Interval | 60s |
| Up condition | HTTP 200 **and** body contains `"database":"ok"` |
| Alert after | 2 consecutive failures (one cold start is not an outage) |

Add a second, looser check on `GET /api/version` to confirm which commit is
serving — useful during a deploy, and it exposes only a SHA and a build time.

---

## 6. Verifying a monitoring change

1. `curl -s https://<origin>/api/health | jq` → `status: "ok"`.
2. `curl -s -o /dev/null -w '%{http_code}' https://<origin>/api/health` → `200`.
3. Confirm no secret in the body:
   `curl -s https://<origin>/api/health | grep -Ei 'stripe|supabase|sk_|whsec|postgres'`
   → no output.
4. With a DSN configured, confirm an event arrives in the provider. The
   cheapest honest trigger is an operator search while the database is briefly
   unreachable; do **not** manufacture a payment failure to test monitoring.
