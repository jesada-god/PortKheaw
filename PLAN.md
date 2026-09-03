# PortKheaw Phase 2 — Overview UI · PLAN

สถานะ: **ขั้น 0 — สำรวจเสร็จ รอ approve ก่อนลงมือ**

> ไฟล์นี้เคยเป็นแผน **Phase 1 — UX + Data Reliability** ซึ่งลงมือครบแล้ว
> เนื้อหาเดิมยังอ่านได้ที่ `git show 60c9c41:PLAN.md` ถ้าต้องการเก็บไว้เป็นไฟล์
> แยก บอกได้ จะย้ายไป `docs/PHASE1_PLAN.md` ให้

อ่าน [docs/PHASE2_CONTRACT.md](docs/PHASE2_CONTRACT.md) §1 §2 §5 เป็น spec
โมดูลใน [src/lib/market-overview/](src/lib/market-overview/) พร้อมใช้ ไม่แตะ logic ข้างใน

---

## 0. สรุปสั้นก่อนอ่านยาว

| เรื่อง | สถานะ |
|---|---|
| ข้อมูลที่ 5 section ต้องใช้ | **มีครบ 4 จาก 5** — ขาดอย่างเดียวคือ "จำนวน alert ต่อแถว" (ดู Q5) |
| ต้นทุนใหม่ที่ใหญ่ที่สุด | Overview ต้องเรียก `loadWatchlistView` ซึ่งวันนี้เป็นของหน้า `/watchlist` เท่านั้น (ดู Q9) |
| คำถามที่ต้องตอบก่อนเริ่ม | **12 ข้อ** รวมอยู่ที่ §5 · 4 ข้อแรก (Q1–Q4) เป็น blocker จริง ตอบไม่ได้ = เขียนไม่ได้ |
| ไฟล์ที่ต้องแตะนอก component | `app/page.tsx` · `src/lib/overview/{types,section-order}.ts` · `src/themes/foundation.css` (ดู Q8) · `src/lib/watchlist/what-changed-service.ts` (ดู Q7) |

---

## 1. Component: reuse / แก้ / ลบ

### 1.1 ใช้ต่อได้เลย ไม่แตะ

| Component | ที่อยู่ | ใช้ที่ section |
|---|---|---|
| `Header` | [src/components/layout/Header.tsx](src/components/layout/Header.tsx) | ทั้งหน้า |
| `NewsFeed` | [src/components/news/NewsFeed.tsx](src/components/news/NewsFeed.tsx) | 5 — **มี 4 tab ครบแล้ว** (`withScopeFilter`) |
| `InstrumentLogo` | [src/components/instruments/InstrumentLogo.tsx](src/components/instruments/InstrumentLogo.tsx) | 3 |
| `KheawLoadingBoundary` / `DataState` / `StaleNote` | [src/components/ui/](src/components/ui/) | ทุก section |
| `OnboardingCard` · `LandingFunnel` | — | นอก 5 section |
| `.panel-quiet` `.section-head` `.figure*` `.data-strip` `.page-stack` `.bleed-mobile` | [src/themes/foundation.css](src/themes/foundation.css) | ทุก section |

### 1.2 ต้องแก้

| Component | ที่อยู่ | แก้อะไร |
|---|---|---|
| `DashboardClient` | [src/components/dashboard/DashboardClient.tsx](src/components/dashboard/DashboardClient.tsx):1283 | เจ้าภาพลำดับ section · ต้องรับ props ใหม่ 5 ตัว (§3) · ย้าย/ลบบล็อกตาม Q1–Q3 |
| `WatchlistSection` | DashboardClient.tsx:970 | **เขียนใหม่** — วันนี้รับ `OverviewPrice[]` ซึ่งไม่มี trend/support/volume/earnings ต้องเปลี่ยนเป็น `WatchlistRow[]` (§2.3) |
| `ChangesSection` | DashboardClient.tsx:686 | **เขียนใหม่** — วันนี้รับ `OverviewChange[]` (กฎเดียว ≥4%) ต้องเปลี่ยนเป็น `OvChangeEvent[]` |
| `NewsSection` | DashboardClient.tsx:668 | เปิด `withScopeFilter` + ส่ง default scope |
| `NewsFeed` | src/components/news/NewsFeed.tsx:102 | เพิ่ม prop `defaultScope?: NewsScope` อย่างเดียว (วันนี้ hardcode `'all'` ที่บรรทัด 146) |
| `SectionTitle` | DashboardClient.tsx:204 | ใช้ต่อ ไม่แก้ — แต่ทุก section ใหม่ต้องเรียกผ่านตัวนี้เพื่อให้หัวข้อเหมือนกันทั้งหน้า |

