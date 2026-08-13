# Edge abuse protection

**Status: the application-side layers in this document are deployed. The Vercel
Firewall rules in §3 are *not* — they can only be created in the Vercel
dashboard, and nobody has created them yet.** §3 is the exact configuration to
enter, written so it can be applied without further decisions. Do not read it as
a description of the running system.

---

## 1. Why there are three layers and not one

Each layer can see something the others cannot, and each one's blind spot is the
next one's reason to exist.

| Layer | Where it runs | Sees | Cannot see |
|---|---|---|---|
| **Vercel Firewall** | The platform edge, before our code | The whole fleet; one address across every isolate and region | Who the caller is; what a route costs |
| **Edge burst gate** (`src/lib/security/edge-abuse.ts`) | Our middleware, per isolate | The path, the method, the address | Other isolates — a flood spread across them is invisible |
| **Per-identity limits** (`src/lib/security/rate-limit.ts`) | Route handlers and server actions, counted in Postgres | The authenticated account, across every instance and region | Nothing, but it costs a round trip to ask |

The ordering is by cost. The burst gate runs **before** `supabase.auth.getUser()`
in `middleware.ts`, which is the point: without it, a flood at `/auth/sign-in`
is a flood of auth-server round trips that we pay for and that are rate limited
against every legitimate reader on the same Supabase project. With it, a refused
request costs one map lookup.

The database limiter is deliberately **not** applied to ordinary API traffic
(class E). A live quote poll is high-volume and per-reader, and a round trip in
front of every one of them would cost more in latency and load than the abuse it
prevents — while the traffic that actually needs stopping is the burst the
in-process gate already catches. Classes A–D pay for the round trip and get a
limit that holds across instances.

## 2. The limits that are live

Risk classes are defined in `src/lib/security/abuse-policy.ts`; the sustained
per-identity bounds are in `src/lib/security/rate-limit.ts`.

| Class | Surface | Burst (per isolate, per address) | Sustained (per identity, shared) |
|---|---|---|---|
| **A — auth** | `/auth/sign-in`, `sign-up`, `forgot-password`, `reset-password` | 20 / 10s | sign-in 10 / 5 min · sign-up 6 / h · reset 5 / 15 min · update 8 / 15 min |
| **B — admin read** | `/admin/*` GET, `/api/admin/*` GET | 60 / 10s | 90 / min |
| **C — admin mutation** | `/admin/*` non-GET, `/api/admin/*` non-GET | 20 / 10s | **20 / min** |
| **D — expensive** | simulator compute, `/api/analytics/*`, options chain, translate, news | 20 / 10s | simulator 30 / min · analytics 60 / min |
| **E — API** | everything else under `/api/` | 200 / 10s | burst layer only (see §1) |
| **F — realtime** | the WebSocket Gateway | enforced in the Gateway process — see `services/market-gateway/runtime.ts` | — |

Class C is the tightest authenticated budget in the product, deliberately: these
are the operations that change what other people may do, and no operator
workflow needs more than one every three seconds sustained.

**Auth limits are layered.** Each attempt is charged against the client address
*and* against the email being attempted. Those catch different attacks — one
machine working through a password list, and a botnet with a thousand addresses
all trying the same account — and an address-keyed limiter is blind to the second
by construction.

Every refusal answers `429` with `Retry-After` and `Cache-Control: private,
no-store`.

## 3. Vercel Firewall rules — NOT YET APPLIED

These require the Vercel dashboard (**Project → Firewall**) or the REST API; they
cannot be expressed in `vercel.json`, which is why there is no firewall block in
this repo's config. Apply them against project `portkheaw` (`bas-dev`).

Persistent Actions run before any of our code, so they are the only layer that
can shed load across the whole fleet rather than one isolate.

### 3.1 Rules to create

