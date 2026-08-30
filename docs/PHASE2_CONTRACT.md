# Phase 2 — Survey + Contract

เอกสารนี้มีสองครึ่งที่ต้องไม่ปนกัน:

- **§1 SURVEY** — สิ่งที่ **มีอยู่จริงในโค้ดตอนนี้** ทุกบรรทัดอ้างไฟล์ที่อ่านมาแล้ว
  ไม่มีข้อเสนอ ไม่มีการเดา
- **§2 CONTRACT** — **type + ที่อยู่ไฟล์** ที่ Phase 2 จะต้องมี ยังไม่ implement logic
  ทุก type ที่ชนกับของเดิมถูกทำเครื่องหมายไว้
- **§3 REUSE MAP** — อะไรใช้ของเดิม อะไรสร้างใหม่ อะไรเสี่ยงซ้ำซ้อน
- **§4 OPEN QUESTIONS** — คำถามที่ **ตอบไม่ได้จากโค้ด** รวมไว้ท้ายไฟล์ทั้งหมด

สำรวจจาก branch `feat/phase2-foundation` ที่ `60c9c41` (แยกจาก `main`)

---

# §1 SURVEY

## 1.1 หน้า Overview

### ไฟล์และหน้าที่

| ไฟล์ | ชนิด | หน้าที่ |
|---|---|---|
| [app/page.tsx](../app/page.tsx) | Server Component (`async function Home`) | โหลดข้อมูลทั้งหน้า ประกอบ payload เดียวส่งลง client |
| [src/components/dashboard/DashboardClient.tsx](../src/components/dashboard/DashboardClient.tsx) | Client Component | วาดทุก section, ถือ retry state |
| [src/lib/overview/types.ts](../src/lib/overview/types.ts) | types | `OverviewDashboardData` = สัญญาระหว่างสองไฟล์ข้างบน |
| [src/lib/overview/section-order.ts](../src/lib/overview/section-order.ts) | pure | ลำดับ section เป็น **ข้อมูล** ไม่ใช่ JSX |

`app/page.tsx` ไม่มี `export const revalidate` / `dynamic` / `runtime` — เป็น dynamic render
ปกติเพราะอ่าน Supabase session

### Component tree ที่วาดจริง

```
Home (app/page.tsx, server)
└── DashboardClient (DashboardClient.tsx:1283, client)
    ├── Header                                   src/components/layout/Header.tsx
    └── <main class="page-stack">
        ├── [signed-out only] LandingFunnel      src/components/analytics/LandingFunnel.tsx
        ├── [signed-out only] PublicValueProposition   DashboardClient.tsx:144
        ├── OnboardingCard                       src/components/onboarding/OnboardingCard.tsx
        │
        ├── <section id="market-overview">       DashboardClient.tsx:1473   ← อยู่นอกลำดับ ไม่ย้ายตามธง
        │   ├── SectionTitle "ตลาดวันนี้"        DashboardClient.tsx:204
        │   ├── StatusLabel (market summary)     buildMarketSummary() จาก src/lib/overview/market-summary.ts
        │   └── MarketCard × N                   DashboardClient.tsx:707  (scroller บนมือถือ / grid บน sm+)
        │
        ├── {sections.map(...)}                  ← ลำดับตาม section-order.ts (ดูตารางถัดไป)
        │   ├── MarketStatusCard                 src/components/dashboard/MarketStatusCard.tsx
        │   ├── PortfolioSummaryLine             DashboardClient.tsx:464
        │   ├── WatchlistSection                 DashboardClient.tsx:970
        │   ├── ChangesSection                   DashboardClient.tsx:686
        │   ├── MarketEventsCard                 src/components/market-events/MarketEventsCard.tsx
        │   ├── UpcomingSection                  src/components/upcoming/UpcomingSection.tsx
        │   └── NewsSection → NewsFeed           DashboardClient.tsx:668 → src/components/news/NewsFeed.tsx (dynamic, ssr:false)
        │
        └── <details> "ข้อมูลเชิงลึกของตลาดและสถานะระบบ"   ← ปิดอยู่โดย default
            ├── ServiceStatus                    DashboardClient.tsx:413
            ├── IndustryRanking                  DashboardClient.tsx:831
            └── BreadthSection                   DashboardClient.tsx:1143
```

### ลำดับ section

อยู่ใน [src/lib/overview/section-order.ts](../src/lib/overview/section-order.ts) เป็น array ของ key
แล้ว `orderedOverviewSections(present, useV2)` **filter ออก** section ที่ไม่มี — ไม่ render เป็น
`null` ใน wrapper (คอมเมนต์ในไฟล์อธิบายว่าเพราะ wrapper ที่ว่างจะทิ้ง margin ไว้)

| ลำดับ | `OVERVIEW_ORDER_V1` (default) | `OVERVIEW_ORDER_V2` (`OVERVIEW_V2=true`) |
|---|---|---|
| 1 | `marketStatus` | `marketStatus` |
| 2 | `portfolio` | `portfolio` |
| 3 | `watchlist` | `whatChanged` |
| 4 | `whatChanged` | `watchlist` |
| 5 | `upcoming` | `marketEvents` |
| 6 | `news` | `upcoming` |
| 7 | `marketEvents` | `news` |

เงื่อนไข present (DashboardClient.tsx:1399):
`marketStatus` = มี `view.marketStatus` · `portfolio` / `watchlist` / `news` = เสมอ ·
`whatChanged` = `changes.length > 0` · `marketEvents` = มี `view.marketEvents` ·
`upcoming` = มี `view.upcoming`

### Feature flags ที่มีผลกับหน้านี้

[src/config/features.ts](../src/config/features.ts) — **default OFF ทุกตัว** (`featureFlagEnabled` ไม่ส่ง
default argument) มีเอกสาร rollout อยู่แล้วที่ [docs/phase2-rollout.md](phase2-rollout.md)

| Env var | ฟังก์ชัน | คุมอะไร |
|---|---|---|
| `MARKET_STATUS_CARD` | `marketStatusCardEnabled()` | การ์ด Market Status + ค่า 6 quote |
| `WATCHLIST_V2` | `watchlistV2Enabled()` | trend column, preview 5 แถว, หลาย watchlist |
| `WHAT_CHANGED_CARD` | `whatChangedCardEnabled()` | section "มีอะไรเปลี่ยน" + daily bar loads |
| `MARKET_EVENTS_CARD` | `marketEventsCardEnabled()` | ปฏิทิน macro (ไม่มีค่า provider) |
| `NEWS_FILTER` | `newsFilterEnabled()` | market-wide → personalized news |
| `OVERVIEW_V2` | `overviewV2Enabled()` | ลำดับ section เท่านั้น |

---

## 1.2 Data layer

### สิ่งที่ `app/page.tsx` เรียกจริง ตามลำดับ

| # | เรียก | ไฟล์ |
|---|---|---|
| 1 | `PortfolioRepository.getAll()` / `.getAggregateGoal()` | src/lib/portfolio/repository.ts |
| 2 | `WatchlistRepository.getDefault()` / `.listAll()` | src/lib/watchlist/repository.ts |
| 3 | `user_settings` select (onboarding 4 คอลัมน์) | inline ใน app/page.tsx |
| 4 | `loadIndustryDashboardSnapshot(now)` + `warmIndustryDashboard` ใน `after()` | src/lib/overview/service.ts:694,699 |
| 5 | `loadMarketBreadthSnapshot(now)` + `warmMarketBreadth` ใน `after()` | src/lib/overview/market-breadth.ts:261,269 |
| 6 | `loadMarketIndices` / `loadWatchlistPrices` / `loadPortfolioPrices` | src/lib/overview/service.ts:480,547,570 |
| 7 | `getFxRate('USD','THB')` — หุ้ม `settleWithin(…, 1500ms)` | src/lib/market-data/fx/service.ts |
| 8 | `loadDailySnapshots(client, symbols, now)` | src/lib/market-data/daily-snapshot.ts:55 |
| 9 | `calculateOptionLedger` + `loadPortfolioOptionQuotes` | src/lib/portfolio/options/{calculations,quote-pipeline}.ts |
| 10 | `AlertsRepository.list()` | src/lib/alerts/repository.ts |
| 11 | `loadUpcomingEarnings(upcomingEarningsSymbols(...))` | src/lib/upcoming/service.ts:46,28 |
| 12 | `loadMarketStatusWithHistory(client, now)` / `loadMarketStatus(now)` | src/lib/market-status/service.ts |
| 13 | `buildMarketEventsCardView({ now })` | src/lib/market-events/card-view.ts:47 |

ทุกตัวหุ้ม `Promise.allSettled` / `.catch()` — ไม่มีตัวไหนล้มแล้วพาทั้งหน้าลง

### ราคา / quote

| ชั้น | ไฟล์ | หมายเหตุ |
|---|---|---|
| gateway (Polygon) | src/lib/market-data/gateway/{service,polygon-provider}.ts | `getQuote` / `getSession` / `resolveInstrument` |
| resilient quote | src/lib/market-data/quote-service.ts:116 `loadResilientQuote` | gateway + Yahoo fallback |
| Yahoo chart provider | src/lib/market-data/candles/ (`getYahooChartProvider`) | `getQuote` / `getExtendedQuote` |
| canonical snapshot | src/lib/market-data/market-snapshot.ts:619 `resolveCanonicalMarketSnapshot` | ตัดสินว่าราคาไหนคือ "ราคาหลัก" |
| overview wrapper | src/lib/overview/service.ts:229 `loadOverviewPrice` | คืน `OverviewPrice` |
| in-process last-known | src/lib/market-data/quote-cache.ts | `Map<symbol, ResolvedQuote>` ธรรมดา |

สินทรัพย์ที่การ์ด "ตลาดวันนี้" ใช้: [src/lib/overview/market-assets.ts](../src/lib/overview/market-assets.ts) —
`SPY, QQQ, DIA, IWM, GC-F, SI-F, CL-F, REMX, BTC-USD` (มี `marketKind`: `us-equity` /
`commodity` / `continuous`)

### Market Status (6 อินพุต)

[src/config/market-status.ts](../src/config/market-status.ts) + [src/lib/market-status/rules.ts](../src/lib/market-status/rules.ts) +
[src/lib/market-status/service.ts](../src/lib/market-status/service.ts)