### 1.3 สร้างใหม่

| Component | ที่อยู่ที่เสนอ | ทำไม |
|---|---|---|
| `MarketTodayStrip` | `src/components/dashboard/MarketTodayStrip.tsx` | section 1 — 6 ตัวแถวเดียว + regime + reasons |
| `ChangesList` | `src/components/dashboard/ChangesList.tsx` | section 2 — list เรียบ ไม่มี card ต่อรายการ |
| `WatchlistTable` | `src/components/dashboard/WatchlistTable.tsx` | section 3 — 4 คอลัมน์ + บรรทัดรองเฉพาะแถวที่มีสัญญาณ |
| `EventsList` | `src/components/dashboard/EventsList.tsx` | section 4 |
| `StatusDot` | `src/components/ui/StatusDot.tsx` | **ขัดกับของเดิม — ดู Q6** |

### 1.4 ลบ / เลิกใช้ (รอยืนยัน Q1–Q3)

| Component | ชะตากรรมที่เสนอ | หมายเหตุ |
|---|---|---|
| `MarketStatusCard` | เลิกใช้บน Overview | `MarketTodayStrip` แสดง 6 อินพุตเดิม + regime ครบแล้ว การมีสองการ์ดคืออ่านตลาดสองรอบ · ไฟล์ยังอยู่ ธง `MARKET_STATUS_CARD` ยังปิด |
| บล็อก `#market-overview` (MarketCard ×9) | **ลบ** | ดู **Q2** — จะทำให้ ทองคำ / เงิน / น้ำมัน / Bitcoin / IWM / REMX หายจากหน้านี้ |
| `MarketCard` | เลิกใช้ (ถ้า Q2 = ลบ) | ยังถูกใช้ที่อื่นไหมต้องเช็ก |
| `PortfolioSummaryLine` | **รอ Q1** | ลำดับที่สั่งมาไม่มี portfolio |
| `UpcomingSection` | **รอ Q3** | ลำดับที่สั่งมาไม่มี upcoming |
| `MarketEventsCard` (ปฏิทินเดือน) | เลิกใช้บน Overview | `EventsList` เป็น list ไม่ใช่ grid เดือน · หน้า `/market-events` ยังใช้ของเดิม |
| `ServiceStatus` · `IndustryRanking` · `BreadthSection` ใน `<details>` | **คงไว้เหมือนเดิม** | ไม่ได้อยู่ใน 5 section และไม่ได้สั่งให้แตะ |

---

## 2. section-order V2 ต้องเปลี่ยนตรงไหน

ไฟล์: [src/lib/overview/section-order.ts](src/lib/overview/section-order.ts)

### 2.1 ปัญหาเชิงโครงสร้างที่ต้องแก้ก่อน

**"ตลาดวันนี้" วันนี้อยู่นอกลำดับ** — เป็น `<section id="market-overview">` ตายตัวที่
DashboardClient.tsx:1473 ก่อน `sections.map()` จึงไม่มี key ใน `OverviewSectionKey` และธง
`OVERVIEW_V2` ขยับมันไม่ได้ คำสั่งให้ Market Today เป็นลำดับที่ 1 ของรายการที่จัดลำดับได้
→ ต้อง**ยกเข้ามาอยู่ในลำดับ** เป็น key ใหม่

### 2.2 การเปลี่ยนที่เสนอ

```
OverviewSectionKey (เดิม)                  →  (ใหม่)
  'marketStatus'                           →  'marketToday'      // เปลี่ยนชื่อ + เปลี่ยนแหล่งข้อมูล
  'portfolio'                              →  คงไว้ (Q1)
  'watchlist'                              →  คงไว้ แหล่งข้อมูลเปลี่ยน
  'whatChanged'                            →  คงไว้ แหล่งข้อมูลเปลี่ยน
  'marketEvents'                           →  'events'           // เปลี่ยนชื่อ + เปลี่ยนแหล่งข้อมูล
  'upcoming'                               →  คงไว้ (Q3)
  'news'                                   →  คงไว้
```

`OVERVIEW_ORDER_V2` ที่สั่งมา (สมมติ Q1 = คง portfolio, Q3 = ตัด upcoming):

```ts
export const OVERVIEW_ORDER_V2 = [
  'marketToday',
  'portfolio',      // ← ต้องยืนยัน Q1 ว่าอยู่ตรงนี้ หรือออกไปเลย
  'whatChanged',
  'watchlist',
  'events',
  'news',
];
```