| # | Name | Condition | Action |
|---|---|---|---|
| 1 | `admin-console-challenge` | Path starts with `/admin` | **Challenge** |
| 2 | `admin-api-challenge` | Path starts with `/api/admin` | **Challenge** |
| 3 | `auth-forms-rate-limit` | Path is one of `/auth/sign-in`, `/auth/sign-up`, `/auth/forgot-password`, `/auth/reset-password` **AND** method is `POST` | **Rate limit** — 30 requests / 60s, keyed by **IP address**, action **Deny** for 300s |
| 4 | `expensive-api-rate-limit` | Path starts with `/api/option-simulations/compute` **OR** `/api/analytics` **OR** `/api/market/options` **OR** `/api/translate` | **Rate limit** — 120 requests / 60s, keyed by **IP address**, action **Challenge** |
| 5 | `api-flood-rate-limit` | Path starts with `/api/` | **Rate limit** — 1200 requests / 60s, keyed by **IP address**, action **Challenge** |

Enable **Attack Challenge Mode** only during an active incident. It challenges
every visitor, including signed-out readers on public stock pages, so it is an
incident control and not a default.

### 3.2 What must NOT be blocked

Getting this wrong breaks the product in ways that are hard to diagnose, because
the failure happens before any of our logging.

- **`/auth/callback`** — completes OAuth and password-recovery links. A challenge
  here breaks sign-in for anybody arriving from an email client.
- **`/api/billing/webhook`** — Stripe. A dropped delivery is a paid invoice that
  never opens a plan; its protection is the signature check, which is the correct
  one. Stripe does not solve challenges.
- **`/api/cron/*`** — scheduler callbacks.
- **`/api/health`, `/api/version`** — the uptime monitor. A challenged health
  check reads as an outage.
- **Public stock pages and their API fan-out** — signed-out visitors are the
  product's front door.

### 3.3 Verifying, honestly

After applying, from a shell:

```bash
# Expect 200 — a health check is never challenged.
curl -s -o /dev/null -w '%{http_code}\n' https://portkheaw.vercel.app/api/health

# Expect a challenge (403 with a Vercel challenge body), not a 404.
curl -s -o /dev/null -w '%{http_code}\n' https://portkheaw.vercel.app/admin

# Expect the first requests to pass and later ones to be denied.
for i in $(seq 1 40); do
  curl -s -o /dev/null -w '%{http_code} ' -X POST https://portkheaw.vercel.app/auth/sign-in
done; echo
```

Until somebody has run these and seen those results, the firewall layer is **not
protecting anything**, regardless of what the dashboard shows as configured.

## 4. Railway Gateway

The Gateway is a long-lived Node process, so its limits are in-process and
authoritative for that instance. They are in
`services/market-gateway/runtime.ts` and are live.

| Bound | Value |
|---|---|
| Origin allowlist | `NEXORA_ALLOWED_ORIGINS`; missing `Origin` refused in production |
| Connection rate | 30 per address / 60s → `429` |
| Concurrent per address | 12 → `429` |
| Concurrent per account | 8 → close `4400` |
| Concurrent total | 2000 → `503` (backpressure, not capacity) |
| Subscribe frames | 60 per client / 60s |
| Subscriptions per client | 60 `(symbol, channel)` pairs |
| Instance symbol set | 30 — this is the provider quota protection |
| Inbound frame size | 16 KiB → close `1009` |
| Malformed frames | 10 → close `4400` |
| Probe after silence | 30s (transport ping) |
| Close after silence | 90s → close `4408` |

**Required Railway environment variables:**

```
NEXORA_ALLOWED_ORIGINS=https://portkheaw.vercel.app
NEXT_PUBLIC_SUPABASE_URL=<project url>
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable key>
```

The two Supabase variables are what enable per-account connection accounting. If
they are absent the Gateway logs `identity verification disabled` at startup and
every connection is bounded by address alone — it does not fail, and realtime
keeps working, but the per-account cap is inert. **Check that log line after
deploying.**

## 5. Tuning

If a limit turns out to be wrong, change the number in
`abuse-policy.ts` / `rate-limit.ts` and ship it — do not add an exemption for a
caller. The tests in `src/lib/security/abuse-policy.test.ts` replay real
interaction patterns (a page's whole API fan-out, an operator working briskly, a
person mistyping a password) against the live policy, so a limit that would
refuse a real reader fails the build.
