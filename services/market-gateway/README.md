# Nexora Market WebSocket Gateway

A standalone, long-lived Node service that owns **one** upstream Alpaca
real-time connection per instance and fans normalized market events out to many
browser clients over a single `/ws` endpoint. The browser never sees Alpaca
credentials — it speaks only the Gateway's control protocol to
`NEXT_PUBLIC_MARKET_WS_URL`.

> **Why not Vercel?** This is a persistent socket owner. Serverless / Vercel
> route handlers are request-scoped and cannot hold the upstream connection, so
> the Gateway must run as its own always-on Node service (Railway / Render / Fly
> / a container). The Next.js app on Vercel only needs the public `wss://` URL.

## Endpoints

| Method | Path       | Purpose                                                            |
| ------ | ---------- | ----------------------------------------------------------------- |
| `GET`  | `/healthz` | Liveness/readiness JSON (always `200`; body reflects readiness).  |
| WS     | `/ws`      | Browser subscription stream (Origin-checked, rate-limited).       |

`/healthz` body (no secrets, ever):

```json
{
  "status": "ready",          // "ready" only when the upstream is authenticated & streaming; else "degraded"
  "upstreamState": "ready",   // idle | connecting | authenticating | ready | reconnecting | stopped
  "feed": "iex",              // iex | sip | test
  "uptime": 123,              // whole seconds
  "timestamp": "2026-07-22T00:00:00.000Z"
}
```

The endpoint returns HTTP `200` even while `degraded` so the platform keeps the
instance during a transient upstream reconnect; the process self-heals with
exponential backoff. It never returns a credential, URL, or key.

## Hardening (production deployment gate)

- **Port** — `PORT` (injected by Railway/most PaaS) wins over `MARKET_WS_PORT`,
  then the `8081` default. Binds `0.0.0.0`.
- **Origin allow-list** — WebSocket upgrades are accepted only from an origin in
  `NEXORA_ALLOWED_ORIGINS`. `localhost`/loopback and a missing `Origin` header
  are permitted **only** when `NODE_ENV=development`.
- **Abuse limits** — inbound WS messages are capped at 16 KB (`maxPayload`),
  connections are rate-limited per IP, subscribe/unsubscribe frames are
  rate-limited per client, and the symbol cap is 30 per client.
- **One upstream per Alpaca key** — the free IEX plan permits only one active
  stream for the same credentials. Keep this service at one replica and do not
  deploy the same `ALPACA_*` keys to a second Railway service. `railway.json`
  disables deployment overlap so a replacement does not compete with the
  retiring instance.
- **Graceful shutdown** — `SIGTERM`/`SIGINT` drain in order (timers → upstream →
  peers → WS server → HTTP server) then exit `0`, with a force-exit backstop.
- **Fatal safety** — `uncaughtException` / `unhandledRejection` log a *sanitized*
  error, drain the same way, and exit `1`. The process is never left in an
  unknown state, and credentials are never logged.

## Environment

Set these on the **Gateway host** (Railway), not on Vercel:

| Variable                  | Required | Example                          | Notes                                                                 |
| ------------------------- | -------- | -------------------------------- | --------------------------------------------------------------------- |
| `MARKET_REALTIME_ENABLED` | yes      | `true`                           | Master switch. When false/unset the Gateway exits `1` (stay on REST). |
| `ALPACA_API_KEY_ID`       | yes      | `AK...`                          | **Secret.** Server-only; never `NEXT_PUBLIC_`.                        |
| `ALPACA_API_SECRET_KEY`   | yes      | `...`                            | **Secret.** Server-only; never `NEXT_PUBLIC_`.                        |
| `ALPACA_DATA_FEED`        | no       | `iex`                            | `iex` (default) · `sip` (paid) · `test` (FAKEPACA sandbox).           |
| `NEXORA_ALLOWED_ORIGINS`  | prod     | `https://app.example.com`        | Comma-separated browser origins allowed to open `/ws`.                |
| `PORT`                    | auto     | `8080`                           | Injected by Railway. Falls back to `MARKET_WS_PORT`, then `8081`.     |
| `MARKET_WS_PORT`          | no       | `8081`                           | Local/dev port when `PORT` is absent.                                 |

`NODE_ENV` should be left **unset or `production`** on the host. Do not set
`NODE_ENV=development` in production — it would relax the Origin check.

## Run locally

```bash
# .env.local holds ALPACA_* + MARKET_REALTIME_ENABLED=true
npm run gateway            # ws://localhost:8081/ws · http://localhost:8081/healthz
```

## Deploy to Railway

1. **New Project → Deploy from repo** (this repository). Railway reads
   [`railway.json`](../../railway.json) at the repo root.
   - Build: `npm ci --include=dev` — `--include=dev` guarantees `tsx` (the TS
     runner used by `npm run gateway`) is installed even if `NODE_ENV=production`.
   - Start: `npm run gateway`
   - Healthcheck: `/healthz`
2. **Variables** — add every "Gateway host" variable from the table above.
   `PORT` is provided by Railway automatically; do not hardcode it.
3. **Deploy.** Railway assigns a public domain, e.g.
   `https://<service>.up.railway.app`. The WS URL is the same host with the
   `wss://` scheme and the `/ws` path:
   `wss://<service>.up.railway.app/ws`. **No Railway domain is hardcoded** in
   this repo — you copy the generated one into Vercel (below).
4. **Verify:** `curl https://<service>.up.railway.app/healthz` → `200` JSON.

## Wire the Vercel app to the Gateway

Set on **Vercel** (Production env), then redeploy the Next.js app:

| Variable                   | Value                                   |
| -------------------------- | --------------------------------------- |
| `NEXT_PUBLIC_MARKET_WS_URL`| `wss://<service>.up.railway.app/ws`     |

The middleware CSP derives its `connect-src` WebSocket origin from this value
(origin only, no path, no hardcoded domain). Production adds **no** localhost
fallback: if this is unset in production, the browser simply stays on REST
polling.