| key | symbol ที่ quote จริง | group | polarity | weight | flat band | full weight |
|---|---|---|---|---|---|---|
| `SPX` | `SPY` (proxy) | equity | +1 | 3 | 0.15% | 1.5% |
| `NDX` | `QQQ` (proxy) | equity | +1 | 2 | 0.15% | 1.8% |
| `DJI` | `DIA` (proxy) | equity | +1 | 1 | 0.15% | 1.5% |
| `VIX` | `^VIX` | risk | −1 | 3 | 3% | 15% |
| `US10Y` | `^TNX` | risk | −1 | 1 | 1% | 4% |
| `DXY` | `DX-Y.NYB` | risk | −1 | 2 | 0.3% | 1.2% |

- output vocabulary: `MarketStatusLabel = 'UPTREND' | 'WEAK' | 'SIDEWAYS'` — **ห้ามมีค่าที่สี่**
- `MarketRegime = 'RISK_ON' | 'NEUTRAL' | 'RISK_OFF'` อ่านจาก risk group เท่านั้น
- score มีจริงข้างใน แต่ **ห้ามขึ้นจอ** (คอมเมนต์หัวไฟล์ config)
- availability gate: ขาด equity input ตัวใดตัวหนึ่ง → `status: 'insufficient'` · ขาด `VIX` หรือ
  `US10Y` → ตัด regime ทิ้ง แต่ label ยังพิมพ์
- ทุกอินพุตอ่านผ่าน `getYahooChartProvider().getQuote(symbol)` ตัวเดียว (service.ts `readInput`)

### Trend

| ระดับ | ไฟล์ |
|---|---|
| engine | src/lib/analytics/market-signal/{calculations,service,types}.ts |
| entitlement wrapper | src/lib/analytics/market-signal/entitled-service.ts |
| history | src/lib/analytics/market-signal/{history,history-repository}.ts |
| watchlist view | src/lib/watchlist/trend.ts:218 `watchlistTrend(result)` → `WatchlistTrend` |
| bands | src/lib/watchlist/trend.ts:77 `WATCHLIST_TREND_BANDS` · คำไทย `WATCHLIST_TREND_WORD` |

`watchlistTrend` รายงาน `demoted` เมื่อหลักฐานไม่พอถือ label — ใช้โดย detector `trend-change`

### Volume

**ไม่มี service เฉพาะสำหรับ volume** — มาจากสองที่:

- `NormalizedCandle.volume` (src/lib/market-data/candles/contracts.ts:30) ผ่าน candle service
- `IndustryQuoteCandidate.volume` (src/lib/overview/industry-ranking.ts:22) ที่ overview
  แนบมากับราคา
- detector `volume-surge` ใน src/lib/watchlist/what-changed.ts ใช้ `DailyBar.volume` เทียบ
  **median 20 วัน** (ต้องครบ 20 เท่านั้น ไม่ใช่ "เท่าที่มี")

### News

| ชิ้น | ไฟล์ |
|---|---|
| provider (NewsAPI) | src/lib/news/provider.ts:170 `getNewsProvider()` |
| route handler | app/api/news/route.ts → src/lib/news/route.ts:44 `handleNewsRequest` |
| market-wide / personalized | src/lib/news/{market-wide,personalized,scope}.ts |
| เลือก/จัดอันดับ | src/lib/news/feed.ts (`NEWS_PREVIEW_COUNT = 5`, `NEWS_MAX_COUNT = 10`) |
| สรุปด้วย Gemini | src/lib/news/{summarizer,summary-store,summary-feed}.ts |
| endpoint สรุป | app/api/news/summary/[symbol]/route.ts · app/api/news/market-summary/route.ts |

### Earnings

[src/lib/analytics/earnings/service.ts](../src/lib/analytics/earnings/service.ts)

- provider ลำดับ: Alpha Vantage (primary — ให้ pre/post market ด้วย) → Financial Modeling Prep
- last-known-good อยู่ทั้ง**หน้า**และ**หลัง** provider chain: ตาราง
  `public.analytics_earnings_calendar_lkg`
- cache policy: `freshMs 12h` / `staleMs 7d` / `errorMs 10m`
- type: `EarningsSchedule` = available | unavailable (มี `EarningsUnavailableReason` 6 ค่า)
  **ไม่เคยเดาวันที่** — ไม่มีนัดหมาย = `no-scheduled-report`
- ฝั่ง overview: src/lib/upcoming/service.ts — `UPCOMING_EARNINGS_SYMBOL_LIMIT = 8`

### Breadth

[src/lib/overview/market-breadth.ts](../src/lib/overview/market-breadth.ts)

- provider: **Alpaca** `https://data.alpaca.markets/v2/stocks/snapshots`, `feed=delayed_sip`
- batching: `BATCH_SIZE 200`, `CONCURRENCY 3`, `REQUEST_TIMEOUT_MS 12_000`,
  `DEADLINE_MS 25_000` → ~22 requests ที่ 4,285 symbols
- universe: src/lib/overview/market-breadth-universe.ts — หุ้นสามัญ NASDAQ / NYSE /
  NYSE American จาก SEC catalogue เท่านั้น
- นับจาก `dailyBar.c` vs `prevDailyBar.c` เท่านั้น
- `MIN_USABLE_BREADTH = 800` → ต่ำกว่านี้ `status: 'partial'`
- **`aboveEma20Percent` ถูก hardcode เป็น `null` เสมอ** (market-breadth.ts:203 และ
  industry-ranking.ts:105) — ไม่มีการคำนวณ moving average ใน breadth path เลย

### API routes ที่เกี่ยวข้อง

| Route | ไฟล์ |
|---|---|
| `GET /api/market/overview` | app/api/market/overview/route.ts |
| `GET /api/market/overview/section?section=market\|industries\|watchlist\|breadth` | app/api/market/overview/section/route.ts |
| `GET /api/market/quote/[symbol]` | app/api/market/quote/[symbol]/route.ts |
| `GET /api/market/candles` · `/chart` · `/chart-levels` | app/api/market/… |
| `GET /api/market/history/[symbol]` · `/history/intraday` | app/api/market/history/… |
| `GET /api/market/session/[symbol]` | app/api/market/session/[symbol]/route.ts |
| `GET /api/market/fx` | app/api/market/fx/route.ts |
| `GET /api/news` · `/api/news/summary/[symbol]` · `/api/news/market-summary` | app/api/news/… |
| `GET /api/cron/daily-snapshot` (`runtime nodejs`, `maxDuration 60`) | app/api/cron/daily-snapshot/route.ts |
| `GET /api/cron/alerts` (`runtime nodejs`, `maxDuration 60`) | app/api/cron/alerts/route.ts |
| `POST /api/alerts/evaluate` | app/api/alerts/evaluate/route.ts |

### Server actions

`app/watchlist/actions.ts` · `app/alerts/actions.ts` · `app/portfolio/*.ts` ·
`app/settings/actions.ts` · `app/onboarding/actions.ts` · `app/notifications/actions.ts`

---

## 1.3 Cache layer

### 1) `SharedRequestCache` — process-local, เป็นตัวหลัก

[src/lib/shared-request-cache.ts](../src/lib/shared-request-cache.ts) · `Map` ใน memory ของ instance
เดียว มี in-flight dedupe และ 3 สถานะ: `fresh` / `cache` / `stale`
Policy = `{ freshMs, staleMs, errorMs }` (`errorMs` = negative-cache ของ error)

| key pattern | freshMs | staleMs | errorMs | ไฟล์ |
|---|---|---|---|---|
| `overview-price:{SYMBOL}` | 30s | 5m | 30s | overview/service.ts:236,280,328 |
| `industry-chart:{slug}:{timeframe}` | 60s (1D) / 6h | 24h | 30s | overview/service.ts:845 |
| `market-quote:yahoo:{symbol}:{tradingDay\|latest}` | 60s | 24h | 30s | market-data/quote-service.ts:77 |
| `market-gateway:{provider}:quote:{canonical}:{provider}:{date}` | 15s | 5m | 30s | gateway/service.ts:38 |
| `market-gateway:{provider}:session:{mic\|exchange}` | 30s | 5m | 30s | gateway/service.ts:50 |
| `intraday:{provider}:{symbol}:{interval}:{range}:{session}` | 60s | 15m | 30s | intraday/service.ts:47 |
| `options:{provider}:{symbol}:{expiration\|all}` | 60s | 15m | 30s | options/service.ts:105 |
| `options-market-data:{source}:{SYMBOL}:{expiration}` | 60s | 15m | 30s | options/service.ts:149 |
| `earnings:{provider}:{symbol}` | 12h | 7d | 10m | earnings/service.ts:171 |
| `analyst-target:v2:{symbol}` | 24h | 24h | 5m | analyst-target/service.ts:246 |
| candles (historical) | 6h | 7d | 30s | candles/service.ts:17 |
| company profile | 24h | 7d | 1s | profile-service.ts:7 |
| FX | 15m | 7d | — | fx/service.ts:8 |
| options signal (server) | 15m | 2h | 60s | options-signal/server-signal.ts:90 |
| company profile translation | 30d | 90d | — | translation/company-profile.ts:242 |

### 2) `LastGoodSnapshotCoordinator` — สำหรับงานหนักที่ต้อง warm เบื้องหลัง

[src/lib/overview/industry-snapshot.ts](../src/lib/overview/industry-snapshot.ts)
อ่านทันที (`read`) แล้ว refresh ใน `after()` — คืน `state: 'refreshing'` แทนที่จะบล็อก

| ผู้ใช้ | key | freshMs | staleMs |
|---|---|---|---|
| industry dashboard | ภายใน service.ts | 2m | 10m |
| market breadth | `regular:{tradingDate}` (market-breadth.ts `snapshotKey`) | 2m | 15m |

### 3) Redis (Upstash) — **มีที่เดียว: news summary**

[src/lib/news/cache-client.ts](../src/lib/news/cache-client.ts) — `getNewsCacheClient()` คืน `null` ได้
และ `null` เป็นสถานะที่รองรับ (ไม่มี Redis = ไม่มีการ์ดสรุป AI, ข่าวยังทำงาน)

- env: `KV_REST_API_URL` / `KV_REST_API_TOKEN` (Vercel) → fallback
  `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`
- interface แคบไว้ 4 คำสั่ง: `get` / `set` / `setIfAbsent` (`SET NX EX`) / `del`

| key | TTL | ที่มา |
|---|---|---|
| `news:summary:{SYMBOL}` | `NEWS_SUMMARY_TTL_SECONDS` = 7 วัน | summary-store.ts `newsSummaryKey` |
| `news:lock:{SYMBOL}` | `NEWS_SUMMARY_LOCK_TTL_SECONDS` = 90s | summary-store.ts `newsSummaryLockKey` |
| `news:summary:market` | 7 วัน | `MARKET_NEWS_SUMMARY_SCOPE` |
| `news:lock:market` | 90s | `MARKET_NEWS_SUMMARY_SCOPE` |