`OVERVIEW_ORDER_V1` **ไม่แตะ** — เป็นหน้าเดิมที่ ship อยู่ และธงคือ rollback
เทสต์ที่กวาดครบทุก subset (`section-order.test.ts`) จะต้องอัปเดตจำนวน key

### 2.3 ผลข้างเคียง

- `OverviewSectionPresence` เพิ่ม/เปลี่ยน key → ทุกที่ที่ประกาศ record ครบทุก key ต้องแก้
- `RetriableOverviewSection` (`market` / `industries` / `watchlist` / `breadth`) และ
  `/api/market/overview/section` **ไม่ต้องแตะ** — ปุ่มลองใหม่ยังยิงส่วนเดิม
  แต่ปุ่ม retry ของ `market` เคยอยู่บนหัวข้อ `#market-overview` ที่จะถูกลบ → ต้องหาที่อยู่ใหม่

---

## 3. Props ที่ต้องส่งจาก app/page.tsx

เพิ่มใน `OverviewDashboardData` ([src/lib/overview/types.ts](src/lib/overview/types.ts))
ทุกตัว optional/nullable เพื่อให้ธงปิดแล้วหน้าเดิมไม่เปลี่ยน

| # | prop | ชนิด | มาจาก | ธง |
|---|---|---|---|---|
| 1 | `marketToday` | `OvMarketSnapshot \| null` | `ovMarketSnapshotView(now)` + `warmOvMarketSnapshot(now)` ใน `after()` | `PHASE2_MARKET_SNAPSHOT` |
| 2 | `changes` | `OvChangeEvent[]` | `ovChanges(view.whatChanged.items)` | `PHASE2_WHAT_CHANGED` |
| 3 | `watchlistRows` | `WatchlistRow[]` | `loadWatchlistView({ client, watchlist, tier })` | `WATCHLIST_V2` |
| 4 | `events` | `{ window: OvEventWindow; relevance: [string, OvEventRelevance][] }` | `ovEventWindow({ now })` + `ovEventRelevanceFor(...)` | `PHASE2_EVENTS` |
| 5 | `alertCountBySymbol` | `Record<string, number>` | **ยังทำไม่ได้ — Q5** | `PHASE2_ALERTS` |
| 6 | `newsDefaultScope` | `NewsScope` | ค่าคงที่ `'portfolio'` | `NEWS_FILTER` |

### 3.1 สิ่งที่ `app/page.tsx` ต้องเพิ่ม

```
+ resolvePageEntitlement()                     // ได้ effectiveAccessTier ให้ loadWatchlistView
+ loadWatchlistView({ client, watchlist, tier })  // ให้ทั้ง section 2 และ 3 ในคำเรียกเดียว
+ ovMarketSnapshotView / warmOvMarketSnapshot     // ใน after() แบบเดียวกับ warmMarketBreadth
+ ovEventWindow / ovEventRelevanceFor             // pure ไม่มี await
+ ovChanges                                       // pure ไม่มี await
```

**`loadWatchlistView` เรียกครั้งเดียว ให้ทั้งสอง section** — `view.rows` → Watchlist,
`view.whatChanged.items` → สิ่งที่เปลี่ยนไป เรียกสองครั้งคือจ่าย signal engine สองรอบ

### 3.2 สิ่งที่เลิกส่ง (ถ้า Q2 = ลบบล็อกเดิม)

`indices` (`MarketIndexCard[]` จาก `loadMarketIndices`) — ประหยัดการโหลดราคา 9 ตัว
แต่ `buildServiceStatus` และ `buildMarketSummary` อ่านมันอยู่ → ต้องดูว่า `ServiceStatus`
ใน `<details>` จะรายงานอะไรแทน

---

## 4. แผนต่อ section

> ทุก section: loading = skeleton สูงเท่าของจริง · error = ข้อความ + ปุ่มลองใหม่ ไม่โชว์ message จาก API ·
> empty = บรรทัดเดียว · stale = เวลาข้อมูลล่าสุดผ่าน `formatMarketDataAsOf` · ส่วนหนึ่งพังส่วนอื่นต้องอยู่
> (ทุก loader หุ้ม `Promise.allSettled` / `.catch()` อยู่แล้วใน `app/page.tsx`)

