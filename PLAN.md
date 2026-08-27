# PortKheaw Phase 1 — UX + Data Reliability · PLAN

สถานะ: **ตอบคำถามครบแล้ว · กำลังลงมือตาม 9 commits**

---

## 0. สิ่งที่พบจากการอ่านโค้ดจริง (สรุปสั้น)

ระบบนี้ **ไม่ได้เริ่มจากศูนย์** — งานหลายอย่างใน brief ทำไปแล้วบางส่วน และมีของที่ต้อง reuse ไม่ใช่สร้างใหม่:

| เรื่อง | ของที่มีอยู่แล้ว | เหลือทำ |
|---|---|---|
| Design tokens | `src/themes/foundation.css` — radius 4 ระดับ, `--stack-*`, `.panel` / `.panel-hero` / `.panel-quiet` / `.inset`, `--positive/--negative/--warning/--info` + `-soft`/`-line` | เพิ่ม `--caution` (ส้ม) ให้ระดับ "อ่อนแรง" แยกจาก "ระวัง" |
| ห้าม gradient/glow/card ซ้อน card | `foundation.css` เขียนกฎนี้ไว้แล้ว และ Tools page ถอด blob/shadow ไปแล้ว | บังคับใช้กับ Search / Key Statistics / Planner locked panel ที่ยังเป็น hardcoded slate |
| Status primitive | ยังไม่มีตัวกลาง — มี `MARKET_SIGNAL_PRESENTATION.tone`, `OPTIONS_SIGNAL_PRESENTATION.dot/tone`, `DataStatusBadge`, `ServiceStatus` dot กระจาย 4 ที่ | **สร้าง `<StatusLabel>` ตัวเดียว** แล้วให้ 4 ที่นั้นเรียกใช้ |
| Score → Status | Market Signal ซ่อน score ไว้ใน dialog แล้ว (การ์ดโชว์ state ไทย) | Options Signal ยัง **โชว์ score ตัวใหญ่บนการ์ด** (`options-signal-score-card`) → ต้องเป็น status |
| เวลาไทย (ICT) | `src/lib/presentation/datetime.ts` เป็น util ตัวเดียวอยู่แล้ว (`Asia/Bangkok`) | บังคับให้ทุกจุดที่ยังพิมพ์เวลาเองมาใช้ตัวนี้ |
| 4 data states | Overview มีครบ (`RetryButton` + retry endpoint) แต่เป็น pattern เฉพาะหน้า Overview | ยกขึ้นเป็น shared `<DataState>` แล้วใช้กับ Search / Key Statistics / Stock Detail |
| คำต้องห้าม | `CARD_MUST_NOT_SAY` อยู่ใน **ไฟล์เทสต์** (`MarketSignalSection.test.tsx:2205`) + eslint rule `no-unsourced-frame-word` ครอบเฉพาะ `market-signal/**` | ย้ายเป็น module กลาง + eslint rule ใหม่ครอบ 5 หน้า |
| Investment Score | **ไม่มีในโค้ด** (grep แล้วไม่เจอ) | out-of-scope ข้อนี้เป็นโมฆะ |
| `src/lib/analytics/decision-panel/**` | dead code — ไม่มีใคร import (17 ไฟล์) | ไม่แตะ (นอก scope) |

---

## 1. ไฟล์ที่จะแก้ (แยกตามลำดับ commit)

### commit 1 — `feat(ui): status primitive เดียวสำหรับทั้งเว็บ`

| ไฟล์ | ทำอะไร |
|---|---|
| `src/lib/presentation/status.ts` **(ใหม่)** | `StatusLevel = 'good' \| 'neutral' \| 'weak' \| 'bad' \| 'unknown'` + mapper กลาง |
| `src/lib/presentation/status.test.ts` **(ใหม่)** | boundary + missing data |
| `src/components/ui/StatusLabel.tsx` **(ใหม่)** | `<StatusLabel level label />` — emoji dot (`aria-hidden`) + คำไทย + สี token |
| `src/components/ui/StatusLabel.test.tsx` **(ใหม่)** | |
| `src/themes/foundation.css` | เพิ่ม `--caution` + `--caution-soft` / `--caution-line` (ส้ม สำหรับ 🟠 อ่อนแรง) |
| `src/themes/{portkheaw,bitswap,cosmic,dokturek,orchid}/{dark,light}.css` | ค่า `--caution` ต่อธีม (10 ไฟล์ · บรรทัดละไฟล์) |

**หมายเหตุ emoji:** ใช้ emoji dot ตามที่ brief ระบุ — โค้ดเดิมมี precedent อยู่แล้ว (`OPTIONS_SIGNAL_PRESENTATION.dot = '🟢'` พร้อมคอมเมนต์ "the emoji is decorative only") ไม่ขัดกับข้อห้าม "emoji ทุกหัวข้อ" เพราะนี่คือ data mark ไม่ใช่หัวข้อ