freshness ของ summary **ไม่ได้ตัดสินด้วยเวลา** แต่ด้วย fingerprint = sha1 ของ
`url@publishedAt` ของ 3 ข่าวบนสุด (`NEWS_SUMMARY_FINGERPRINT_ARTICLES = 3`)
lock ไม่ถูกลบเมื่อสำเร็จ → เป็น cooldown 90 วินาทีในตัว

### 4) HTTP cache

route ตลาด/overview/quote ทุกตัวตั้ง `Cache-Control: private, no-store` — ไม่มี CDN cache
ไม่มี `revalidate` / ISR ในเส้นทางข้อมูลตลาด

### 5) Rate limit

[src/lib/market-data/api-rate-limit.ts](../src/lib/market-data/api-rate-limit.ts) —
`checkMarketDataRateLimit` bucket ใน memory, default **60 req / 60s ต่อ IP ต่อ operation**
(อีกชุดหนึ่งสำหรับ analytics: src/lib/analytics/rate-limit.ts)

---

## 1.4 Design system ที่มีจริง

### Token สี

โครงสร้าง: [app/globals.css](../app/globals.css) import ธีมทั้ง 5 × 2 appearance แล้วตามด้วย
[src/themes/foundation.css](../src/themes/foundation.css)

```
src/themes/{portkheaw,bitswap,dokturek,cosmic,orchid}/{dark,light}.css   ← palette ต่อธีม
src/themes/portkheaw/auth.css                                            ← theme-independent
src/themes/foundation.css                                                ← radius / spacing / .panel / derived
```

selector: `html[data-theme="portkheaw"][data-appearance="dark"]` (+ `:not([data-appearance])`
= dark เป็น default ก่อน bootstrap script ทำงาน)

**semantic token ที่ทุกธีมต้องมี** (ตัวอย่างค่าจาก portkheaw/dark):