### 4.1 Market Today
- ข้อมูล: `OvMarketSnapshot.readings` (6 ตัว) + `.status` + `.regime` + `.regimeReasons`
- desktop: `.data-strip` 6 คอลัมน์ · mobile: `.bleed-mobile` + `overflow-x-auto` เลื่อนแนวนอน
- แต่ละ cell: `.figure-data` = ตัวเลข (เด่น) · `.figure-label` = ชื่อไทยจาก `reading.labelTh` (เบา) · % ใต้ตัวเลข
- ค่าอ่านไม่ได้ = `—` ไม่ใช่ `0`
- บรรทัดถัดมา: `StatusDot` + `OV_MARKET_STATUS_WORD[status]` + `OV_REGIME_WORD[regime]` + `regimeReasons` 2–3 ข้อคั่น `·`
- `availability === 'insufficient'` → ไม่โชว์ status/regime แต่ยังโชว์ตัวเลขที่อ่านได้
- **ต้องเพิ่ม `.data-strip--6`** ดู Q8

### 4.2 สิ่งที่เปลี่ยนไป
- ข้อมูล: `OvChangeEvent[]` — `severity` เรียง high→medium→low มาแล้วจาก `capWhatChanged`
- แถว: `StatusDot(level)` + `symbol` + label จาก `kind` + `valueText`
- cap 8 → **ชนกับ `WHAT_CHANGED_LIMIT = 5`** ดู Q7
- ว่าง: `วันนี้ยังไม่มีอะไรเปลี่ยนชัดเจน` บรรทัดเดียว
- section หายทั้งอัน หรือโชว์บรรทัดว่าง? สั่งมาว่ามีบรรทัดว่าง → section คงอยู่เสมอ
  (ต่างจาก `ChangesSection` เดิมที่หายไปทั้งอัน — `present.whatChanged` ต้องเป็น `true` เสมอ)

### 4.3 Watchlist 2.0
- ข้อมูล: `WatchlistRow[]` — `symbol` `price` `day.changePercent` `trend` + `expanded.{support,resistance,volume,earningsDays}`
- 4 คอลัมน์: หุ้น / ราคา / % วันนี้ / แนวโน้ม (`WATCHLIST_TREND_WORD[trend.level]`)
- บรรทัดรอง: เฉพาะแถวที่ `expanded` มีค่าอย่างน้อยหนึ่ง — support/resistance/volume/earnings
- ตัวเลขใช้ `.figure-data` · label ใช้ `.figure-label`
- alert count ท้ายแถว → **Q5**
- ตัวเลือกลิสต์ (`watchlistPreview.lists`) และ "ดูทั้งหมด" ยกมาจากของเดิมได้ตรง ๆ

### 4.4 Events
- ข้อมูล: `ovEventWindow({ now })` → `.events` `.coversThrough` `.lastDayKey`
- แถว: `ovEventDayLabel(event)` + `ovEventTimeLabel(event)` (ICT ผ่าน `datetime.ts` ทั้งคู่)
  + `titleTh` + `importance` + `ovEventCountdownDays()`
- หุ้นที่เกี่ยวข้อง: `ovEventRelevance(...).affectedSymbols` ต่อท้าย
- `coversThrough === false` → ปิดท้าย `ปฏิทินถึง <lastDayKey ผ่าน formatThaiDateOnly> · เดือนถัดไปรอประกาศ`
- **ตัวอย่าง "NVDA Earnings" ไม่ใช่ macro event** → **Q4**

### 4.5 News filter
- `NewsFeed withScopeFilter defaultScope="portfolio"` + `newsContext` เดิม
- ต้องเพิ่ม prop `defaultScope` (วันนี้ `useState({key:'', scope:'all'})` hardcode)
- ผู้ใช้ที่ไม่มีพอร์ต → tab พอร์ตว่าง → **Q11**

---

## 5. คำถามกำกวมทั้งหมด

**Q1–Q4 เป็น blocker** ตอบไม่ได้เขียนไม่ได้ ที่เหลือเลือก default ได้ถ้าไม่ตอบ

### Q1 · portfolio ยังอยู่บนหน้า Overview ไหม
ลำดับที่สั่งมามี 5 section และไม่มี portfolio แต่ `OVERVIEW_ORDER_V2` วันนี้มันอยู่อันดับ 2
และคอมเมนต์ใน `DashboardClient.tsx` เถียงไว้ยาวว่า "คนเปิดแอปมาดูเงินตัวเองก่อนเงินคนอื่น"
→ (ก) คงไว้อันดับ 2 · (ข) เอาออกจาก Overview ทั้งหมด · (ค) ย้ายไปท้ายสุด