### commit 2 — `feat(status): mapper กลาง score → status`

| ไฟล์ | ของเดิม → ของใหม่ |
|---|---|
| `src/lib/presentation/status.ts` | ตารางใน §2 |
| `src/components/analytics/market-signal/MarketSignalSection.tsx` | `MARKET_SIGNAL_PRESENTATION[state].tone` (tailwind emerald/green/sky/amber/orange/red hardcode) → `StatusLabel level=…` · เก็บคำไทย `thai` ไว้เหมือนเดิม (มี eslint rule คุมคำอยู่) |
| `src/components/analytics/options-signal/OptionsSignalSection.tsx` | ลบ `options-signal-score-card` (ตัวเลขใหญ่บนการ์ด) → `StatusLabel` · `dot: '🟢'` → `level` |
| `src/lib/tools/stock-plan.ts` | เพิ่ม `planStatus(levels)` จาก `rewardToRisk` |
| `src/components/dashboard/DashboardClient.tsx` | `ServiceStatus` dot (3 สี inline) → `StatusLabel` |
| ไฟล์เทสต์ที่เกี่ยวข้อง | อัปเดต assertion |

### commit 3 — `feat(ui): 4 data states เป็น pattern เดียว`

| ไฟล์ | ทำอะไร |
|---|---|
| `src/components/ui/DataState.tsx` **(ใหม่)** | `loading` → `<Skeleton>` · `empty` → "ไม่มีข้อมูลสำหรับช่วงเวลานี้" · `error` → "โหลดข้อมูลไม่สำเร็จ" + ปุ่มลองอีกครั้ง (**ไม่ส่ง message จาก API ออกจอ**) · `stale` → 🟡 + `formatMarketDataAsOf()` |
| `src/components/ui/DataState.test.tsx` **(ใหม่)** | ครอบทั้ง 4 + กันเคส `undefined` / `null` / `NaN` หลุดจอ |
| `src/components/ui/DataSourceBadge.tsx`, `src/components/market-data/DataProvenance.tsx` | เลิก hardcode emerald/sky/violet/amber/red → token |

### commit 4 — `refactor(overview): ตลาด → watchlist → สิ่งที่เปลี่ยนไป`

`src/components/dashboard/DashboardClient.tsx` · `app/page.tsx` · `src/lib/overview/presentation.ts` (+test) — ลำดับตาม §3 Q1 · ไม่มี VIX/US10Y (§3 Q2) · "สิ่งที่เปลี่ยนไป" ตาม §3.1

### commit 5 — `refactor(search): tokens + 4 data states`

| ไฟล์ | ของเดิม → ของใหม่ |
|---|---|
| `src/components/search/SearchClient.tsx` | `#151B28` / `#D4FF00` / `slate-*` hardcode → token · `setError(cause.message)` **leak error จาก API** → "ค้นหาไม่สำเร็จ" + ปุ่มลองอีกครั้ง · `กำลังค้นหา…` (ข้อความเปล่า) → skeleton rows · `DELISTED` (อังกฤษ) → `เลิกซื้อขายแล้ว` · เพิ่ม `<StatusLabel>` %เปลี่ยนต่อแถว |
| `app/search/page.tsx` | subtitle |

### commit 6 — `refactor(stock): หัวราคา → 5 แถวสถานะ → แนวรับ/แนวต้าน → สรุป 1 บรรทัด`

| ไฟล์ | ของเดิม → ของใหม่ |
|---|---|
| `src/lib/stock-detail/summary.ts` (+test) | ปัจจุบันคืน 3 แถว (แนวรับ / แนวต้าน / วันประกาศงบ) → เพิ่ม 5 แถวสถานะ + สรุป 1 บรรทัด · เฉพาะแถวที่มี service จริง (§3 Q5) |
| `src/components/stock/StockSummaryCard.tsx` | bullet + chevron → แถวสถานะ `StatusLabel` |
| `src/components/stock/StockDetailClient.tsx` | ลบแบนเนอร์ **"การวิเคราะห์ด้วย AI — กำลังจะมา"** (`StockDetailClient.tsx:770`) — ผิด §9 ตรง ๆ |
| `src/components/analytics/key-statistics/KeyStatisticsSection.tsx` | **เขียนใหม่ทั้งไฟล์** — ตอนนี้เป็นบรรทัดยาวบรรทัดเดียว, `slate-800` / `#151B28` hardcode, `Unavailable` / `Not meaningful` (อังกฤษ), โชว์ raw metric key (`trailingPe`) เป็นหัวข้อ, `h-28 animate-pulse` แทน `<Skeleton>`, card ซ้อน card 3 ชั้น |