| กลุ่ม | token |
|---|---|
| พื้น | `--bg` `--surface` `--surface-elevated` `--surface-hover` `--surface-selected` |
| ตัวอักษร | `--text` `--text-secondary` `--text-muted` |
| เส้น | `--border` `--border-strong` · derived `--hairline` |
| accent | `--accent` `--accent-hover` `--accent-active` `--accent-soft` `--accent-fg` |
| สถานะราคา | `--positive` (#10B981) `--negative` (#EF4444) `--warning` (#F59E0B) `--caution` (#F97316) `--info` (#3B82F6) |
| session | `--session-pre` `--session-regular` `--session-post` `--session-closed` `--session-event` |
| plan/role | `--plan-basic` `--plan-pro` `--plan-elite` `--plan-elite-trial` `--role-admin` (+ `-text/-border/-bg`) |
| chart | `--chart-bg` `--chart-grid` `--chart-axis` |
| brand | `--brand-green` `--brand-green-deep` `--brand-mark-bg` |
| อื่น | `--focus-ring` `--input-bg` `--overlay` `--shadow` `--dock-bg` `--dock-border` `--dock-shadow` |

derived ใน foundation.css (`color-mix`): `--positive-soft/-line`, `--negative-soft/-line`,
`--warning-soft/-line`, `--caution-soft/-line`, `--info-soft/-line`, `--hairline`

> `--session-*` ตั้งใจไม่ใช้ `--positive/--negative` — ไอคอน "ตลาดเปิด" สีเขียวข้างราคาสีแดง
> จะอ่านเป็นสัญญาณราคาที่สอง (คอมเมนต์ในไฟล์ธีม)

### StatusLabel

[src/lib/presentation/status.ts](../src/lib/presentation/status.ts) +
[src/components/ui/StatusLabel.tsx](../src/components/ui/StatusLabel.tsx)

```ts
type StatusLevel = 'good' | 'neutral' | 'weak' | 'bad' | 'unknown';
```

| level | emoji | token | fallbackLabel |
|---|---|---|---|
| `good` | 🟢 | `--positive` | แข็งแรง |
| `neutral` | 🟡 | `--warning` | ทรงตัว |
| `weak` | 🟠 | `--caution` | อ่อนแรง |
| `bad` | 🔴 | `--negative` | อ่อนแอ |
| `unknown` | ⚪ | `--text-muted` | ยังไม่มีข้อมูล |

กฎที่ module นี้มีไว้บังคับ: **ข้อมูลหายห้ามอ่านเป็นข่าวดี** — mapper ทุกตัวคืน `unknown`
ไม่ใช่ `neutral` · `STATUS_RANK` มีไว้ให้ test พิสูจน์ว่า `unknown` ไม่เคยชนะ `neutral`

mapper ที่มีอยู่: `statusFromScore(score, thresholds)` · `statusFromChangePercent` ·
`statusFromSignedValue` · `statusFromRewardRisk` · ตาราง `MARKET_SIGNAL_STATUS` ·
`OPTIONS_SIGNAL_STATUS`

component: `<StatusLabel level label />` (emoji `aria-hidden`, สีเท่านั้นที่เปลี่ยนตาม level —
ไม่เปลี่ยน weight/size) · `<StatusRow name level label note />` = "แนวโน้ม · 🟢 ขาขึ้นแรง"

### Currency / number formatter

| ฟังก์ชัน | ไฟล์ |
|---|---|
| `convertUsd(value, currency, usdThbRate)` | src/lib/portfolio/presentation.ts:5 |
| `formatPortfolioMoney(valueUsd, currency, rate, visible)` | :11 |
| `signedMoney(...)` | :18 |
| `signedPercent(value, visible)` | :24 |
| `gainColor` / `portfolioReturnTone` / `portfolioReturnToneClass` | :30,44,49 |
| fixed-point math (`bigint`) | src/lib/money/fixed.ts — `fixed`, `fixedMultiply`, `fixedDivide`, `fixedToNumber`, `fixedToString`, `fixedPercent` |
| mask | `SENSITIVE_VALUE_MASK` ใน src/lib/privacy.ts |

### Timestamp util

[src/lib/presentation/datetime.ts](../src/lib/presentation/datetime.ts) — **ตัวเดียวของทั้งเว็บ**

```ts
THAI_LOCALE = 'th-TH'
BANGKOK_TIME_ZONE = 'Asia/Bangkok'
formatBangkokDateTime(value, { withSeconds })
formatBangkokDateTimeCE(value, { withSeconds })   // บังคับ ค.ศ. (th-TH default เป็น พ.ศ.)
formatThaiDateOnly(value)
formatMarketDataAsOf(value, { dateOnly, withSeconds })   // → "ข้อมูล ณ …"
isDateOnlyValue(value)
isStaleAt(asOf, maxAgeSeconds, referenceTime)            // floor 300s
```

มี eslint rule กันการอ่านนาฬิกาเครื่องผู้ใช้: [eslint-rules/no-host-local-time.mjs](../eslint-rules/no-host-local-time.mjs)

### Spacing / radius / layout scale

[src/themes/foundation.css](../src/themes/foundation.css)

| token | ค่า |
|---|---|
| `--radius-mark` | 4px |
| `--radius-control` | 10px |
| `--radius-panel` | 14px |
| `--radius-hero` | 22px |
| `--stack-hero` | 1.75rem → 2.25rem (sm) → 2.75rem (lg) |
| `--stack-section` | 1.25rem → 1.5rem (sm) |
| `--stack-tight` | 0.625rem |
| `--page-gutter` | 0.875rem → 1.25rem (sm) → 1.5rem (lg) |

class ที่ใช้ได้เลย: `.panel` `.panel-hero` `.panel-quiet` `.inset` · `.section-head`
(`__name` `__rule` `__action`) `.section-eyebrow` · `.figure` `.figure-hero` `.figure-lead`
`.figure-data` `.figure-label` · `.data-strip` (`--1` `--3` `--4`, `__cell`) ·
`.page-stack` (`> * + *` = `--stack-section`) · `.bleed-mobile` · `.rule` `.rule-bleed`

### อื่น ๆ ที่เป็น primitive แล้ว

| ของ | ไฟล์ |
|---|---|
| `DataState` 4 สถานะ + `StaleNote` + `reportDataError` | src/components/ui/DataState.tsx |
| `DataSourceBadge` / `DataProvenance` | src/components/ui/ · src/components/market-data/ |
| `InfoHint` / `DetailPopover` / `Drawer` / `EmptyState` / `KheawLoader` | src/components/ui/ |
| คำต้องห้าม `CARD_MUST_NOT_SAY` / `NEVER_SAY` | src/lib/presentation/banned-copy.ts + eslint-rules/no-banned-copy.mjs |
| คำเฉพาะการ์ด market-signal | eslint-rules/no-unsourced-frame-word.mjs |

---

## 1.5 Market session / timezone utils

| ไฟล์ | ให้อะไร |
|---|---|
| [src/lib/market-data/session.ts](../src/lib/market-data/session.ts) | `US_EQUITY_TIMEZONE = 'America/New_York'` · `zonedParts(date, tz)` (cached `Intl.DateTimeFormat`) · `zonedLocalToUtc(value, tz)` · `exchangeSessionDate(timestamp, tz)` · `EquitySessionType = 'premarket'\|'regular'\|'afterhours'` |
| [src/lib/market-data/market-session.ts](../src/lib/market-data/market-session.ts) | `MarketSession = 'PRE_MARKET'\|'OPEN'\|'AFTER_HOURS'\|'CLOSED'` · `marketSession(now)` · `lastCompletedSessionDate(now)` · `previousTradingDate(date)` · `isTradingDate(date)` · `unscheduledUsClosures()` · `unscheduledClosureReason(date)` |
| [src/lib/market-data/current-session.ts](../src/lib/market-data/current-session.ts) | `resolveCurrentMarketSession({ now, holidays })` → `MarketSessionPhase = 'PRE'\|'REGULAR'\|'POST'\|'CLOSED'` · `canonicalRegularTradingDateAt(now)` |
| [src/lib/market-data/us-market-calendar.ts](../src/lib/market-data/us-market-calendar.ts) | `isUsTradingDay` · `isUsMarketEarlyClose` · `usSessionCloseMinute` |
| [src/lib/market-data/us-market-closures.json](../src/lib/market-data/us-market-closures.json) | ปิดไม่ตามกำหนด (ข้อมูลที่คำนวณไม่ได้) |
| [src/lib/market-data/commodity-session.ts](../src/lib/market-data/commodity-session.ts) | นาฬิกา CME Globex |
| [src/lib/market-data/extended-hours.ts](../src/lib/market-data/extended-hours.ts) | pre/post |
| [src/lib/portfolio/day-change.ts](../src/lib/portfolio/day-change.ts) | `resolveDayChangeBasis({ session, price, previousClose, snapshot })` — **กฎเดียวของทั้งเว็บ** ว่า "วันนี้เปลี่ยนเท่าไร" เทียบราคาคู่ไหน |
| [src/hooks/useExchangeClock.ts](../src/hooks/useExchangeClock.ts) | นาฬิกาตลาดฝั่ง client |

**ICT (Asia/Bangkok)** อยู่ที่เดียว: `BANGKOK_TIME_ZONE` ใน src/lib/presentation/datetime.ts
`marketSession()` ไม่แตะโซนเวลาผู้อ่านเลย — โทรศัพท์ที่ตั้ง Asia/Bangkok กับ server UTC
ต้องได้ session เดียวกัน

**cron**: [vercel.json](../vercel.json) มี job เดียว `/api/cron/daily-snapshot` ที่ `10 21 * * 1-5`
(21:10 UTC — เวลาเดียวที่พ้นระฆังปิดทั้ง EST และ EDT ตามที่ route อธิบายไว้)

---

## 1.6 ตาราง Supabase ที่เกี่ยวข้อง

type ทั้งหมด: [src/types/database.ts](../src/types/database.ts)

| ตาราง | ใช้ทำอะไรกับ Overview | RLS model |
|---|---|---|
| `user_settings` | preference ของผู้อ่าน + `overview_watchlist_id` + 4 คอลัมน์ onboarding | ผูก `user_id` |
| `watchlists` | รายการเฝ้าดู (หลายรายการต่อบัญชี หลัง 202608290003) | ผูก `user_id` |
| `watchlist_items` | สัญลักษณ์ในรายการ + `pinned` | สืบทอดจาก parent |
| `daily_snapshot` | ราคาปิดที่ capture ไว้ (symbol ยาวได้ 32 ตัวเพื่อรองรับ OCC) | service-role only |
| `label_history` | ประวัติ label ของ engine ที่ใช้ hold rule ร่วมกัน `scope in ('market-status','market-signal')`, key `'US'` สำหรับ market-status | service-role only |
| `market_signal_history` | reading ของ market signal ต่อ symbol ต่อ `as_of` | service-role only |
| `options_signal_history` | เหมือนกันฝั่ง options | service-role only |
| `analytics_earnings_calendar_lkg` | วันประกาศงบ last-known-good | — |
| `price_alerts` | alert ที่ผู้อ่านตั้ง | ผูก `user_id` |
| `notifications` / `queued_notifications` | ผลของ alert | ผูก `user_id` |
| `alert_evaluation_runs` | log การประเมิน | — |
| `push_subscriptions` / `push_deliveries` | web push | ผูก `user_id` |
| `market_instruments` | catalogue + universe ของ breadth/industry | — |
| `market_fx_rates` | USD/THB | — |
| `portfolios` / `portfolio_transactions` / `portfolio_option_*` | การ์ดพอร์ต | ผูก `user_id` |

RPC ที่เกี่ยวข้อง (จาก database.ts): `get_or_create_default_watchlist`, `create_watchlist`,
`rename_watchlist`, `delete_watchlist`, `set_overview_watchlist`, `set_watchlist_item_pinned`

### Migration

- **ล่าสุดในโฟลเดอร์**: `supabase/migrations/202608290003_multi_watchlists.sql`
- migration ที่ยังมีหัวข้อ **`NOT YET APPLIED`** อยู่ในไฟล์:
  - `202608180001_market_signal_history.sql`
  - `202608210001_market_signal_history_raw_state.sql`
  - `202608290001_daily_snapshot.sql`
  - `202608290002_label_history.sql`
  - `202608290003_multi_watchlists.sql`
- เครื่องมือ: `npm run db:apply` (scripts/apply-migrations.ts) · `npm run db:schema-diff`
- คำเตือนที่เขียนอยู่ใน `202608290003`: การถอนต้องทำ **หลัง** ยืนยันว่าไม่มีบัญชีไหนมี
  watchlist เกินหนึ่ง และต้องกู้ `get_or_create_default_watchlist` / `handle_new_user`
  จาก `202607180003` / `202608030002` ตามลำดับ

---

# §2 CONTRACT

type ทั้งหมดในส่วนนี้ **ยังไม่มีในโค้ด** และในเอกสารนี้ยังไม่ implement logic
ทุกอันที่ชื่อชนกับของเดิมมีบรรทัด **⚠ ชนกับ** กำกับ และมีรายละเอียดใน §3

**namespace ที่เสนอ**: `src/lib/market-overview/` (ไดเรกทอรีใหม่)
เหตุผล: `src/lib/overview/` เป็นของหน้า Overview เดิม (`OverviewPrice`, `OverviewChange`,
`MarketBreadth`) และ `src/lib/market-data/` เป็นชั้น provider — ยัดของใหม่ลงสองที่นี้จะทำให้
ชื่อชนกันทันที (ดู §3.3)

---

## 2.1 `MarketSnapshot` — `src/lib/market-overview/types.ts`

⚠ ชนกับ `CanonicalMarketSnapshot` และ `SnapshotQuoteInput` ใน
[src/lib/market-data/market-snapshot.ts](../src/lib/market-data/market-snapshot.ts) — คนละเรื่อง
(อันนั้นคือ "ราคาไหนคือราคาหลักของ symbol เดียว")

```ts
/** หกอินพุตที่ภาพรวมตลาดสร้างจาก ตรงกับ MarketStatusInputKey ใน src/config/market-status.ts */
export type MarketSnapshotKey = 'SPX' | 'NDX' | 'DJI' | 'VIX' | 'US10Y' | 'DXY';

export interface MarketSnapshotReading {
  key: MarketSnapshotKey;
  /** symbol ที่ quote จริง — SPY/QQQ/DIA เป็น proxy, ^VIX/^TNX/DX-Y.NYB เป็นตัวจริง */
  symbol: string;
  /** null = อ่านไม่ได้ ไม่ใช่ 0 */
  value: number | null;
  /** ราคาที่ value ถูกเทียบด้วย มาจาก resolveDayChangeBasis */
  comparisonClose: number | null;
  changePercent: number | null;
  /** ISO UTC ของ quote หรือ null */
  asOf: string | null;
}

export interface MarketSnapshot {
  readings: Readonly<Record<MarketSnapshotKey, MarketSnapshotReading>>;
  status: MarketStatus;
  /** null เมื่อ risk input ไม่ครบ ห้ามเดา */
  regime: MarketRegime | null;
  /** key ที่อ่านไม่ได้ เรียงตามลำดับในตาราง */
  missing: MarketSnapshotKey[];
  /** วันเทรดที่ปิดแล้วซึ่งตัวเลขชุดนี้เป็นของ null ระหว่างตลาดเปิด */
  sessionDate: string | null;
  session: import('@/src/lib/market-data/market-session').MarketSession;
  /** ISO UTC ของ instant ที่ประเมิน */
  evaluatedAt: string;
}
```

## 2.2 `MarketStatus` — `src/lib/market-overview/types.ts`

⚠ ชนกับ **สองตัว**: `MarketStatusLabel` (`'UPTREND' | 'WEAK' | 'SIDEWAYS'`) ใน
src/config/market-status.ts และ `MarketStatusState` ใน src/lib/market-data/types.ts
(สถานะเปิด/ปิดของตลาดจาก provider)

```ts
/**
 * คำตอบสามทางของภาพรวมตลาด
 *
 * ห้ามมีค่าที่สี่ และห้ามมี score ตัวเลขคู่กับมันบนจอ — ข้อห้ามเดียวกับที่เขียนไว้
 * หัวไฟล์ src/config/market-status.ts
 *
 * 'unclear' ไม่ใช่ 'ไม่มีข้อมูล' — ไม่มีข้อมูลคือ status: 'insufficient' ที่ระดับ
 * evaluation ไม่ใช่ค่าใน union นี้
 */
export type MarketStatus = 'up' | 'unclear' | 'down';
```

## 2.3 `MarketRegime` — `src/lib/market-overview/types.ts`

⚠ ชนกับ `MarketRegime` (`'RISK_ON' | 'NEUTRAL' | 'RISK_OFF'`) ใน src/config/market-status.ts —
**ชื่อเดียวกัน ค่าต่างกัน**

```ts
export type MarketRegime = 'risk_on' | 'neutral' | 'risk_off';
```

## 2.4 `BreadthSnapshot` — `src/lib/market-overview/types.ts`

⚠ ชนกับ `MarketBreadth` ใน src/lib/overview/types.ts (ซึ่งมี 19 field และไม่มี MA อะไรเลย)

```ts
export interface BreadthSnapshot {
  advancers: number;
  decliners: number;
  /**
   * % ของ universe ที่ราคาปิดเหนือ SMA50 / SMA200
   *
   * nullable และต้อง nullable: วันนี้ไม่มีแหล่งข้อมูลใน repo — Alpaca snapshot ที่
   * breadth ใช้คืนแค่ dailyBar / prevDailyBar และ aboveEma20Percent ถูก hardcode null
   * (market-breadth.ts:203) ดู §4 คำถามข้อ 1
   */
  pctAboveMA50: number | null;
  pctAboveMA200: number | null;
  status: MarketStatus;
}
```

## 2.5 `ChangeEvent` — `src/lib/market-overview/change-event.ts`

⚠ ชนแนวคิดกับ `OverviewChange` (src/lib/overview/changes.ts:39) และ `WhatChangedItem`
(src/lib/watchlist/what-changed.ts) — ทั้งสองตัวมีอยู่แล้วและทำงานอยู่

```ts
export type ChangeEventKind =
  | 'price_move'
  | 'level_break'
  | 'volume'
  | 'trend_flip'
  | 'earnings'
  | 'news';

/**
 * ระดับความสำคัญ
 *
 * คำศัพท์ชุดนี้ยังไม่ถูกกำหนดโดยโค้ดเดิม — ของเดิมใช้ integer `importance` 0–5
 * (WHAT_CHANGED_DETECTORS) และ marketEventImportanceSchema ใช้ 'high'|'medium'|'low'
 * เลือกชุดหลังเพื่อให้ตรงกับ MarketEvent ในสัญญานี้ ดู §4 คำถามข้อ 4
 */
export type ChangeEventSeverity = 'high' | 'medium' | 'low';

export interface ChangeEvent {
  symbol: string;
  kind: ChangeEventKind;
  severity: ChangeEventSeverity;
  /**
   * ข้อความไทยหนึ่งบรรทัดที่ "พิมพ์ตัวเลขที่ทำให้มันเกิด" ตามกฎใน what-changed.ts
   * ไม่ใช่คำตัดสิน ไม่มีคำว่า ผิดปกติ (บังคับโดย eslint-rules/no-banned-copy.mjs)
   */
  valueText: string;
}
```

## 2.6 `MarketEvent` — `src/lib/market-overview/market-event.ts`

⚠ **ชนตรง ๆ**: `MarketEvent` มีอยู่แล้วที่ [src/lib/market-events/types.ts](../src/lib/market-events/types.ts)
เป็น zod schema และถูกใช้โดยการ์ด + หน้า `/market-events` ที่ทำงานอยู่
ของเดิมมี `id, kind, titleTh, shortTh, importance, source, referencePeriod, at, etDisplay`
— เป็น superset ของสัญญานี้ **ยกเว้น `affectedSymbols`**

```ts
export interface MarketEvent {
  /** ตรงกับ marketEventKindSchema เดิม: CPI PPI PCE NFP GDP FOMC JOBLESS_CLAIMS */
  code: import('@/src/lib/market-events/types').MarketEventKind;
  titleTh: string;
  /** ISO UTC ลงท้าย Z เท่านั้น — เดิมคือ field `at` ที่มี regex บังคับรูปแบบไว้แล้ว */
  startsAtUtc: string;
  importance: import('@/src/lib/market-events/types').MarketEventImportance;
  /**
   * symbol ที่รายการนี้ "เกี่ยวข้อง"
   *
   * ยังไม่มีที่มาในโค้ด — ปฏิทินเดิมเป็น macro ล้วนและตั้งใจไม่อ้างว่ารายการไหน
   * ขยับ symbol ไหน (คอมเมนต์ marketEventImportanceSchema) ดู §4 คำถามข้อ 5
   */
  affectedSymbols: string[];
}
```

## 2.7 `AlertRule` / `AlertHit` — `src/lib/alerts/rules.ts`

⚠ **ชนตรง ๆ**: `AlertRule` มีอยู่แล้วที่ [src/lib/alerts/logic.ts:4](../src/lib/alerts/logic.ts#L4)
= `{ condition: AlertCondition; targetValue: number }` และถูกใช้โดย `conditionMatches`
`AlertHit` **ยังไม่มี** — ของที่ใกล้ที่สุดคือ `EvaluationSummary` (evaluation.ts:7) ซึ่งเป็นสรุป
ของทั้งรอบ ไม่ใช่รายตัว

```ts
import type { AlertCondition } from '@/src/lib/alerts/types';

/**
 * กฎหนึ่งข้อ ตามที่ผู้อ่านตั้งไว้
 *
 * ต่อยอดจาก PriceAlert (src/lib/alerts/types.ts) ไม่ใช่ type ใหม่คนละสาย —
 * field ทุกตัวยกเว้น `enabled`/`cooldownMinutes` ตรงกับคอลัมน์ใน public.price_alerts
 */
export interface AlertRule {
  id: string;
  symbol: string;
  condition: AlertCondition;   // 'above' | 'below' | 'percent_change_up' | 'percent_change_down'
  targetValue: number;
  enabled: boolean;
  cooldownMinutes: number;
}

/** ครั้งที่กฎหนึ่งข้อเข้าเงื่อนไขจริงและผ่าน cooldown แล้ว */
export interface AlertHit {
  ruleId: string;
  symbol: string;
  /** ราคาที่ตรวจพบ ณ ตอนนั้น */
  observedPrice: number;
  observedChangePercent: number | null;
  /** ISO UTC ของ instant ที่ประเมิน = ค่าเดียวกับที่เขียนลง last_evaluated_at */
  observedAt: string;
  /** id ของแถวใน public.notifications ที่ถูกสร้าง null เมื่อยังไม่ได้ persist */
  notificationId: string | null;
}
```

---

# §3 REUSE MAP

## 3.1 ใช้ของเดิมได้ — ห้ามเขียนใหม่

| ต้องการ | ใช้ตัวนี้ | เหตุผล |
|---|---|---|
| 6 อินพุตตลาด + น้ำหนัก + dead band | `MARKET_STATUS_INPUTS` (src/config/market-status.ts) | polarity ถูก pin ด้วย test แล้ว เขียนใหม่ = เสี่ยงกลับด้าน VIX |
| รวมคะแนนโดยไม่ให้ข้อมูลหายทำให้คำตอบแรงขึ้น | `scoreInterval` / `intervalVerdict` (src/lib/analytics/bounded-score.ts) | เป็น fix ของบั๊ก JOBY ที่เขียนไว้ยาวใน rules.ts |
| กฎ "ต้องยืนกี่บาร์ถึงเปลี่ยนคำ" | `heldLabel` / `rawRunLength` (src/lib/analytics/persistence-hold.ts) | ใช้ร่วมกับ market-signal อยู่แล้ว การ์ดสองใบบนหน้าเดียวต้องตอบเหมือนกัน |
| เก็บ/อ่านประวัติ label | `label_history` + src/lib/analytics/label-history.ts (`LabelScope`, `MARKET_STATUS_KEY`) | ตารางเดียวรองรับหลาย engine อยู่แล้ว |
| "วันนี้เปลี่ยนเท่าไร" เทียบราคาคู่ไหน | `resolveDayChangeBasis` (src/lib/portfolio/day-change.ts) | market-status service เรียกตัวนี้แล้ว มีคอมเมนต์ห้ามทำซ้ำ |
| session / วันเทรด / โซนเวลา | src/lib/market-data/{session,market-session,current-session,us-market-calendar}.ts | มี facade อยู่แล้ว ห้ามสร้างปฏิทินวันหยุดชุดที่สอง |
| เวลาไทยบนจอ | src/lib/presentation/datetime.ts | มี eslint rule กันการอ่านนาฬิกาเครื่อง |
| สี/คำ/emoji ของสถานะ | `StatusLevel` + `StatusLabel` / `StatusRow` | 5 ระดับพอ ห้ามเพิ่มระดับที่หก |
| 4 data state | `DataState` / `StaleNote` | มีครบแล้ว |
| cache แบบ fresh/stale/error + dedupe | `SharedRequestCache` | ทุก service ใช้ตัวนี้ |
| cache แบบ read-now-warm-later | `LastGoodSnapshotCoordinator` | breadth + industry ใช้อยู่ |
| Redis (ถ้าจำเป็น) | `getNewsCacheClient()` interface 4 คำสั่ง | คืน `null` ได้และมี in-memory double สำหรับ test |
| วันประกาศงบ | `loadEarningsSchedule` + `analytics_earnings_calendar_lkg` | มี LKG หน้า-หลัง provider chain แล้ว |
| ปฏิทิน macro | src/lib/market-events/** (static JSON + zod) | ไม่มีค่า provider เลย |
| เงื่อนไข alert + cooldown | `conditionMatches` / `cooldownElapsed` / `describeCondition` (src/lib/alerts/logic.ts) | pure และมี test |
| ลำดับ section | `orderedOverviewSections` + `OVERVIEW_ORDER_V1/V2` | เพิ่ม key ใหม่ = เพิ่มใน union + สอง array |
| ธง feature | `featureFlagEnabled` (src/config/features.ts) | pattern default-OFF มีเอกสาร rollout แล้ว |
| เงิน/เปอร์เซ็นต์ | src/lib/portfolio/presentation.ts + src/lib/money/fixed.ts | |
| token สี/ระยะ | src/themes/foundation.css + palette ต่อธีม | ห้าม hardcode hex |

## 3.2 ต้องสร้างใหม่

| สิ่งที่ต้องสร้าง | ที่อยู่ที่เสนอ | ทำไมของเดิมไม่พอ |
|---|---|---|
| `MarketStatus` (`up`/`unclear`/`down`) + mapper จาก `MarketStatusLabel` | src/lib/market-overview/types.ts | ของเดิมเป็น `UPTREND`/`WEAK`/`SIDEWAYS` คนละ vocabulary |
| `MarketRegime` (lower snake) + mapper จาก `'RISK_ON'…` | src/lib/market-overview/types.ts | ชื่อชน ค่าต่าง |
| `MarketSnapshot` (รวม 6 reading + status + regime ในก้อนเดียว) | src/lib/market-overview/types.ts | ของเดิมคือ `MarketStatusEvaluation` ที่ผูกกับ `EvaluatedInput`/`MarketStatusInput` ทั้งตาราง |
| `BreadthSnapshot` แบบย่อ + `pctAboveMA50/200` | src/lib/market-overview/types.ts | `MarketBreadth` เดิมไม่มี MA และ `aboveEma20Percent` เป็น null ตายตัว |
| **ตัวคำนวณ % เหนือ SMA50 / SMA200** | ยังไม่มีที่ — ขึ้นกับคำตอบ §4 ข้อ 1 | ไม่มีแหล่งข้อมูลใน repo |
| `ChangeEvent` + `ChangeEventKind` 6 ค่า | src/lib/market-overview/change-event.ts | `OverviewChange` มีกฎเดียว (price move ≥ 4%), `WhatChangedItem` มี 6 detector แต่ id ไม่ตรงกับ kind ที่ขอ |
| adapter `WhatChangedItem` → `ChangeEvent` | src/lib/market-overview/change-event.ts | mapping ระหว่างสอง vocabulary (ดู §3.3) |
| `MarketEvent.affectedSymbols` | ต่อจาก src/lib/market-events/types.ts | ปฏิทินเดิมตั้งใจไม่อ้างความเกี่ยวข้องกับ symbol |
| `AlertHit` | src/lib/alerts/rules.ts | ของเดิมมีแค่ `EvaluationSummary` ระดับรอบ |
| `AlertRule` แบบเต็ม (มี id/symbol/enabled/cooldown) | src/lib/alerts/rules.ts | ของเดิมมี 2 field และถูกใช้เป็น argument ของ `conditionMatches` |

## 3.3 จุดเสี่ยงซ้ำซ้อน — อ่านก่อนเขียนโค้ด

**1. ชื่อ type ชนตรง ๆ 4 คู่**

| ชื่อ | ของเดิม | ที่เสนอ | ผล |
|---|---|---|---|
| `MarketRegime` | src/config/market-status.ts (`'RISK_ON'…`) | §2.3 (`'risk_on'…`) | import ผิดตัวได้เงียบ ๆ เพราะ TS ไม่เตือนชื่อซ้ำข้าม module |
| `MarketEvent` | src/lib/market-events/types.ts (9 field, zod) | §2.6 (5 field) | อันเดิมใช้งานอยู่จริงบนการ์ด + หน้า `/market-events` |
| `AlertRule` | src/lib/alerts/logic.ts (2 field) | §2.7 (6 field) | `conditionMatches(rule, quote)` รับของเดิม — ถ้าเปลี่ยน type เดิมต้องแก้ call site ทั้งหมด |
| `MarketSnapshot` | `CanonicalMarketSnapshot` ใน market-data/market-snapshot.ts | §2.1 | คนละ layer แต่ชื่อไฟล์ `market-snapshot.ts` จะซ้ำถ้าตั้งชื่อไฟล์ตามชื่อ type |

**ข้อเสนอ**: ให้ type ใหม่อยู่ใน `src/lib/market-overview/**` ทั้งหมด และ export ผ่าน barrel
เดียว เพื่อให้ทุก import อ่านออกว่ามาจากไหน · สำหรับ `MarketEvent` ควร **ต่อยอดของเดิม**
(เพิ่ม `affectedSymbols` เป็น optional) แทนการประกาศตัวใหม่ — ไม่งั้นการ์ดปฏิทินที่ทำงาน
อยู่จะมีสอง type คู่ขนาน

**2. "สิ่งที่เปลี่ยนไป" มีสองตัวอยู่แล้ว**

- `buildOverviewChanges` (src/lib/overview/changes.ts) — pure, กฎเดียว, ใช้บน Overview,
  ไม่ยิง request เพิ่ม
- `WHAT_CHANGED_DETECTORS` (src/lib/watchlist/what-changed.ts) — 6 detector, มี threshold
  ครบ, ใช้บนหน้า watchlist หลังธง `WHAT_CHANGED_CARD`

`ChangeEvent.kind` ที่ขอมา 6 ค่า **ไม่ตรง 1:1** กับ `WhatChangedDetectorId`:

| `ChangeEventKind` | detector ที่มีอยู่ |
|---|---|
| `price_move` | `return-sigma` + `gap` (สองตัว) |
| `level_break` | `level-break` ✔ |
| `volume` | `volume-surge` ✔ |
| `trend_flip` | `trend-change` ✔ |
| `earnings` | `earnings-soon` ✔ |
| `news` | **ไม่มี detector** |

การเพิ่ม detector ตัวที่สามคนละที่ = สิ่งที่หัวไฟล์ what-changed.ts เขียนห้ามไว้ตรง ๆ
("detector สะสมกันคนละไฟล์แล้วเถียงกันเรื่อง threshold")

**3. `MarketStatus` มีสามความหมายในโค้ดแล้ว**

- `MarketStatusLabel` = ทิศทางตลาด (UPTREND/WEAK/SIDEWAYS)
- `MarketStatusState` (src/lib/market-data/types.ts) = ตลาดเปิดหรือปิดจาก provider
- `MarketSession` = สี่สถานะของ session

การเพิ่ม `MarketStatus = 'up'|'unclear'|'down'` เป็นความหมายที่สี่ ต้องตัดสินก่อนว่าเป็น
**การแทนที่** `MarketStatusLabel` หรือเป็น **view type** ที่ map มาจากมัน (§4 ข้อ 3)

**4. `BreadthSnapshot` vs `MarketBreadth`**

`MarketBreadth` เดิมพก provenance ครบ (`universeCount`, `failedCount`, `staleCount`,
`coveragePercent`, `feed`, `source`, `universeDescription`, `status: ready|partial|stale`)
`BreadthSnapshot` ที่ขอมามี 5 field — ถ้าใช้ตัวใหม่แทนตัวเดิมบนจอ **provenance หายหมด**
และการ์ด breadth เดิมมีปุ่ม retry + ข้อมูลสุขภาพ (`breadth-data-health`) ที่พึ่งพา field เหล่านั้น

**5. ธง feature**

Phase 2 มีธงอยู่แล้ว 6 ตัวและมี rollout doc ที่ระบุลำดับเปิด — ถ้างานชุดนี้เพิ่มธงที่เจ็ด
ต้องเพิ่มในตารางของ [docs/phase2-rollout.md](phase2-rollout.md) ด้วย ไม่งั้นเอกสารกับโค้ดแยกกัน

**6. cache**

ถ้า Phase 2 ต้องการ cache ข้าม instance (breadth MA, event calendar) ตอนนี้ Redis
**ใช้อยู่ที่เดียวคือ news summary** และ `getNewsCacheClient()` มีชื่อผูกกับ news — การนำไป
ใช้กับ domain อื่นควรแยก client factory ก่อน ไม่ใช่เรียกชื่อ `news` จาก market code

**7. migration**

migration ห้าไฟล์ล่าสุดยังมีหัวข้อ `NOT YET APPLIED` — ถ้า Phase 2 เพิ่มตาราง ต้องรู้ก่อนว่า
ห้าไฟล์นั้นจะถูก apply เมื่อไร ไม่งั้นลำดับ migration บนเครื่องกับบน production ต่างกัน

---

# §4 OPEN QUESTIONS

คำถามทุกข้อในนี้ **ตอบจากโค้ดไม่ได้** ต้องการคำตอบจากคนหรือจากเอกสาร provider

### ข้อมูล / provider

1. **% เหนือ SMA50 / SMA200 จะเอามาจากไหน**
   `BreadthSnapshot.pctAboveMA50/200` ไม่มีแหล่งใน repo เลย — Alpaca snapshot ที่ breadth
   ใช้คืนแค่ `dailyBar` / `prevDailyBar` และ `aboveEma20Percent` ถูกตั้งเป็น `null` ตายตัวทั้ง
   ใน market-breadth.ts:203 และ industry-ranking.ts:105
   ตัวเลือกที่เห็นจากโค้ด: (ก) ดึง daily bar ย้อนหลัง 200 วันของ universe ~4,285 ตัว —
   ไม่มี endpoint ไหนในโค้ดที่ทำ batch แบบนั้น (ข) หา provider ที่ให้ breadth สำเร็จรูป
   (ค) ลด universe **คำถาม**: มี provider ตัวไหนใน plan ปัจจุบันที่ให้ breadth/MA ได้ และ
   quota เท่าไร

2. **quota ของ provider แต่ละเจ้าเป็นเท่าไร**
   ใน repo มีแค่ชื่อ env: `POLYGON_API_KEY`, `ALPACA_API_KEY_ID`/`ALPACA_API_SECRET_KEY`,
   `ALPHA_VANTAGE_API_KEY`, `FMP_API_KEY`, `FINNHUB_API_KEY`, `NEWS_API_KEY`,
   `GEMINI_API_KEY` — **ไม่มีที่ไหนบันทึกว่า tier ไหน / กี่ req ต่อนาที ต่อวัน**
   rate limit ที่มีเป็นของฝั่งเราเอง (60 req/min/IP) ไม่ใช่ของ provider
   **คำถาม**: quota จริงของแต่ละเจ้าเท่าไร และ Phase 2 มีงบเพิ่มไหม

3. **`MarketStatus = 'up'|'unclear'|'down'` แทนที่ หรืออยู่คู่กับ `MarketStatusLabel`**
   ถ้าแทนที่ ต้องแก้ `label_history` (คอลัมน์ `label` มี check constraint กับค่าเดิม),
   `MARKET_STATUS_BANDS`, การ์ด MarketStatusCard และ test ที่ pin ค่าไว้
   ถ้าอยู่คู่กัน ต้องมี mapper ทางเดียวและห้ามมีทางกลับ
   **คำถาม**: อันไหน

4. **`ChangeEvent.severity` ใช้คำศัพท์ชุดไหน**
   โค้ดเดิมมีสองแบบ: integer `importance` 0–5 (`WHAT_CHANGED_DETECTORS`) และ
   `'high'|'medium'|'low'` (`marketEventImportanceSchema`)
   §2.5 เลือกแบบหลังเพื่อให้ตรงกับ `MarketEvent` แต่นั่นเป็นการเลือกของเอกสารนี้ ไม่ใช่ข้อเท็จจริง
   **คำถาม**: ยืนยันชุดไหน และ mapping จาก importance 0–5 เป็นอย่างไร

5. **`MarketEvent.affectedSymbols` มาจากไหน**
   ปฏิทินปัจจุบันเป็น macro ล้วน และ `src/lib/market-events/types.ts` เขียนไว้ชัดว่า
   **ตั้งใจไม่อ้าง**ว่ารายการไหนขยับ symbol ไหน — หน้า detail แสดงแค่ "จำนวน" หุ้นที่ผู้อ่านถือ
   **คำถาม**: `affectedSymbols` คือ (ก) หุ้นที่ผู้อ่านถือ/เฝ้าดู ณ ตอนนั้น (ข) รายการที่บรรณาธิการ
   กำหนดไว้ล่วงหน้า หรือ (ค) ผลจากโมเดล — ถ้า (ค) จะขัดกับกฎที่เขียนไว้ในไฟล์เดิม

6. **earnings date: ตอนนี้จำกัด 8 symbol ต่อ render (`UPCOMING_EARNINGS_SYMBOL_LIMIT`)**
   ถ้า Phase 2 ต้องการปฏิทินงบของทั้ง watchlist ที่อาจมี 20+ symbol × หลาย list
   **คำถาม**: ยอมจ่าย provider call เพิ่ม หรือย้ายไปเป็น cron ที่เขียนลง
   `analytics_earnings_calendar_lkg` ล่วงหน้า

7. **`news` เป็น `ChangeEventKind` แต่ไม่มี detector**
   ยังไม่มีกฎไหนในโค้ดที่บอกว่า "ข่าวอะไรถือว่าเปลี่ยน"
   **คำถาม**: เกณฑ์คืออะไร (จำนวนข่าวใหม่ / แหล่งข่าว / ผลจาก Gemini summarizer) — ถ้าเป็น
   ผลจากโมเดล ต้องตัดสินก่อนว่าขัดกับกฎ "ทุกประโยคต้องพิมพ์ตัวเลขที่ทำให้มันเกิด" หรือไม่

### โครงสร้าง / operations

8. **migration ห้าไฟล์ที่ยังเป็น `NOT YET APPLIED` จะ apply เมื่อไร และใครเป็นคน apply**
   (`202608180001`, `202608210001`, `202608290001`, `202608290002`, `202608290003`)
   Phase 2 ที่ต้องเพิ่มตารางจะต่อท้ายไฟล์ไหน

9. **Redis มีจริงบน production หรือยัง**
   โค้ดรองรับกรณีไม่มี (`getNewsCacheClient()` คืน `null`) จึงบอกจากโค้ดไม่ได้ว่าตั้งค่าแล้ว
   **คำถาม**: `KV_REST_API_URL` ถูกตั้งบน production แล้วหรือไม่ และแผน quota เป็นอย่างไร
   — คำตอบเปลี่ยนว่า `BreadthSnapshot` / `MarketSnapshot` จะ cache ข้าม instance ได้ไหม

10. **Phase 2 จะใช้ธงใหม่ หรือใช้ 6 ธงเดิม**
    ถ้าใช้ธงใหม่ ต้องเพิ่มในตารางของ docs/phase2-rollout.md และกำหนดลำดับเปิด

11. **cron: ตอนนี้มี job เดียวใน vercel.json (`/api/cron/daily-snapshot` 21:10 UTC จ–ศ)**
    แต่มี route `/api/cron/alerts` ที่ **ไม่มี schedule ใน vercel.json**
    **คำถาม**: `/api/cron/alerts` ถูกเรียกจากที่อื่น (external scheduler) หรือยังไม่ได้ต่อ — และ
    ถ้า Phase 2 ต้องการ cron เพิ่ม (เช่น pre-compute breadth MA) จะไปอยู่ที่ Vercel cron
    หรือที่อื่น

12. **`PLAN.md` commit 4 เขียนว่าลำดับ Overview ใหม่ "ไม่มี VIX/US10Y (§3 Q2)"**
    แต่ `MarketSnapshot` ในสัญญานี้มีทั้งคู่เป็น field
    **คำถาม**: VIX / US10Y / DXY จะ **ขึ้นจอ** หรือเป็นแค่อินพุตที่คำนวณเบื้องหลังแล้วแสดง
    เฉพาะ `status` + `regime` เหมือนที่ MarketStatusCard ทำอยู่

13. **`BreadthSnapshot` 5 field จะแทน `MarketBreadth` 19 field บนจอ หรืออยู่คนละที่**
    ถ้าแทน การ์ด breadth เดิมจะเสีย provenance (`coveragePercent`, `staleCount`,
    `universeDescription`, ปุ่ม retry, `breadth-data-health`)
    **คำถาม**: อันไหน

---

# §5 บันทึกการตัดสินใจระหว่าง implement

ทุกข้อในนี้คือจุดที่ §2 กับคำสั่ง override ไม่ตรงกัน หรือโค้ดจริงบังคับให้เลือก
กฎที่ใช้ตัดสินทุกครั้งคือ **reuse ของเดิม + ไม่เพิ่ม provider call ใหม่**
เขียนไว้ที่นี่เพราะสัญญาที่ implement แล้วต่างจากสัญญาที่เขียนไว้ ต้องอ่านออกจากไฟล์เดียวกัน

## 5.1 ชื่อและที่อยู่ไฟล์

| §2 เขียนไว้ | ที่ทำจริง | เพราะ |
|---|---|---|
| `MarketSnapshot` / `MarketStatus` / `MarketRegime` / `BreadthSnapshot` / `ChangeEvent` / `MarketEvent` / `AlertRule` / `AlertHit` | `OvMarketSnapshot` / `OvMarketStatus` / `OvRegime` / `OvBreadthSnapshot` / `OvChangeEvent` / `OvMarketEvent` / `OvAlertRule` / `OvAlertHit` | override ข้อ 1 — prefix `Ov` ทุกตัว |
| `ChangeEvent` อยู่ใน `change-event.ts` | อยู่ใน `what-changed.ts` | ขอบเขตไฟล์ที่สั่งมาไม่มี `change-event.ts` ไฟล์ที่สั่งคือ `what-changed.ts` |
| `MarketSnapshot` มีเฉพาะ 6 reading + status | เพิ่ม `availability: 'available' \| 'insufficient'` แยกจาก `status` | "อ่านตลาดไม่ได้" กับ `unclear` เป็นคนละข้อเท็จจริง ถ้าใช้ field เดียวการ์ดจะวาดสองอย่างนี้เหมือนกัน |
| `MarketEvent.affectedSymbols` เป็น field ของ event | ไม่มีใน `OvMarketEvent` — อยู่ใน `OvEventRelevance` ที่ `event-relevance.ts` | override ข้อ 3 — mapping เป็น read-time ห้ามลง JSON |
| `AlertHit.notificationId` | **ตัดออก** | override ข้อ 4 — ไม่ persist ไม่ notify จึงไม่มีแถว notification ให้อ้างถึง field ที่ null ตลอดไปเป็น noise |

ไม่ได้สร้าง `src/lib/market-overview/index.ts` (barrel) เพราะไม่อยู่ในขอบเขตไฟล์ที่สั่ง
ทุก import ชี้โมดูลตรง ๆ

## 5.2 การชนกับของเดิม (override ข้อ 1)

- `types.ts` **ไม่ import ทั้งสี่ตัวที่ห้าม** และไม่มี mapper สองทางไปหาของเดิมเลย
- สิ่งที่ import จากของเดิมคือ **ค่า** และ type ที่ไม่ได้อยู่ในรายการห้าม:
  `MARKET_STATUS_INPUTS`, `MARKET_STATUS_BANDS`, `MARKET_STATUS_REGIME_BANDS`,
  `MARKET_STATUS_AVAILABILITY`, `MarketStatusInputKey`, `contributionOf`,
  `scoreInterval` / `intervalVerdict`, `resolveDayChangeBasis`, `marketSession`,
  `StatusLevel`, `statusFromSignedValue`, `signedPercent`, `SharedRequestCache`,
  `LastGoodSnapshotCoordinator`, `WhatChangedItem` / `WHAT_CHANGED_DETECTORS`,
  `MarketBreadth`
- **ไม่มีไฟล์เดิมไฟล์ไหนถูกแก้เพื่อเลี่ยงการชน** — ไฟล์เดิมที่แตะมีไฟล์เดียวคือ
  `src/config/features.ts` และแตะเพื่อเพิ่มธง ไม่ใช่เพื่อเลี่ยงชื่อชน
- `OvIndexKey` ถูก **pin กับ `MarketStatusInputKey` ตอน compile** ใน `indices.ts`
  (`_IndexKeysArePinned`) — ถ้ามีการเพิ่มหรือเปลี่ยนชื่ออินพุตที่ config build จะพัง

## 5.3 Breadth (override ข้อ 2)

- `pctAboveMA50` / `pctAboveMA200` ประกาศเป็น type `null` ตรง ๆ ไม่ใช่ `number | null`
  — "ตัดทิ้ง" กับ "null ถาวร" ตีความรวมกันแบบนี้: field ยังอยู่ให้ช่องว่างมองเห็นได้จาก type
  แต่ไม่มีใครใส่ตัวเลขลงไปได้แม้จะเผลอ
- ไม่มีการยิง historical bars เพิ่มแม้แต่คำขอเดียว — `breadth.ts` ไม่ import provider
  ไม่มี `fetch` ไม่มี `await` รับ `MarketBreadth` ที่ overview โหลดอยู่แล้วเข้ามาอย่างเดียว
- **ไม่ตั้ง floor ซ้ำ** — `MIN_USABLE_BREADTH = 800` ใน `market-breadth.ts` ไม่ได้ export
  และการประกาศเลขเดียวกันซ้ำคือความเสี่ยงดริฟต์ที่ §3 เตือนไว้เอง `ovBreadth` จึงคืน `null`
  เฉพาะเมื่อ `validCount <= 0` และปล่อยให้ `status: 'ready' | 'partial' | 'stale'`
  ของเดิมเป็นคนตัดสินว่ากลุ่มตัวอย่างบางเกินไปหรือยัง

## 5.4 Events (override ข้อ 3)

- **"ปฏิทิน 12 เดือน" ทำเป็นหน้าต่าง ไม่ใช่ข้อมูล** — `src/data/market-events-2026.json`
  ที่ ship อยู่มี 40 แถว ครอบคลุม ก.ย.–ธ.ค. 2026 เท่านั้น การเติมอีก 8 เดือนคือการเดา
  วันประกาศตัวเลขเศรษฐกิจ ซึ่งผิดกฎ "ห้ามเดา" และวันที่ผิดบนปฏิทินแย่กว่าวันที่ที่หายไป
  `ovEventWindow()` จึงคืน `coversThrough: false` + `lastDayKey` ให้การ์ดพูดความจริงได้
- `events.ts` **ไม่ import อะไรจาก `src/lib/market-events/`** เลย — parse ไฟล์ JSON เดิม
  ด้วย zod schema ของตัวเอง แล้ว map `kind → code`, `at → startsAtUtc` ทำให้ไม่มี type
  crossing และไม่มีไฟล์ข้อมูลใหม่
- **ICT ผ่าน `datetime.ts`**: `formatThaiDateOnly` / `formatBangkokDateTime` ใช้ตรง ๆ
  ส่วน day key `YYYY-MM-DD` ที่ `datetime.ts` ไม่มีให้ ถูกสร้างจาก `BANGKOK_TIME_ZONE`
  ที่ import มาจากไฟล์นั้น — สตริง `'Asia/Bangkok'` ไม่เคยถูกเขียนซ้ำในโมดูลนี้
  ทางเลือกอื่นคือแก้ `datetime.ts` เพิ่ม util ซึ่งเป็นการแตะไฟล์เดิมโดยไม่จำเป็น
- `countdown` นับเป็น **วันปฏิทินกรุงเทพ** ไม่ใช่ชั่วโมงที่ผ่านไป — ข่าว 19:30 คืนนี้กับ
  07:00 พรุ่งนี้ห่างกัน 11 ชั่วโมงครึ่งแต่เป็น "วันนี้" กับ "พรุ่งนี้"
- `OV_EVENT_SCOPE` ระบุว่าทั้ง 7 code เป็น `market-wide` — เป็นข้อเท็จจริงว่าตัวเลขพวกนี้
  วัดทั้งเศรษฐกิจ ไม่ใช่การอ้างว่ามันจะทำให้หุ้นตัวไหนขยับ `affectedSymbols` จึงเป็น
  "หุ้นของผู้อ่านเอง" เรียงตามตัวอักษร cap 8 ตัว พร้อม `total` — ไม่มี ranking ไม่มี sector map

## 5.5 Alerts (override ข้อ 4)

- **ไม่ reuse `conditionMatches` / `describeCondition`** จาก `src/lib/alerts/logic.ts`
  เพราะการเรียกมันต้องแปลง `OvAlertKind` → `AlertCondition` ซึ่งคือ crossing กับ
  `AlertRule` ของเดิมที่ override ข้อ 1 ห้ามไว้ตรง ๆ การเปรียบเทียบทั้งสี่แบบจึงเขียนเอง
  4 บรรทัดใน `evaluate.ts` — นี่เป็นจุดเดียวในงานทั้งชุดที่กติกา "ห้ามชน" ชนะกติกา "reuse"
  และเลือกตามข้อที่ระบุเจาะจงกว่า
- **ไม่มี cooldown** เพราะ cooldown คือความจำ ความจำคือการเขียน และการเขียนตอน GET
  คือสิ่งที่ override ข้อ 4 ห้าม กฎที่เข้าเงื่อนไขสองเรนเดอร์ติดกันก็รายงานสองครั้ง
  เหมือนราคาที่อยู่เหนือแนวต้านสองวันติดก็อยู่เหนือทั้งสองวัน
- `threshold` **เป็นบวกเสมอ** รวมถึง `percent_down` — ทิศทางอยู่ใน `kind` ไม่ใช่ในเครื่องหมาย
  (ทั้งใน type และใน check constraint ของ migration)
- **`alerts/repository.ts` รับ fetcher ไม่ใช่ `SupabaseClient`** เพราะ migration ยังไม่ถูก apply
  → `overview_alert_rules` ยังไม่อยู่ใน `src/types/database.ts` → `client.from('overview_alert_rules')`
  ไม่ผ่าน typecheck ทางเลือกอีกทางคือ cast ผ่าน `unknown` ซึ่งจะ compile ต่อไปตลอดกาล
  และอยู่ยืนยาวกว่าเหตุผลที่ใส่มันเข้าไป โมดูลนี้จึงถือ **รูปร่าง** (ชื่อตาราง คอลัมน์
  การ validate) และให้ call site ถือ round trip
- migration `202608300001_overview_alerts.sql` **เขียนแล้ว ไม่ได้รัน** ตามที่สั่ง ดู §5.7

## 5.6 Indices และธง

- `indices.ts` อ่าน 6 quote ผ่าน `getYahooChartProvider().getQuote` — **endpoint เดียวกับ
  ที่ `src/lib/market-status/service.ts` อ่านอยู่แล้ว** ไม่ใช่ provider ใหม่ ไม่ใช่สัญญาใหม่
  สิ่งที่เพิ่มคือ **cache** ซึ่งเส้นทางเดิมไม่มีเลย (`readInput` ยิงสดทุกเรนเดอร์ของทุกผู้อ่าน):
  ที่นี่มี `SharedRequestCache` 60 วินาที + `LastGoodSnapshotCoordinator` แบบเดียวกับ
  `market-breadth.ts` ผลคือเปิดธงแล้ว **จ่ายน้อยกว่า** การ์ดที่มีอยู่ ไม่ใช่มากกว่า
- `ovMarketStatus()` (pure) อยู่ใน `indices.ts` ไม่แยกไฟล์ เพราะขอบเขตไฟล์ที่สั่งไม่มี
  `status.ts` — แลกกับการที่มันอยู่ในโมดูล `server-only` จึงไม่มี unit test แยก
  (และไม่อยู่ในห้าตัวที่สั่งให้เทสต์)
- ธง 4 ตัว **default OFF ทั้งหมด** ต่อท้าย `src/config/features.ts`:
  `PHASE2_MARKET_SNAPSHOT` · `PHASE2_WHAT_CHANGED` · `PHASE2_EVENTS` · `PHASE2_ALERTS`
  หนึ่งตัวต่อหนึ่ง surface เพราะทั้งสี่มีต้นทุนต่างกันและจะเปิดคนละวัน
  มีตัวเดียวที่ใช้เงินคือ `PHASE2_MARKET_SNAPSHOT` และถูกอ่าน **ก่อน** สร้าง promise
  ทั้งสามทางเข้า · `src/config/phase2-flags.test.ts` ไม่กระทบ เพราะตรวจเฉพาะหกธงเดิมที่ระบุชื่อ

## 5.7 สิ่งที่ยังไม่ได้ทำ และทำไม

| ไม่ได้ทำ | เพราะ |
|---|---|
| ต่อสายเข้า `app/page.tsx` หรือหน้าไหนก็ตาม | สั่งห้ามแตะ `app/(pages)` — ทุกโมดูลจึงยังไม่มี caller |
| รัน migration | สั่งห้ามรันเอง · ต้อง apply `202608180001`, `202608210001`, `202608290001`, `202608290002`, `202608290003` ก่อนตามลำดับชื่อไฟล์ แล้วจึง `202608300001` จากนั้น regen `src/types/database.ts` แล้ว `alerts/repository.ts` จึงรับ client ตรง ๆ ได้ |
| แตะ `vercel.json` | สั่งห้าม และไม่มีอะไรต้องตั้งเวลา |
| detector สำหรับ `news` | ยังไม่มีเกณฑ์ที่วัดได้ (§4 ข้อ 7) — kind อยู่ใน union แต่ไม่มีอะไรผลิตมัน และ `what-changed.test.ts` pin ข้อนี้ไว้ |
| MA50 / MA200 | §4 ข้อ 1 ยังไม่มีคำตอบ และ override ข้อ 2 สั่งตัดทิ้งใน Phase 2 |

## 5.8 สถานะการตรวจ

`npx tsc --noEmit` ผ่าน · `npx eslint src/lib/market-overview src/config/features.ts` ผ่าน ·
`npx vitest run` ผ่านทั้งชุด **600 ไฟล์ / 7,207 เทสต์** (รวม 66 เทสต์ใหม่ใน 5 ไฟล์:
`regime` 12 · `breadth` 10 · `what-changed` 12 · `event-relevance` 12 · `events` 20)

---

# §6 สิ่งที่รอบถัดมาแก้ทับ §5

§5 บันทึกการตัดสินใจของรอบแรกไว้ตามที่ตัดสินตอนนั้น สองข้อในนั้น**ไม่จริงแล้ว**
และเขียนไว้ที่นี่แทนที่จะไปแก้ §5 เพราะเหตุผลเดิมยังอ่านได้และเป็นสิ่งที่ทำให้
เข้าใจว่าทำไมถึงเปลี่ยน

## 6.1 ปฏิทินไม่มีหน้าต่างแล้ว — ทับ §5.4

§5.4 เขียนว่า "ปฏิทิน 12 เดือนทำเป็นหน้าต่าง ไม่ใช่ข้อมูล" ซึ่งถูกในตอนนั้นและ
สร้างปัญหาที่มองไม่เห็น: **เพดานของปฏิทินอยู่ใน TypeScript** คนที่อยากเพิ่มวัน
ประกาศตัวเลขต้องไปหาและแก้ค่าคงที่ที่ไม่เกี่ยวกับสิ่งที่เขาทำ

ตอนนี้ `ovEventCalendar()` คืน **ทุกแถวในไฟล์ตั้งแต่วันนี้ไปข้างหน้า** ไม่มี
horizon ไม่มี `OV_EVENT_WINDOW_MONTHS` แถวปี 2030 ขึ้นทันทีที่อยู่ในไฟล์
`coversThrough` คำนวณจาก `lastDayKey` ของไฟล์เทียบกับวันนี้ ไม่มีเลขตายตัวใน
การเปรียบเทียบนั้นเลย

ไฟล์ข้อมูลย้ายจาก `src/data/market-events-2026.json` เป็น
`src/data/market-events.json` — ชื่อที่ผูกกับปีคือกับดักเดียวกันในอีกรูปแบบหนึ่ง
(แถวเดือน ม.ค. 2027 ในไฟล์ชื่อ 2026) ทั้ง `market-overview/events.ts` และ
`market-events/calendar.ts` อ่านไฟล์เดียวกัน แก้ครั้งเดียวขึ้นทั้งสองจอ
schema ของแถวอยู่ใน `src/data/README.md`

`ovEventWindow` ยังคง export อยู่เป็น alias ของ `ovEventCalendar` เพราะ
`app/page.tsx` เรียกชื่อนั้น และรอบนี้ห้ามแตะ `app/`

## 6.2 Alerts มี cooldown และเขียนลง DB แล้ว — ทับ §5.5

§5.5 เขียนว่า "ไม่มี cooldown เพราะ cooldown คือความจำ ความจำคือการเขียน และการ
เขียนตอน GET คือสิ่งที่ override ข้อ 4 ห้าม" และตัด `notificationId` ทิ้ง

เหตุผลนั้นถูกสำหรับ section ที่ประเมินตอนอ่านหน้า และผิดทันทีที่มี sweep:
**บนหน้าจอไม่มีอะไรบอกผู้อ่านได้ว่าราคาทะลุตอนตีสาม** มีแต่ record ที่ทำได้
พอเขียน สองอย่างตามมาที่เวอร์ชันอ่านอย่างเดียวไม่ต้องมีจริง ๆ:

- **cooldown** — กฎที่เป็นจริงทั้งสัปดาห์จะเขียนแถวทุก 15 นาที = 672 แถวพูดเรื่องเดียว
  ตารางอยู่ใน `alerts/cooldown.ts` ที่เดียว: `earnings` 24 ชม. · อีกสี่ชนิด 4 ชม.
- **`last_fired_at` บน rule** — เพราะ cooldown ต้องมีที่อ่าน

`OvAlertHit.notificationId` กลับมา และเป็น `null` จริง ๆ เมื่อยังไม่ได้เขียน:
`evaluateOvAlerts` เป็น pure และคืน hit ที่ยังไม่มี id เลย มีแต่ `runOvAlertSweep`
ที่มี store เท่านั้นที่เติมให้ — คนเรียกที่ต้องรู้ว่าผู้อ่านถูกบอกจริงหรือยังต้องดูค่านี้
ไม่ใช่เดา

เพิ่ม kind ที่ห้า `earnings` (threshold = จำนวนวัน) รูปทรงเดียวกับอีกสี่ตัว:
เลขบวกหนึ่งตัวเทียบกับค่าที่อ่านได้หนึ่งค่า ต่างกันแค่หน่วย ซึ่ง `OV_ALERT_UNIT` บอกไว้

`alerts/repository.ts` ยังรับ port แทน `SupabaseClient` ด้วยเหตุผลเดิมใน §5.5 —
migration ทั้งสองไฟล์ยังไม่ถูก apply ตารางจึงยังไม่อยู่ใน `src/types/database.ts`

## 6.3 สิ่งที่ §5 ยังจริงทุกข้อ

§5.1 (prefix `Ov`), §5.2 (ไม่ import สี่ชื่อที่ห้าม), §5.3 (breadth ไม่มี MA
และ field เป็น `null` ถาวร), §5.6 (indices + ธง) ไม่มีอะไรเปลี่ยน