### Q2 · "Market Today" แทนอะไรบ้าง
วันนี้มีสองอย่างที่พูดเรื่องเดียวกัน: บล็อก `#market-overview` (การ์ด 9 ใบ — SPY QQQ DIA IWM
GC-F SI-F CL-F REMX BTC-USD) และ `MarketStatusCard` (6 อินพุต + regime)
Market Today ที่สั่งคือ 6 ตัว = ชุดเดียวกับ `MarketStatusCard`
→ (ก) แทนทั้งคู่ — **ทองคำ เงิน น้ำมัน Bitcoin IWM REMX หายจากหน้า Overview**
· (ข) แทนเฉพาะ `MarketStatusCard` เก็บการ์ด 9 ใบไว้ (= สองแถวตลาดซ้อนกัน)
· (ค) แทนทั้งคู่ แต่ย้ายสินทรัพย์ 6 ตัวที่หายไปไว้ใน `<details>`

### Q3 · `UpcomingSection` ("สิ่งที่ควรรู้เร็ว ๆ นี้")
ไม่อยู่ในลำดับที่สั่ง แต่วันนี้อยู่ใน V2 และมี earnings + option expiry + alert proximity
→ (ก) เอาออก · (ข) คงไว้ท้าย · (ค) รวมเข้า Events (เกี่ยวกับ **Q4**)

### Q4 · Events รวม earnings ด้วยไหม
ตัวอย่างที่ให้มาคือ `"NVDA Earnings · อีก 5 วัน"` ซึ่งเป็น **earnings** แต่ `OvMarketEvent`
เป็น macro ล้วน 7 code (CPI PPI PCE NFP GDP FOMC JOBLESS_CLAIMS) และ
[src/lib/market-events/types.ts](src/lib/market-events/types.ts) เขียนไว้ชัดว่าขอบเขตนี้เป็น
**เส้นแบ่ง ไม่ใช่ขั้นของงาน** — earnings เป็นของบริษัทเดียว ตอบคำถามคนละข้อ
→ (ก) Events = macro อย่างเดียว หุ้นที่เกี่ยวข้องต่อท้ายคือ `affectedSymbols` (สิ่งที่โมดูลทำได้วันนี้)
· (ข) รวม `UpcomingFeed.earnings` เข้ามาเรียงปนกัน — ต้องมี adapter ใหม่ **นอก** `market-overview/**`
เพราะห้ามแก้ logic ข้างใน

### Q5 · จำนวน alert ต่อแถว — **ข้อมูลที่โมดูลยังให้ไม่ได้**
~~`overview_alert_rules` ยังไม่ได้ apply~~ — **แก้แล้ว 2026-09-03**: `202608300001` apply แล้ว
(พร้อม `202608310001`, `202608310002`) ตารางอยู่ใน `src/types/database.ts` แล้ว และ
`loadOvAlertCountsBySymbol` อ่านได้จริง ย่อหน้านี้เขียนไว้ตอนที่ยังไม่ apply แล้วไม่ได้กลับมาแก้
— ดู `docs/operations/migration-state.md`

ข้อจำกัดที่ยังเหลือเป็นคนละเรื่อง: **ไม่มี UI ให้สร้าง rule** ทุก reader จึงนับได้ `{}` เสมอ
และคิวที่ยังค้างคือ `202608310003`, `202608310004`
→ (ก) เว้นคอลัมน์นี้ไว้ก่อน ค่อยเติมรอบหน้า · (ข) หยุดรอ migration · (ค) นับจาก `price_alerts`
เดิมแทน — ทำได้ทันที (`AlertsRepository.list()` ถูกเรียกบน `app/page.tsx` อยู่แล้ว) แต่เป็นคนละระบบ
กับที่ §5.5 ของ CONTRACT แยกไว้ตั้งใจ

### Q6 · `StatusDot` ขัดกับ `StatusLabel`
สั่งว่า "**ไม่มี emoji**" แต่ `StatusLabel` ใช้ emoji เป็น **data mark** ทั้งเว็บ และ
[src/lib/presentation/status.ts](src/lib/presentation/status.ts) เขียนเหตุผลไว้ว่ามันคือส่วนเดียว
ที่รอดจากการ screenshot / paste / อ่านห่าง ๆ · รอบที่แล้วสั่งให้ reuse `StatusLabel` 100%
→ (ก) สร้าง `StatusDot` (จุดสีล้วน ไม่มี emoji) ใช้เฉพาะ Overview — หน้าอื่นยังเป็น emoji =
**ผลิตภัณฑ์มีสองภาษาสถานะ** · (ข) เปลี่ยนทั้งเว็บเป็นจุด — งานใหญ่ นอก scope นี้
· (ค) ใช้ `StatusLabel` ตามเดิม (มี emoji) — ขัดคำสั่ง