### commit 7 — `refactor(tools): ชื่อ → คำอธิบาย 1 บรรทัด → ปุ่ม`

| ไฟล์ | ของเดิม → ของใหม่ |
|---|---|
| `src/lib/tools/catalog.ts` | ตัด `valuePreview[]` (3 bullet ขายของ), `sampleOutcome` ("เช่น แผนนี้ยอมเสี่ยงกี่ส่วน…"), `audience` ("เหมาะกับคนที่…") → เหลือ `title` + `description` 1 บรรทัด |
| `app/tools/page.tsx` | ตัดบล็อก "ปลดล็อกแล้วได้อะไร" + ตัวอย่าง + icon plate 36px + footer 2 แถว → ชื่อ / คำอธิบาย / ปุ่ม |
| `src/lib/tools/tools-index.contract.test.ts`, `src/components/options-simulator/tools-copy.contract.test.tsx` | อัปเดต |
| `src/lib/subscription/upgrade-copy.ts` | `benefit` ของ 3 tool ยาวเกิน → 1 บรรทัด |

### commit 8 — `refactor(planner): สถานะแผนแทนตัวเลขล้วน`

`src/components/tools/StockPlannerWorkspace.tsx` · `app/tools/stock-planner/page.tsx` (locked panel ยังเป็น `bg-[#151B28]` + `purple-500/10` + `shadow-xl`)

> ตัวเลขที่ §6 ขอ — กำไรที่คาดหวัง / ขาดทุนสูงสุด / R:R — **มีครบแล้ว** ใน `evaluateStockPlan()` (`profitAtTarget`, `lossAtStop`, `rewardToRisk`) เหลือแค่เติม "สถานะแผน"

### commit 9 — `chore(lint): คำต้องห้ามครอบ 5 หน้า`

| ไฟล์ | ทำอะไร |
|---|---|
| `src/lib/presentation/banned-copy.ts` **(ใหม่)** | ย้าย `CARD_MUST_NOT_SAY` ออกจากไฟล์เทสต์ + เพิ่ม §9: `ระบบประเมินว่า`, `จากการวิเคราะห์ปัจจัย`, `มีความเป็นไปได้ว่า`, `เครื่องมือนี้จะช่วยให้คุณ`, `AI วิเคราะห์ว่า`, `การวิเคราะห์ด้วย AI` |
| `eslint-rules/no-banned-copy.mjs` **(ใหม่)** | |
| `eslint.config.mjs` | ครอบ `app/{page,search,tools,stock}/**` + `src/components/{dashboard,search,stock,tools,analytics}/**` |
| `src/components/analytics/market-signal/MarketSignalSection.test.tsx` | ชี้ `CARD_MUST_NOT_SAY` ไปที่ module กลาง |

---

## 2. ตาราง mapping score → status (ร่าง)

`statusFromScore()` — **ข้อมูลขาด = `unknown` เสมอ ห้ามตกไป `neutral` หรือดีกว่า**

| แหล่ง | ของเดิม | → status |
|---|---|---|
| Market Signal `state` | `STRONG_BULLISH` | 🟢 good · "ขาขึ้นชัดเจน" |
| | `BULLISH` | 🟢 good · "กำลังเป็นขาขึ้น" |
| | `SIDEWAYS` | 🟡 neutral · "ตอนนี้ยังไม่มีทิศทางชัดเจน" |
| | `SQUEEZE` | 🟡 neutral · "ราคาแกว่งแคบลงเรื่อย ๆ" |
| | `OVEREXTENDED` | 🟠 weak · "ราคาวิ่งไปไกลจากค่าเฉลี่ยมาก" |
| | `BEARISH` | 🔴 bad · "กำลังเป็นขาลง" |
| | `STRONG_BEARISH` | 🔴 bad · "ขาลงชัดเจน" |
| | `result === null` (ไม่มีสิทธิ์ / โหลดไม่ได้) | ⚪ unknown · "ยังไม่มีข้อมูล" |
| Options Signal | `directionScore0to100` ตัวใหญ่บนการ์ด | ลบออกจากการ์ด · ใช้ `signalType` → level (PRIME_CALL→good, CALL_WATCH→neutral, SIDEWAYS→neutral, CONFLICTED→weak, …) |
| Stock Planner | `rewardToRisk` | ≥ 2.0 🟢 · 1.5–2.0 🟡 · 1.0–1.5 🟠 · < 1.0 🔴 · ไม่ครบ ⚪ |
| Watchlist / ตลาด | `changePercent` | > 0 🟢 · = 0 🟡 · < 0 🔴 · `null` ⚪ (**ไม่ใช่ 0**) |
| Overview service | `level: ready / connecting / degraded` | good / neutral / weak |
| ความสด (stale) | `freshness.status` | เข้า `<DataState state="stale">` ไม่ใช่ `StatusLabel` |