### Q7 · cap 8 vs `WHAT_CHANGED_LIMIT = 5`
`loadWhatChanged` เรียก `whatChanged(inputs)` โดยไม่ส่ง limit → ได้ 5 เสมอ และ `capWhatChanged`
ตัดไปแล้วจึงกู้รายการที่ 6–8 คืนไม่ได้
→ (ก) เพิ่ม optional `limit` ใน `WhatChangedInputBundle` (แก้ `what-changed-service.ts` ซึ่ง
**ไม่ใช่** `market-overview/**` จึงไม่ผิดข้อห้าม แต่กระทบหน้า `/watchlist` ถ้าเผลอเปลี่ยน default)
· (ข) ใช้ 5 ตามที่มี ไม่ต้องแตะอะไร

### Q8 · `.data-strip` ไม่มี 6 คอลัมน์
มี `--1` `--3` `--4` เท่านั้น (base = 2 คอลัมน์) และมันเป็น grid ธรรมดา เลื่อนแนวนอนไม่ได้
→ (ก) เพิ่ม `.data-strip--6` ใน `foundation.css` + ครอบด้วย `overflow-x-auto` บน mobile
· (ข) ใช้ `grid-cols-6` inline ไม่แตะ design system (แต่ผิดข้อ "ใช้ `.data-strip` เดิม")

### Q9 · ต้นทุน `loadWatchlistView` บน Overview
วันนี้เรียกเฉพาะหน้า `/watchlist` — มันรัน **signal engine ต่อ symbol** (concurrency 4,
entitlement-gated) และ **daily bars ต่อ symbol ที่มีสัญญาณ** ย้ายมา Overview =
ทุกคนที่เปิดหน้าแรกจ่ายค่านี้ · candle service มี cache 6 ชม. + dedupe ช่วยได้ และ
`WATCHLIST_V2` ตัด preview เหลือ 5 symbol ก่อนโหลดราคา
→ ยืนยันว่ายอมจ่าย? ถ้าไม่ Watchlist 2.0 บน Overview จะไม่มีคอลัมน์แนวโน้ม และ
"สิ่งที่เปลี่ยนไป" จะไม่มีข้อมูลเลย

### Q10 · `ovBreadth` ใช้ที่ไหน
โมดูล breadth สร้างไว้แล้วแต่ไม่อยู่ใน 5 section ที่สั่ง
→ (ก) ปล่อยไว้ไม่ใช้ · (ข) แทน `BreadthSection` เดิมใน `<details>` · (ค) เอาขึ้นมาต่อท้าย Market Today

### Q11 · default tab = พอร์ต แต่ผู้ใช้ไม่มีพอร์ต
คนที่ยังไม่มีหุ้นจะเปิดมาเจอ tab ว่างทันที (`NewsFeed` มี empty state ของ scope อยู่แล้ว)
→ (ก) default พอร์ตเสมอ ตามที่สั่ง · (ข) พอร์ตถ้ามีหุ้น ไม่งั้น ทั้งหมด

### Q12 · ไฟล์นี้ทับแผน Phase 1
เขียนทับไปแล้วตามที่สั่ง เนื้อหาเดิมอยู่ที่ `git show 60c9c41:PLAN.md`
→ ต้องการให้กู้กลับมาเป็น `docs/PHASE1_PLAN.md` ไหม

---

## 6. ลำดับ commit ที่วางไว้ (ขั้น 1)

1. `feat(overview): section-order V2 ตามลำดับใหม่` — key + order + test
2. `feat(overview): Market Today แถวเดียว 6 ตัว`
3. `feat(overview): สิ่งที่เปลี่ยนไปเป็น list เรียบ`
4. `feat(overview): Watchlist 2.0 สี่คอลัมน์`
5. `feat(overview): Events พร้อม countdown`
6. `feat(news): default scope บน Overview`
7. `chore(overview): ต่อ props ทั้งหมดใน app/page.tsx` (หรือกระจายเข้าแต่ละ commit)

Design gate ตรวจก่อนทุก commit: ไม่มี card ซ้อน card · ไม่มี emoji · ไม่มี gradient/glow ·
สีใช้เพื่อสถานะเท่านั้น · ไม่มี paragraph อธิบาย feature · ตัวเลขเด่นกว่า label ทุกที่ ·
375px ต้องอ่านได้

---

# §7 ขั้น 1 — สิ่งที่ลงมือไปจริง

## 7.1 คำตอบ Q1–Q12 ถูกนำมาใช้อย่างไร

| Q | คำตัดสิน | ที่ทำจริง |
|---|---|---|
| Q1 | Portfolio อยู่ต่อ อันดับ 2 | `OVERVIEW_ORDER_V2 = [marketToday, portfolio, whatChanged, watchlist, events, news]` |
| Q2 | Market Today แทนเฉพาะ `MarketStatusCard` · การ์ด 9 ใบห้ามลบ | `marketToday` เป็น key เดียวที่วาดทั้งแถบ 6 ตัวและแถบ 9 สินทรัพย์แบบ compact · `marketStatus` ไม่อยู่ใน V2 แต่ยังอยู่ใน V1 · `MarketStatusCard` ไม่ถูกลบ |
| Q3 | Upcoming ยุบเข้า Events | `buildOverviewEvents` รับ `UpcomingFeed` ทั้งก้อน — **ดู §7.3 เรื่องที่ต้องรายงาน** |
| Q4 | adapter อยู่นอก `market-overview/**` | `src/lib/overview/events-feed.ts` · โมดูล macro ไม่ถูกแตะแม้แต่บรรทัดเดียว |
| Q5 | ทำ UI ไว้ ซ่อนเมื่ออ่านค่าไม่ได้ | `WatchlistTable` รับ `counts?` · `typeof alerts === 'number' && alerts > 0` เท่านั้นที่วาด · `app/page.tsx` **ไม่ส่ง** field นี้เลย (ตารางยัง apply ไม่ได้) จึงไม่มี 0 และไม่มี — บนจอ |
| Q6 | ใช้ `StatusLabel` เดิม ทิ้ง `StatusDot` | ไม่มีไฟล์ `StatusDot` ถูกสร้าง ทุก mark บนหน้านี้มาจาก `StatusLabel` ตัวเดียว |
| Q7 | เพิ่ม `limit` (default ใน PLAN §5) | `WhatChangedInputBundle.limit` + `WatchlistViewInput.whatChangedLimit` · Overview ส่ง 8 · `/watchlist` ไม่ส่ง จึงยังได้ `WHAT_CHANGED_LIMIT = 5` |
| Q8 | ขยาย utility เดิม | `.data-strip--6`, `.data-strip--flow`, `.data-strip-scroll` ใน `foundation.css` · ไม่มี inline grid เหลืออยู่ |
| Q9 | จ่ายแต่มีเพดาน | `watchlist-view-cache.ts` — cap 20, `SharedRequestCache` + `LastGoodSnapshotCoordinator` ต่อผู้อ่าน (map จำกัด 200), deadline 2.5 วิ, ล้มเหลว = `null` = เสียคอลัมน์แนวโน้ม ไม่เสียหน้า |
| Q10 | ปล่อย breadth ไว้ | `ovBreadth` ยังไม่มีผู้เรียก · `BreadthSection` เดิมใน `<details>` ไม่ถูกแตะ |
| Q11 | `defaultScope` | `NewsFeed` รับ prop ใหม่ · Overview ส่ง `'portfolio'` เมื่อ `NEWS_FILTER` เปิด |
| Q12 | กู้ Phase 1 | `docs/PHASE1_PLAN.md` |

## 7.2 โครงสร้างที่เปลี่ยน

`<section id="market-overview">` เคยเป็น JSX ตายตัวก่อน `sections.map()` — ธง `OVERVIEW_V2`
ขยับมันไม่ได้ ตอนนี้เป็น key `marketToday` และ **อยู่อันดับ 1 ของทั้ง V1 และ V2**
V1 จึงวาดเหมือนเดิมทุกพิกเซล (ธงคือ rollback — rollback ที่จัดหน้าใหม่ไม่ใช่ rollback)

`OverviewSectionKey` มี 9 ค่า และ **ไม่มี order ไหนถือครบทั้ง 9**:
`marketStatus` / `upcoming` / `marketEvents` เป็นของ V1 · `events` เป็นของ V2
เทสต์กวาด 512 subset และตอนนี้พิสูจน์เพิ่มได้ว่า key ที่เปิดอยู่แต่ไม่อยู่ใน order ที่ใช้
ต้องไม่วาดอะไรเลย — ข้อนี้ตรวจไม่ได้ตอนที่ทุก order ถือครบทุก key

## 7.3 เรื่องที่ต้องรายงาน (Q3 สั่งว่าห้ามทิ้งเงียบ)