---

## 3. ข้อตัดสินใจ (ตอบแล้ว — 2026-08-27)

| # | คำถาม | คำตอบที่ยึด |
|---|---|---|
| Q0 | repo ค้าง merge | commit merge ตามปกติ (`Merge branch 'fix/billing-period-status-atomicity'`) แล้วแตก branch จาก main · ห้าม abort / squash · ห้ามเอาไฟล์ billing ปนเข้า Phase 1 |
| Q1 | ลำดับบล็อก Overview | เก็บครบ 6 บล็อก ไม่ลบอะไร — เรียงใหม่: ตลาดวันนี้ → การ์ดพอร์ต (สรุปบรรทัดเดียว) → Watchlist → สิ่งที่เปลี่ยนไป → ข่าว → insights |
| Q2 | VIX / US10Y | **ตัดออกจาก Phase 1** — แสดงเฉพาะที่มีจริง (S&P 500 + NASDAQ) + สรุปสถานะตลาด 1 บรรทัด |
| Q3 | "สิ่งที่เปลี่ยนไป" | derive จากข้อมูลที่หน้า Overview โหลดอยู่แล้ว 3 rule เท่านั้น (ดู §3.1) · ไม่เรียก API เพิ่ม · ไม่มีอะไรเข้าเงื่อนไข = ซ่อนทั้งบล็อก |
| Q4 | score / confidence | การ์ด = status ล้วน · dialog เก็บตัวเลข + breakdown ไว้ · "ความสอดคล้องของหลักฐาน" อยู่ใน dialog เช่นกัน |
| Q5 | 5 แถวสถานะ | ทำเท่าที่มี service จริง — แนวโน้ม / แรงส่ง (Elite, non-Elite **ซ่อนแถว** ไม่ใช่โชว์ "ล็อก") + งบการเงิน · **ไม่ทำ มูลค่าหุ้น / ความเสี่ยง** · แถวไม่มีข้อมูล = ตัดทิ้ง ห้าม "—" / "N/A" |

### 3.1 "สิ่งที่เปลี่ยนไป" — 3 rule เท่านั้น

pure function อ่านจาก payload ที่ `app/page.tsx` โหลดอยู่แล้ว ไม่มี state ใหม่ ไม่มี request ใหม่:

1. ราคาแตะ / ทะลุแนวรับ–แนวต้านที่ service เดิมคำนวณอยู่แล้ว → "NVDA ใกล้แนวต้าน" / "NVDA ทะลุแนวต้าน"
2. `changePercent` เกิน ±4% → "RKLB ลงแรง"
3. label สถานะจาก Market Signal เปลี่ยนจากบาร์ก่อน → "META เปลี่ยนเป็นทรงตัว"

ไม่มีอะไรเข้าเงื่อนไข → **ซ่อนบล็อกทั้งอัน** ห้ามโชว์ "ไม่มีการเปลี่ยนแปลง"

---

## 4. ยกไป Phase 2 (ไม่ทำใน Phase 1)

- **VIX / US10Y บนแถบตลาดวันนี้** — ต้องเพิ่ม proxy เข้า `MARKET_ASSETS` (`VIXY` / `IEF` / `^TNX`) แล้ว probe ว่า provider คืนค่าจริงไหม = แตะ data layer ซึ่งเกิน scope Phase 1
- **แถวสถานะ มูลค่าหุ้น + ความเสี่ยง + งบการเงิน บน Stock Detail** — ไม่มี service ไหนตัดสิน `analytics/fundamentals` มี **ตัวเลข** (P/E, market cap) แต่ไม่มี **คำตัดสิน** การตั้ง threshold "ค่อนข้างแพง" เองคือการเดาแล้วโชว์เป็นความจริงโดยยืมเครดิตของ service
- **"สิ่งที่เปลี่ยนไป" rule 1 (แตะ/ทะลุแนวรับ–แนวต้าน)** — ต้องใช้ `nearestSupport` / `nearestResistance` จาก market-signal ซึ่งเป็น Elite-gated + คำนวณรายตัวบนหน้า Stock ไม่ได้อยู่ใน payload ของ Overview · watchlist rows มี `sparkline: []` (ว่างจริง ๆ ดู `loadWatchlistPrices`) จึงไม่มี series ให้ derive
- **"สิ่งที่เปลี่ยนไป" rule 3 (label เปลี่ยนจากบาร์ก่อน)** — ต้องใช้ `readSignalHistory` = 1 admin query ต่อ symbol และมีแถวเฉพาะ symbol ที่เคยมีคนเปิดหน้า Stock · watchlist 10 ตัว = 10 query ต่อ render ส่วนใหญ่ได้ค่าว่าง
- **`src/components/dashboard/OverviewPortfolioGoalCard.tsx`** — ไม่มีหน้าไหน mount แล้ว (Overview ยุบเป็นบรรทัดเดียว) แต่ยังลบไม่ได้เพราะ `PortfolioGoalMascot.test.tsx` และ `PortfolioGoalSelector.test.tsx` ใช้เป็น fixture ของ mascot/selector รอตัดสินใจว่าจะย้าย fixture หรือลบ component
- **`src/lib/analytics/decision-panel/**`** — dead code 17 ไฟล์ ไม่มีใคร import รอตัดสินใจว่าจะลบหรือใช้