**Q4 เขียนว่า "merge macro + earnings" แต่ `UpcomingFeed` มี 3 ชนิด ไม่ใช่ 1**
— `earnings`, `option-expiry` และ `alert` การ merge เฉพาะ earnings จะทำให้
**วันหมดอายุสัญญาออปชัน** และ **การแจ้งเตือนที่ใกล้ถึง** หายจากหน้าแรกเงียบ ๆ
ซึ่งเป็นสิ่งที่ Q3 สั่งห้ามพอดี

จึงยกมา **ทั้งสามชนิด** ไม่ใช่แค่ earnings — `buildOverviewEvents` รับ `UpcomingFeed`
ทั้งก้อนและคง `text` ที่ builder เดิมเขียนไว้แบบคำต่อคำ ไม่มีอะไรหาย
`events-feed.test.ts` pin ข้อนี้ไว้เป็นเทสต์แรกของไฟล์

ผลข้างเคียงที่ยอมรับ: แถว `alert` ไม่มีวันที่ (มันคือ "ใกล้แล้ว" ไม่ใช่ "อีก N วัน")
จึงเรียง**ท้ายสุด** ไม่ใช่ต้นสุด — ถ้าปล่อยให้ null อ่านเป็น 0 มันจะขึ้นเหนือข่าวที่ประกาศเช้านี้

## 7.4 สิ่งที่ตรวจไม่ได้ในสภาพแวดล้อมนี้

**375px ในเบราว์เซอร์จริง — ตรวจไม่สำเร็จ** เปิด `next dev` พร้อมธงครบแล้ว แต่ `/` ตอบ
`307 → /maintenance` เพราะ environment นี้เปิด maintenance อยู่ และสวิตช์นั้นมาจาก
security posture ใน Supabase ไม่ใช่ env var — ปิดมันคือการเขียนสถานะที่ใช้ร่วมกัน
จึงไม่ทำ **ยังไม่มีภาพหน้าจอ 375px และยังไม่ได้วัด layout จริง**

สิ่งที่ตรวจแทน: โครงสร้างและลำดับผ่าน DOM จริงใน jsdom (37 เทสต์ใน
`DashboardClient.order.test.tsx` รวมทุก subset ของธง), typecheck, lint, และ
design gate อ่านเอง (ไม่มี card ซ้อน card — ทุก section ใหม่ใช้ `.panel-quiet` +
list/strip ที่ไม่มี border ต่อแถว · สีมาจาก `StatusLabel` เท่านั้น · ไม่มี gradient/glow ·
ตัวเลขทุกจุดหนากว่าและใหญ่กว่า label ที่กำกับมัน)

**เวลาโหลด Overview ก่อน/หลัง — วัดไม่ได้ด้วยเหตุผลเดียวกัน** ธง `PHASE2_*` ยัง OFF ทั้งหมด
จึงยังไม่มีอะไรเปลี่ยนใน production และเพดานที่ Q9 สั่งถูกเทสต์ไว้แทน
(`phase2-flags.test.ts` — cap 20, deadline, และธงถูกอ่านก่อนสร้าง promise)
**ต้องวัดจริงก่อนเปิดธง**

## 7.5 State ที่มีและไม่มี

| Section | loading | error | empty | stale |
|---|---|---|---|---|
| ตลาดวันนี้ | skeleton สูงเท่าของจริงตอนกด retry | ปุ่ม retry เดิม | ไม่มีสถานะว่าง — ไม่มี snapshot = ถอยไปวาดการ์ด 9 ใบ | `snapshot.stale` → เวลาข้อมูลล่าสุด + "กำลังอัปเดต" |
| สิ่งที่เปลี่ยนไป | — (SSR มากับหน้า) | — | บรรทัดเดียว | — |
| Watchlist | skeleton เท่าจำนวนแถวเดิมตอน retry | ปุ่ม retry เดิม | มีอยู่แล้ว | ไม่มี trend = ถอยไปแถวเดิม |
| Events | — (SSR มากับหน้า) | — | บรรทัดเดียว | บรรทัดขอบเขตปฏิทิน |
| News | ของเดิม | ของเดิม | ของเดิม (ต่อ tab) | ของเดิม |

section ที่ไม่มี loading ของตัวเองคือ section ที่ **ไม่เคยโหลดแยกจากหน้า** — มันมากับ
payload เดียวกัน และ `app/loading.tsx` ครอบทั้งเส้นทางอยู่แล้ว การใส่ skeleton ที่ไม่มี
ทริกเกอร์คือโค้ดตาย จึงลบทิ้งสองตัวที่เขียนไว้แล้วไม่มีใครเรียก