### 🐞 `sparkline: []` — data bug ไม่ใช่ข้อจำกัด Phase 1

- **ผู้เติม field:** `loadPriceUncached()` ([service.ts:212](src/lib/overview/service.ts#L212)) และ `unavailablePrice()` ([:118](src/lib/overview/service.ts#L118)) hardcode `[]` — ทั้งคู่คือทางเดียวที่ `loadWatchlistPrices` / `loadPortfolioPrices` ใช้ผ่าน `loadOverviewPrice`
- **สาเหตุที่ว่าง:** helper `sparkline()` ([:452](src/lib/overview/service.ts#L452)) ที่ดึง 5m candles ถูกต่อสายเข้า `loadMarketIndices()` ที่เดียว ([:535](src/lib/overview/service.ts#L535)) · path อื่นไม่เคยเรียกมันเลย และไม่มีคอมเมนต์อธิบายว่าตั้งใจ (น่าจะเลี่ยง 1 request/symbol เพราะ watchlist/portfolio ไม่จำกัดจำนวน แต่ไม่ได้เขียนไว้)
- **ระยะเวลา:** ตั้งแต่ commit แรกที่สร้างไฟล์ — `dc245b0` (2026-07-31) helper กับ `[]` เกิดพร้อมกัน = **~27 วัน**
- **กระทบ UI:** ตอนนี้ยัง**ไม่มีจอไหนพัง** — `MiniLine` ถูก render ที่เดียวคือ `MarketCard` ซึ่งได้ข้อมูลจริง · watchlist ไม่ได้วาด sparkline · `IndustryGroup.sparkline` ก็ `[]` แต่ไม่มีใคร render · `AssetCard.tsx` (ใช้ `<Sparkline>`) เป็น dead component ไม่มี call site · ผลจริงคือ **type โกหก** (`sparkline: number[]` ไม่ optional อ่านเหมือนมีข้อมูลเสมอ) และบล็อกการ derive อะไรจาก price series บน Overview (rule 1 ของ "สิ่งที่เปลี่ยนไป")
- **ข้อเสนอ Phase 2:** เลือกทางเดียว — (ก) ต่อสาย `sparkline()` เข้า `loadPriceUncached` แบบ opt-in + cache (watchlist cap 6 ตัวอยู่แล้ว) หรือ (ข) ถ้าตั้งใจไม่เติมจริง ให้เปลี่ยน type เป็น `sparkline?: number[]` แล้วเขียนเหตุผลลงคอมเมนต์ ห้ามปล่อยให้ required field คืน `[]` เสมอ

---

## 5. สิ่งที่ต่างจากแผนเดิม (ทำจริงแล้ว)

| เรื่อง | แผน | ทำจริง | เหตุผล |
|---|---|---|---|
| "สิ่งที่เปลี่ยนไป" | 3 rule | **1 rule** (%เปลี่ยน ≥ ±4%) | อีก 2 rule ต้องใช้ข้อมูลที่หน้า Overview ไม่ได้โหลด — ดู §4 |
| แถวสถานะ Stock Detail | 5 แถว | **2 แถว** (แนวโน้ม · แรงส่ง) | อีก 3 ไม่มี service ที่ตัดสิน — ดู §4 |
| ตลาดวันนี้ | แสดงเฉพาะ S&P + NASDAQ | **เรียง S&P + NASDAQ ขึ้นก่อน ไม่ลบตัวอื่น** | "เก็บทั้ง 6 ไม่ลบอะไร" · sort ไม่ใช่ filter |
| `scripts/qa/options-signal-header-qa.mts` | ไม่ได้อยู่ในแผน | **ลบ** | ทั้ง 8 ข้อที่สคริปต์วัด วัดคู่ตัวเลขบนการ์ดที่ย้ายเข้า dialog แล้ว เหลือไว้ = สคริปต์ที่ fail ตั้งแต่บรรทัดแรก |
| การ์ดพอร์ต Overview | สรุปบรรทัดเดียว | ทำแล้ว — ตัด goal card / scope selector / cash-equity-options strip / quick link 4 ปุ่ม | ทั้งหมดยังอยู่ที่ `/portfolio` |

---

## 6. ผลการตรวจ

| gate | ผล |
|---|---|
| `npm run typecheck` | ผ่าน |
| `npm run lint` | ผ่าน (รวม rule ใหม่ `portkheaw/no-banned-copy`) |
| `npm test` | **6,511 ผ่าน / 561 ไฟล์** |
| 5 หน้าที่ 390px | ไม่มี element ล้นจอ · ไม่มี `undefined` / `null` / `NaN` / `Infinity` หลุดออกหน้าจอ ทั้ง 5 หน้า |

**ข้อจำกัดของการตรวจ 390px:** รันแบบ **ไม่ล็อกอิน** (ไม่สร้าง user ใน Supabase จริง) จึงยืนยันได้เฉพาะ layout / overflow / placeholder
สิ่งที่ยังไม่ได้ตรวจสด: ลำดับเหนือ fold ของ **ผู้ใช้ที่ล็อกอินแล้ว** (ตลาดวันนี้ → การ์ดพอร์ต) และแถวสถานะ แนวโน้ม/แรงส่ง ซึ่งต้องมีสิทธิ์ Elite
ถ้าต้องการตรวจครบ ใช้ `npm run qa:phase1-ux` ซึ่งสร้าง session จริง (แตะ Supabase ของจริง)
---

## 7. Account deletion recovery

แผนกู้บัญชีที่ `deleteAccount` ค้างกลางทาง · เขียนไว้ล่วงหน้า **ยังไม่ได้รันอะไร** รอตัวเลขจาก query ชุดที่ 2 ก่อน

เอกสารปฏิบัติการฉบับเต็มคือ [`docs/operations/account-deletion-recovery.md`](docs/operations/account-deletion-recovery.md) — หัวข้อนี้ไม่แทนที่ มันคือ **ส่วนต่อขยายสำหรับบั๊ก 23503 ตัวนี้โดยเฉพาะ** และจุดที่ runbook เดิมยังไม่ครอบ

### 7.0 กฎที่ใช้กับทุกกรณี

| กฎ | เหตุผล |
|---|---|
| **ทีละคน ห้าม batch** — `--user=<uuid>` เสมอ ห้ามรัน `--apply` เปล่า ๆ | `--apply` เปล่าจะไล่ทุกแถวที่ค้าง รวมถึงคนที่เรายังไม่ได้ตรวจ |
| **verify ก่อนขั้นถัดไปทุกครั้ง** | ทุกขั้นหลัง step 3 ทำลายข้อมูลถาวร ย้อนไม่ได้ |
| **ห้ามยิง `delete` ใส่ data table เอง** | `purge_account_data` คือตัวที่รู้ลำดับ dependency · เขียนเองแปลว่าเดา |
| **ห้ามเรียก `auth.admin.deleteUser` ตรง ๆ** | มันเป็น step 6 ที่ต้องมี residual = 0 พิสูจน์ก่อน · reconciler บังคับให้ ส่วนมือเราไม่บังคับ |
| ทุกคำสั่ง **preview เป็น default** — `--apply` คือการตัดสินใจ | ตรงกับ contract ของ `account:reconcile` อยู่แล้ว |

**ลำดับใหญ่ที่ห้ามสลับ:** รัน migration `202608280001` → verify → ค่อยกู้รายคน
กู้ก่อน migration ไม่ได้ เพราะ `purge_account_data` ตัวเก่ายังล้มด้วย 23503 เหมือนเดิม

### 7.1 ⚠️ ผลข้างเคียงของ migration ที่ต้องรู้ก่อนตัดสินใจ

`202608280001` แก้ **สองฟังก์ชัน** — `purge_account_data` (ลบครบขึ้น) และ `account_residual_data_count` (นับครบขึ้น)

แปลว่า **บัญชีที่วันนี้อ่านได้ residual = 0 อาจกลายเป็น > 0 หลัง migration** ถ้ามันเคยผ่าน purge ตัวเก่าไปแล้วแต่ยังมีแถวลูกค้างอยู่

ผลที่ตามมา: **กรณี 3 บางรายจะกลายเป็นกรณี 1** และ reconciler จะ**ปฏิเสธ**ที่จะลบ auth user ให้ — ซึ่ง **ถูกต้องแล้ว** เพราะสมุดบัญชียังอยู่จริง ๆ

> อย่าตกใจถ้าตัวเลข "ค้าง" เพิ่มขึ้นหลัง migration — นั่นคือของที่ซ่อนอยู่ก่อนหน้านี้โผล่มา ไม่ใช่ของใหม่ที่เพิ่งพัง
> **ให้รัน query ชุดที่ 2 ซ้ำอีกรอบหลัง migration** แล้วใช้ผลรอบนั้นเป็นฐานในการกู้

---

### กรณี 1 — `blocked by 23503 (step 4)`

reconciler เรียกสถานะนี้ว่า **`purge_pending`** (`stage='provider_settled'`) · provider settle แล้ว ข้อมูลยังอยู่

**เงื่อนไขตรวจก่อนทำ**
- [ ] migration `202608280001` ลงบน production แล้ว และ `pg_get_functiondef('public.purge_account_data(uuid)'::regprocedure)` มีคำว่า `portfolio_transactions`
- [ ] รัน query ชุดที่ 2 **ซ้ำหลัง migration** — ยืนยันว่า user คนนี้ยัง `stage='provider_settled'` และ `purge_would_fail = true`
- [ ] `user_id` ไม่ใช่ owner account ที่ seed ไว้ (`52e7b434-1dca-4636-88ab-ea9bdf063761`)
- [ ] จดค่า `ledger_rows` / `residual_reported` ไว้ก่อน เพื่อเทียบหลังทำ

**คำสั่ง — ทีละคน**
```bash
npm run account:reconcile -- --user=<uuid>            # preview: ต้องได้ resume-purge
npm run account:reconcile -- --user=<uuid> --apply
```
`--apply` จะทำให้ครบสาย: ล้าง storage → `purge_account_data` → advance stage → วัด residual → ลบ auth user
**ไม่ต้องเรียก RPC เอง** — เรียกเองคือข้ามด่านตรวจ residual ที่ reconciler บังคับไว้

**verify ว่าสำเร็จ**
```sql
select public.account_residual_data_count('<uuid>');                          -- ต้องได้ 0
select count(*) from public.account_lifecycle where user_id = '<uuid>';       -- ต้องได้ 0
select count(*) from auth.users where id = '<uuid>';                          -- ต้องได้ 0
```
ครบสามข้อ = จบจริง (แถว lifecycle หายเพราะ cascade จาก `auth.users` — "จบ" สังเกตได้จากการ**ไม่มี**แถว)

**🛑 หยุดขออนุมัติเมื่อ**
- preview คืน `report-only` แทน `resume-purge` → สถานะไม่ตรงกับที่คาด **อย่า apply**
- `--apply` แล้ว residual ยังไม่เป็น 0 → ยังมีตารางที่ purge list ไม่รู้จักอีก ต้องหาก่อน **ห้ามลบ auth user ต่อ**
- คนแรกที่กู้สำเร็จ → **หยุด รายงาน ขออนุมัติก่อนทำคนที่ 2** (ตามกฎ 1 user พิสูจน์)

---

### กรณี 2 — `never got past step 1-3`

reconciler เรียกสถานะนี้ว่า **`closing`** (`stage='requested'`) · **migration นี้ไม่ได้แก้ให้** เพราะยังไปไม่ถึง purge เลย

**❗ แก้ความเข้าใจผิดหนึ่งข้อ:** `cancel_account_deletion` **ยังใช้ได้กับกรณีนี้** — มันทำงานได้ *เฉพาะ* ตอน `stage='requested'` และจะ raise `ACCOUNT_DELETION_IRREVERSIBLE` เมื่อพ้นไปแล้ว ([`202608060002:556`](supabase/migrations/202608060002_account_deletion_and_trial_identity.sql#L556))
กรณี 2 คือ `stage='requested'` พอดี → **ยังไม่มีอะไรถูกทำลาย และคืนบัญชีได้**
ที่คืนไม่ได้คือกรณี 1 กับ 3 ซึ่งพ้น `requested` ไปแล้ว

**สาเหตุที่ต้องดูต่อ** — ล้มที่ step 2 หรือ 3
| step | ล้มเพราะอะไร | ดูที่ไหน |
|---|---|---|
| 2 · trial ledger | เขียน `trial_identity_claims` ไม่สำเร็จ | `npm run probe:trial-retention` · ตาราง `trial_identity_claims` |
| 3 · settle provider | ยกเลิก subscription บน Stripe ไม่สำเร็จ / Stripe ไม่ตอบ | **Stripe dashboard** ดูสถานะจริงของ subscription · `billing_subscription_id` ใน `user_subscriptions` |

**เงื่อนไขตรวจก่อนทำ**
- [ ] เช็ค Stripe dashboard ก่อน — subscription ยังเก็บเงินอยู่หรือยกเลิกไปแล้ว **นี่คือข้อที่สำคัญที่สุด** เพราะคนนี้เขียนอะไรไม่ได้แต่ยังอาจถูกเรียกเก็บเงิน
- [ ] `stage='requested'` จริง (ไม่ใช่ `provider_settled`)

**คำสั่ง — เลือกทางเดียว ต้องให้ Bas ตัดสิน**

*ทาง ก. ปิดบัญชีต่อให้จบ* — reconciler ทำให้ไม่ได้ (มันไม่แตะ Stripe โดยตั้งใจ) ต้องรันผ่าน in-app pipeline จาก authenticated context: ให้เจ้าของกดลบซ้ำ หรือรันแทน · ทุก step idempotent กดซ้ำไม่ double-cancel

*ทาง ข. คืนบัญชีให้กลับมาใช้ได้*
```sql
-- ต้องได้ 'active' · ถ้า raise ACCOUNT_DELETION_IRREVERSIBLE แปลว่าไม่ใช่กรณี 2
select public.cancel_account_deletion('<uuid>');
```
ต้องแน่ใจก่อนว่า Stripe อยู่ในสถานะที่เจ้าของยอมรับได้ — คืนบัญชีทั้งที่ subscription ถูกยกเลิกไปแล้ว = คนละเรื่องกับที่เขาสมัครไว้

*ทาง ค. ปล่อยไว้* — runbook §4 บอกว่าถ้า provider ติดต่อไม่ได้นาน ปล่อยไว้ได้ บัญชีปิดรับ write และไม่มีอะไรหาย

**verify**
- ทาง ก → เหมือนกรณี 1 (residual 0 / ไม่มีแถว lifecycle / ไม่มี auth user)
- ทาง ข → `select status, stage from public.account_lifecycle where user_id='<uuid>'` ต้องได้ `active` / `null` และเจ้าของเขียนข้อมูลได้อีกครั้ง

**🛑 หยุดขออนุมัติเมื่อ** — **ทุกกรณีของกรณี 2** นี่ไม่ใช่งาน routine: เลือกระหว่างปิดบัญชีถาวรกับคืนบัญชีให้คน เป็นการตัดสินใจของ Bas ไม่ใช่ของสคริปต์ และมีเงินของจริงอยู่ปลายทาง

---

### กรณี 3 — `purged but auth user remains (step 6)`

reconciler เรียกสถานะนี้ว่า **`awaiting_auth_delete`** (`stage='data_purged'`) · ข้อมูลหมดแล้ว เหลือ auth user

**❗ ไม่มี nightly job** — ตรวจแล้ว: cron route มีตัวเดียวคือ [`app/api/cron/alerts`](app/api/cron/alerts) และไม่มี `vercel.json` / schedule ไหนเรียก `account:reconcile` เลย
**`account:reconcile` เป็นคำสั่งมือล้วน ๆ ไม่มีรอบอัตโนมัติให้รอ** ต้องมีคนรัน ถ้าอยากให้มีรอบอัตโนมัติ นั่นคืองานแยก (Phase 2)

**เงื่อนไขตรวจก่อนทำ**
- [ ] รัน query ชุดที่ 2 **หลัง migration** — เพราะ `account_residual_data_count` นับครบขึ้นแล้ว บางรายอาจเด้งไปเป็นกรณี 1 (ดู §7.1) ถ้าเด้ง → ใช้ขั้นตอนกรณี 1 แทน
- [ ] `residual_reported = 0` และ `purge_would_fail = false`

**คำสั่ง — ทีละคน**
```bash
npm run account:reconcile -- --user=<uuid>            # preview: ต้องได้ delete-auth-user
npm run account:reconcile -- --user=<uuid> --apply
```
reconciler จะ **วัด residual ใหม่** และยืนยัน stage อีกครั้งก่อนลบเสมอ — มันไม่ลบจากชื่อ stage เฉย ๆ

**verify**
```sql
select count(*) from auth.users where id = '<uuid>';                     -- 0
select count(*) from public.account_lifecycle where user_id = '<uuid>';  -- 0
```
แล้วเช็คว่า trial claim ยังอยู่ (runbook §6) — ledger คือสิ่งที่กันคนสมัครใหม่ด้วยอีเมลเดิมเพื่อเอา trial ซ้ำ การกู้ต้องไม่ลบมันทิ้ง

**🛑 หยุดขออนุมัติเมื่อ**
- preview คืน `report-only` เพราะ `residual row count unreadable` → **อ่านไม่ได้ ไม่เท่ากับ 0** ห้าม apply
- preview คืน `resume-purge` แทน `delete-auth-user` → แปลว่ากลายเป็นกรณี 1 ไปแล้ว

---

### 7.2 หลังกู้เสร็จทุกคน

```bash
npm run account:reconcile          # preview เปล่า ต้องไม่เหลืออะไรค้าง (หรือเหลือเฉพาะที่ตั้งใจ)
npm run probe:trial-retention      # ต้องสะอาด
```
แล้วรัน query ชุดที่ 1 ซ้ำ — `accounts_closed_and_unfinished` ควรเป็น 0 หรือเท่ากับจำนวนที่ตั้งใจปล่อยไว้
