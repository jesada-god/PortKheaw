# Market Signal v2 — เอกสารส่งต่อ

**ผู้อ่าน:** Claude อีกตัวที่ไม่มีสิทธิ์เข้าเครื่องนี้ เห็นเฉพาะไฟล์ที่เจ้าของอัปโหลดให้
**เขียนเมื่อ:** 2026-08-18 · branch `feat/market-signal-v2`
**ขอบเขต:** Market Signal (การ์ด Technical Outlook) เท่านั้น ไม่ใช่ Options Signal Engine

กติกาของเอกสารนี้: ทุกบรรทัดที่เป็นตัวเลขหรือข้อเท็จจริง มาจากไฟล์ในรีโปหรือจากคำสั่งที่รันจริงในเซสชันนี้
อะไรที่เดา หรือรู้แค่ครึ่งเดียว เขียนว่า **"ไม่ได้ตรวจ"** ตรงนั้นเลย ไม่เติมให้ครบ

> **ถ้าจะอัปโหลดไฟล์ให้ผู้อ่านแค่ชุดเดียว** เอาชุดนี้:
> `src/config/signal.ts` · `src/config/signal-flags.ts` · `src/lib/analytics/market-signal/types.ts` ·
> `docs/market-signal/*.md` · `__calibration__/20260818T113633Z/report.md` ·
> `__golden__/signal/IREN.json` + `__golden__/preview/IREN.json`
> เอกสารนี้สรุปทั้งหมดนั้นแล้ว แต่ไฟล์ config กับ report คือสองอันที่ควรอ่านของจริง

---

## 1. สถานะปัจจุบัน

### 1.1 Branch และ tree

| รายการ | ค่า |
| --- | --- |
| branch | `feat/market-signal-v2` (main คือ `main`) |
| commit ล่าสุด | `942068c docs(signal): audit the prediction language, and log the sign flip as an open question` |
| tree สะอาดไหม | **ไม่สะอาด** — มีงานค้างใน working tree 2 กลุ่ม (ดู 1.2) |
| `npm run typecheck` | ✅ ผ่าน (รันในเซสชันนี้) |
| test ฝั่ง signal | ✅ 385 tests ผ่าน (16 ไฟล์ใน `market-signal` + `config` + copy test, และ `MarketSignalSection.test.tsx` 58 tests) |
| `npm run test` เต็มชุด | **ไม่ได้ตรวจ** — รันเฉพาะ path ที่เกี่ยวกับ signal |
| `npm run lint` | **ไม่ได้ตรวจ** |
| `npm run snapshot:signal -- --check` | ✅ `GATE PASSED · 10 symbol(s) byte-identical` (flags OFF ทั้งหมด) |

### 1.2 อะไร commit แล้ว อะไรยัง

**Commit แล้ว** — ทั้ง P0–P6 อยู่ใน branch นี้ครบ:

| commit | คือ |
| --- | --- |
| `24468d2` | P0 — golden snapshot harness + แก้ price structure ที่อ่าน pivot เก่า 5 ปี |
| `c63f77f` | P1 — `SIGNAL_GATE` (conflict gate, bands, multiplicative confidence) |
| `ab16a15` | P1.5 — ปิดช่องว่าง 4 ข้อด้วยการวัด ไม่ใช่ assert |
| `c720813` / `9f1efad` / `4fd5200` | P2 — `SIGNAL_ZONES`, anchor เป็น swing structure, และ precedence ระหว่าง zone กับ gate |
| `02c3070` | P3 `SIGNAL_ACTIONABLE` + P4a harness + P4.5 การแก้คำบนการ์ด (มาด้วยกัน แยกไม่ได้) |
| `0bbfe6b` | ดราฟต์ 3 ฉบับให้เจ้าของอนุมัติ |
| `c1ca2ed` | P5 — วัด context 4 ตัว ไม่สร้างอะไรเลย |
| `43cb65d` | P6 — `SIGNAL_HISTORY` + migration (ยังไม่รัน) |
| `09e4773` | P4b — วัดซ้ำ ไม่มีอะไรให้ calibrate |
| `942068c` | audit ภาษาพยากรณ์ + บันทึก sign flip เป็น open question |

**ยังไม่ commit** (working tree):

| ไฟล์ | สถานะ | คือ |
| --- | --- | --- |
| `src/lib/subscription/upgrade-copy.ts` | M | เอาคำ "ความมั่นใจ" ออกจาก benefit ทั้ง Elite และ Pro-commodity (audit ข้อ 1–2) |
| `src/components/analytics/market-signal/MarketSignalSection.tsx` | M | แก้ locked preview + เพิ่ม `data-testid` (audit ข้อ 3) |
| `src/lib/analytics/glossary/terms.ts` | M | แก้ cross-reference "Confidence" ที่ค้างอยู่ (audit ข้อ 4) |
| `src/lib/subscription/technical-outlook-copy.test.ts` | ?? | test กันคำพยากรณ์กลับมา — ผ่านแล้ว |
| `src/components/.../MarketSignalSection.test.tsx` | M | test ของ locked preview |
| `scripts/collect-expected-move.ts` | ?? | collector ของ expected move |
| `src/lib/analytics/expected-move/derive.ts` · `repository.ts` | ?? | derive + storage |
| `supabase/migrations/202608180002_expected_move_collection.sql` | ?? | ตาราง `expected_move_observations` |
| `src/types/database.ts` · `package.json` | M | type ของตารางใหม่ + script `collect:expected-move` |

สองกลุ่มนี้ไม่เกี่ยวกัน: กลุ่มแรกคือ audit ภาษาที่ลงมือแก้แล้ว กลุ่มที่สองคือ collector ของ expected move ที่ P5 บอกว่า "เก็บถูกๆ แล้วลืมมันไป"
กลุ่มที่สองยัง **ไม่มี test เลยสักตัว** และอ้างถึงเอกสารที่ยังไม่มี (ดู §7)

### 1.3 Flag ทั้งหมด

ทุกตัวอ่านจาก env ผ่าน `featureFlagEnabled` ใน `src/config/signal-flags.ts` — **ไม่มีตัวไหนมี default เป็น true** และ `signal-flags.test.ts` assert ข้อนี้ไว้

| Flag | Phase | Default | ตอนนี้ | ทำอะไร |
| --- | --- | --- | --- | --- |
| `SIGNAL_GATE` | P1 | off | **ปิด** | conflict gate, bands, agreement, confidence แบบคูณ, กฎ earnings |
| `SIGNAL_ZONES` | P2 | off | **ปิด** | zone frame จาก swing structure, label มาจากโครงสร้าง, hysteresis, confirmation |
| `SIGNAL_ACTIONABLE` | P3 | off | **ปิด** | invalidation + target + R:R (อ่าน zone อย่างเดียว) |
| `SIGNAL_CONTEXT` | P5 | off | **ปิด** | **ไม่มีโค้ดอยู่หลังมันเลย** — ทุก candidate ตกการวัด |
| `SIGNAL_HISTORY` | P6 | off | **ปิด** | บันทึกสิ่งที่การ์ดพูดลง DB + strip 30 วัน |

"ตอนนี้ปิด" = ตรวจจาก `.env.local` ในเครื่องนี้ ไม่มี key `SIGNAL_*` เลย (ตรวจเฉพาะชื่อ key ไม่ได้อ่านค่าอื่น)
**สภาพแวดล้อม production ไม่ได้ตรวจ** — เข้าไม่ถึงจากที่นี่

กติกาสองข้อที่เขียนไว้ในไฟล์และควรรักษาไว้:
1. ห้ามตั้ง default เป็น `true`
2. ห้ามลบ flag ทิ้งหลัง phase ลง — **flag คือ rollback**

### 1.4 Migration ของกลุ่มนี้ — สถานะจริง

| ไฟล์ | commit แล้ว? | รันแล้ว? |
| --- | --- | --- |
| `supabase/migrations/202608180001_market_signal_history.sql` | ✅ (`43cb65d`) | **รันแล้ว** — ยืนยัน 2026-08-31 ด้วย PostgREST probe (`market_signal_history` resolve `symbol`/`as_of`/`state`/`bias`) หัวไฟล์เป็น `-- STATUS: APPLIED` แล้ว · มี test รันกับ Postgres จริง (`history-migration.test.ts`) |
| `supabase/migrations/202608180002_expected_move_collection.sql` | ✅ แต่อยู่คนละ branch — `wip/expected-move-collection` (`1854134`, 2026-08-18) ไม่มีในสายงานนี้ | **ยังไม่รัน** — `expected_move_observations` ตอบ PGRST205 ยืนยัน 2026-08-31 · ไม่มี migration test |

**สถานะ DB ตรวจแล้ว 2026-08-31** ด้วย PostgREST probe ซึ่งยืนยันได้แค่ระดับตาราง/คอลัมน์ — function, policy และ constraint มองไม่เห็น (ดู `docs/operations/migration-state.md`) ส่วนโค้ดฝั่ง repository ยังออกแบบให้ "ตารางยังไม่มี" = ไม่มี history ไม่ใช่ error ตามเดิม

---

## 2. Data flow

หนึ่งบรรทัดหนึ่งไฟล์ ตามลำดับที่ข้อมูลเดินจริง:

```
PROVIDER
  src/lib/market-data/providers/{alpaca,yahoo,stooq,alpha-vantage,...}   ดึง OHLCV ดิบ
  src/lib/market-data/candles/service.ts                                 เรียงลำดับ provider, circuit breaker, cache 6h/7d, dedupe in-flight
        │  1D · range 5y · adjusted · regular session
        ▼
ENGINE
  src/lib/analytics/market-signal/service.ts          loadMarketSignal — อ่าน flag, ดึง candles, ดึงปฏิทินงบ (เฉพาะตอน GATE เปิด), เรียก engine, ต่อ history
  src/lib/analytics/market-signal/calculations.ts     calculateMarketSignal — pure function เดียวที่ตัดสินทุกอย่าง (1,589 บรรทัด)
  src/config/signal.ts                                threshold/weight ทุกตัวอยู่ที่นี่ที่เดียว
  src/config/signal-flags.ts                          อ่าน env ทั้ง 5 ตัว
  src/lib/analytics/market-signal/history.ts          สรุป entries เป็น strip (arithmetic ล้วน)
  src/lib/analytics/market-signal/history-repository.ts  อ่าน/เขียน public.market_signal_history (service-role, fail soft)
        │
        ▼
ENTITLEMENT
  src/lib/analytics/market-signal/entitled-service.ts  loadEntitledMarketSignal — tier ไม่มี capability = คืน null โดยไม่แตะ candles เลย
        │
        ▼
PAYLOAD
  src/lib/analytics/market-signal/types.ts             MarketSignalResult — สัญญาของ payload
        │
        ▼
UI
  app/stock/[symbol]/page.tsx                          server component เรียก loadEntitledMarketSignal ใน Promise.allSettled
  src/components/stock/StockDetailClient.tsx           ส่งต่อ result + live price
  src/components/analytics/market-signal/MarketSignalSection.tsx  วาดทั้งหมด: การ์ด, ZoneBar, ActionableRows, HistoryStrip, locked preview
```

จุดที่ควรรู้:
- **ไม่มี API route** ที่เสิร์ฟ signal — เป็น server value ล้วน ผู้อ่านที่ไม่มีสิทธิ์จะไม่เจอ payload ใน HTML เลย
- `calculateMarketSignal` เป็น pure function ของ candles ที่อยู่ตรงหน้า **ไม่รู้ว่าเมื่อวานตัวเองพูดอะไร** — `recent_flip` จึงถูกเติมโดย service ไม่ใช่ engine
- ปฏิทินงบใช้ `SharedRequestCache` ตัวเดียวกับที่หน้าเพจเรียกอยู่แล้ว จึงไม่เพิ่ม provider request

---

## 3. Config — สำคัญที่สุด

ทุกค่าอยู่ใน `src/config/signal.ts` ไฟล์เดียว
คอลัมน์ **ที่มา**: `วัดมา` = มีตัวเลขจากการวัดจริงรองรับ · `ตั้งเอง` = เลือกโดยเหตุผลเชิงออกแบบ ไม่มีการวัด · `สืบทอด` = มาจาก v1 ก่อนโปรแกรมนี้เริ่ม ไม่เคยถูกตรวจ

### 3.1 v1 core — อ่านเสมอ ไม่ว่าจะเปิด flag ไหน

| key | ค่า | ที่มา | test ผูก |
| --- | --- | --- | --- |
| `SCORE_WEIGHTS` emaTrend/momentum/trendStrength/volume/priceStructure | 30/25/15/15/15 | **สืบทอด** | ไม่มี test พินค่า |
| `directional.strongBullish / bullish / bearish / strongBearish` | 60/20/−20/−60 | **สืบทอด** | อ้างในเทสต์ แต่ไม่ได้พินค่า |
| `minimumSignalCandles` | 50 | **สืบทอด** | อ้างในเทสต์ |
| `minimumAvailableWeight` | 50 | **สืบทอด** | ไม่มี |
| `ema.*` (slope lookback 5/10/20, ratio 0.01/0.003/0.03) | ตามตาราง | **สืบทอด** | บางตัวอ้าง |
| `momentum.rsi*` (75/25/45/55) | ตามตาราง | **สืบทอด** | ไม่มี |
| `momentum.macdAtrScale` | 0.2 | **สืบทอด** | ไม่มี |
| `momentum.histogramFlatAtrRatio` | 0.05 | **สืบทอด** | อ้าง |
| `trendStrength.adx*` (20/25/40) | ตามตาราง | **สืบทอด** | อ้าง 2 ตัว |
| `volume.relativeVolume*` (1 / 1.2 / 1.5) | ตามตาราง | **สืบทอด** | อ้าง 1 ตัว |
| `structure.pivotWindow` | 3 | **สืบทอด** | อ้าง |
| `structure.pivotLookbackBars` | **120** | **ตั้งเอง** — P0 แก้บั๊ก "อ่าน pivot 5 ปี" ด้วยการเลือก ~6 เดือน | อ้าง แต่ไม่พินค่า |
| `structure.breakoutBufferRatio` | 0.001 | **สืบทอด** | อ้าง |
| `sideways.evidenceRequired` | 4 จาก 4 | **สืบทอด** | ไม่มี |
| `confidence.*` (weights แบบบวก + medium 60 / high 80) | ตามตาราง | **สืบทอด** | ไม่มี — และใช้เฉพาะตอน GATE ปิด |

### 3.2 `MARKET_SIGNAL_GATE` — อ่านเฉพาะตอน `SIGNAL_GATE` เปิด

| key | ค่า | ที่มา | test ผูก |
| --- | --- | --- | --- |
| `bands.neutral / weak / strong` | 15 / 40 / 70 | **ตั้งเอง — ไม่มีหลักฐาน** | `gate.test.ts` เทสต์พฤติกรรมที่ขอบ ไม่ได้พินตัวเลข |
| `volume.belowAverageThreshold` | 1 | **ตั้งเอง** (นิยาม "ต่ำกว่าค่าเฉลี่ยตัวเอง") | อ้าง |
| `volume.belowAverageMaximumPoints` | 3 (จาก 15) | **ตั้งเอง — ไม่มีหลักฐาน** | อ้าง 2 ที่ |
| `conflictMinimumMagnitude` | 0.2 | **วัดมา** — sweep 0.10–0.30 บน 108 instruments: จำนวน label ที่เปลี่ยนคือ 29/29/27/27/25 เส้นแบน ไม่ใช่หน้าผา | ✅ `gate.test.ts` บังคับให้อยู่ใน [0.15, 0.25] |
| `divergence.minimumFlagWeight` | 0.3 | **ตั้งเอง — ไม่มีหลักฐาน** | อ้าง |
| `divergence.minimumImpactShare` | 0.2 | **ตั้งเอง — ไม่มีหลักฐาน** | ไม่มี |
| `confidence.evidenceFloor` | 0.6 | **ตั้งเอง — ไม่มีหลักฐาน** | ไม่มี |
| `confidence.completenessFloor` | 0.6 | **ตั้งเอง** และเทอมนี้ **inert** (median 1.000 ทั้ง P1.5 และ P5) | ไม่มี |
| `confidence.agreementFloor` | 0.5 | **ตั้งเอง — ไม่มีหลักฐาน** เทอมที่หนักที่สุดที่ยังมีชีวิต (median 0.850) | ไม่มี |
| `confidence.regimeClarityFloor` | 0.5 | **ตั้งเอง — ไม่มีหลักฐาน** (median 0.800, min = floor พอดี) | ไม่มี |
| `confidence.degradedDataFactor` | 0.7 | **ตั้งเอง — ไม่มีหลักฐาน** | ไม่มี |
| `confidence.conflictFactorWatchLevel` | 0.3 | **ตั้งเอง** — ไม่ใช่ clamp เป็นระดับที่เริ่มรายงาน (`conflict` ตั้งใจไม่มี floor) | มีเทสต์เฝ้าดู |
| `earnings.imminentDays / imminentFactor` | 3 / 0.5 | **ตั้งเอง (จากสเปค) — ไม่มีหลักฐาน** | ✅ พินผ่าน `earningsProximityFrom` |
| `earnings.soonDays / soonFactor` | 10 / 0.8 | **ตั้งเอง (จากสเปค) — ไม่มีหลักฐาน** | ✅ พิน |

> **P4b ปฏิเสธที่จะ calibrate ชุด `confidence.*` นี้โดยเจตนา** — ตอนจบ P1 มันถูกเรียกว่า "the obvious calibration surface for P4" แต่ไม่มี outcome signal ให้ fit ดังนั้นการขยับมันคือการขยับตัวเลขจนกว่าค่าภายในจะดูสวย ซึ่งเป็นสิ่งที่โปรแกรมนี้ตั้งใจหลีกเลี่ยง

### 3.3 `MARKET_SIGNAL_ZONE` — อ่านเฉพาะตอน `SIGNAL_ZONES` เปิด

| key | ค่า | ที่มา | test ผูก |
| --- | --- | --- | --- |
| `triggerAtrMultiple` | 0.25 | **ตั้งเอง — ไม่มีหลักฐาน** | ไม่มี |
| `confirmation.highVolumeRelative` | 1.2 | **สืบทอด** (ค่าเดียวกับ `relativeVolumeConfirmation`) | ไม่มี |
| `confirmation.barsWithoutVolume` | 2 | **ตั้งเอง — ไม่มีหลักฐาน** | ไม่มี |
| `narrowRange.minimumAtrWidth` | 1 | **ตั้งเอง** (กรอบแคบกว่า 1 วันปกติ = ไม่มีความหมาย) | ไม่มี |
| `narrowRange.atrBandMultiplier` | 1.5 | **ตั้งเอง — ไม่มีหลักฐาน** | ไม่มี |
| `expiry.maximumUntestedBars` | 60 | **ตั้งเอง — ไม่มีหลักฐาน** (ใช้ raise `stale_zone`) | ไม่มี |
| `expiry.touchToleranceAtrMultiple` | 0.25 | **ตั้งเอง — ไม่มีหลักฐาน** | ไม่มี |
| `anchor.lookbackBars` | **120** | **ตั้งเอง** — มีสคริปต์ sweep (`npm run signal:lookback`, P3.5) แต่ **ผลตัวเลขไม่ได้ถูกเก็บเป็นไฟล์ในรีโป** จึงยืนยันไม่ได้ว่ามันตัดสินอะไร → **ไม่ได้ตรวจ** | ✅ `zones.test.ts` พิน `=== 120` (พินค่า ไม่ได้พินเหตุผล) |
| `anchor.untestedReanchorBars` | 60 | **วัดมาบางส่วน** — commit `4fd5200` รายงานว่า instrument ที่ค้างบนกรอบที่ไม่มีใครแตะ ลดจาก 1 → 0 และ CL-F ขยับจาก 9.4 ATR เหลือ 3.9 ATR แต่ไม่ได้ sweep ค่าอื่น | ✅ พิน `=== 60` |
| `proximity.nearTriggerAtr` | 0.5 | **ตั้งเอง** แต่ **ความหมายของมันถูกวัดแล้ว** (ดู §6.4) และถูกยืมไปเป็นเกณฑ์ `risk_leg_inside_noise` | ✅ อ้าง 3 ที่ |
| `proximity.deepRangeAtr` | 3 | **ตั้งเอง — ไม่มีหลักฐาน** | ไม่มี |
| `walkbackBars` | 120 | **ตั้งเอง — ไม่มีหลักฐาน** | อ้าง |

### 3.4 `MARKET_SIGNAL_ACTIONABLE` / `MARKET_SIGNAL_HISTORY`

| key | ค่า | ที่มา | test ผูก |
| --- | --- | --- | --- |
| `unfavorableRiskReward` | 1 | **ตั้งเอง** — เป็นเส้น *รายงาน* ไม่ใช่ filter ไม่มีอะไรถูกกรองทิ้ง | ✅ อ้าง 2 ที่ |
| `history.stripDays` | 30 | **ตั้งเอง** (หนึ่งเดือนเทรด + พอดีจอมือถือ) | ไม่มี |
| `history.recentFlipDays` | **3** | **ตั้งเอง — และวัดไม่ได้ด้วยข้อมูลที่มี** P6 probe สุ่มทุก 5 แท่ง ละเอียดสุดคือ "เปลี่ยนภายใน 5 แท่ง" ไฟล์ config เขียนไว้ตรงๆ ว่านี่คือ product choice | ไม่มี |
| `history.retentionDays` | 400 | **ตั้งเอง** | ส่งเป็น argument ให้ `sweep_market_signal_history` ไม่ hardcode |

### 3.5 `MARKET_SIGNAL_MEASURED` — บล็อกเดียวที่เป็น "ผลการวัด" ไม่ใช่ threshold

ไม่มีอะไรใน engine แตกแขนงจากค่าพวกนี้ มันมีไว้ให้ **copy บนการ์ดอ้างอิง** เท่านั้น

| key | ค่า | test ผูก |
| --- | --- | --- |
| `runId` | `20260818T113633Z` | ✅ ต้องตรงกับ run **ล่าสุด** ใน `__calibration__/` — รัน calibrate ใหม่แล้วไม่อัปเดต config = test แดง |
| `corpusInstruments` | 108 | ✅ ตรงกับ manifest |
| `period.from / to / thai` | 2023-04 / 2026-07 / `เม.ย. 2023 – ก.ค. 2026` | ✅ ทั้งสามต้องขยับพร้อมกัน |
| `directionalEdge.largestAbsolutePp` | 0.4 | ✅ ตรวจกับ report จริง **และ** ตรวจกับช่วงความเชื่อมั่นของมันเอง |
| `directionalEdge.claimHoldsBelowPp` | 1 | เส้นบรรณาธิการ: เกินนี้ต้องเขียน copy ใหม่ |
| `pendingBreakout.*` | 53% / 21% / n=299 | ✅ |
| `proximity.*` | 65% / 51% | ✅ |

**นี่คือกลไกกันข้อมูลเก่า** และมันทำงานจริง — ตอน P4b ทดสอบตัวนี้แดงทันทีที่มี run ใหม่โผล่ใน `__calibration__/` และเขียวอีกทีเมื่ออัปเดต config

### 3.6 สรุปสิ่งที่ผู้อ่านต้องรู้มากที่สุด

**ค่าส่วนใหญ่ในไฟล์นี้ยังไม่มีหลักฐานรองรับ** มีเพียง 3 ค่าที่มีตัวเลขจากการวัดหนุนอยู่จริง:
`conflictMinimumMagnitude` (sweep เต็ม), `untestedReanchorBars` (before/after 1 ตัว), และทั้งบล็อก `MARKET_SIGNAL_MEASURED` (ซึ่งไม่ใช่ threshold)

ที่เหลือคือค่าที่คนเลือกด้วยเหตุผลเชิงออกแบบที่เขียนไว้ในคอมเมนต์ ซึ่งดี — แต่ **มันไม่ใช่หลักฐาน** และคอมเมนต์ที่ยาวและมั่นใจในไฟล์นั้นอ่านเหมือนหลักฐานได้ง่ายมาก ถ้าผู้อ่านจะเสนอให้ขยับตัวเลขไหน ให้เริ่มจากตรงนี้: มันไม่เคยถูกวัด แต่การขยับมันโดยไม่วัดก็ไม่ทำให้ดีขึ้น

---

## 4. Payload shape

`MarketSignalResult` = `MarketSignalBase` + union ของ `available` / `insufficient-data`
กติกาที่ถือมาตลอด: **ทุก phase เป็น additive** — ไม่มี field ไหนถูกลบ ไม่มี field ไหนเปลี่ยนชนิด `entitled-service.test.ts` assert ข้อนี้

### 4.1 Field ระดับบนสุด

| field | ชนิด | เงื่อนไข | หมายเหตุ |
| --- | --- | --- | --- |
| `symbol` | `string` | เสมอ | |
| `timeframe` | `'1D'` | เสมอ | ค่าคงที่ |
| `calculatedAt` | `string` (ISO) | เสมอ | |
| `latestCandleAt` | `string \| null` | เสมอ | |
| `source` | `string \| null` | เสมอ | ชื่อ provider |
| `freshness` | `DataFreshness` | เสมอ | `{status, asOf, maxAgeSeconds}` |
| `dataPoints` | `{received, finalized}` | เสมอ | |
| `scoreBreakdown` | `Record<ComponentId, ScoreComponent>` | เสมอ | 5 หมวด |
| `reasons` | `MarketSignalReason[]` | เสมอ | `{id, polarity, text, impact}` |
| `warnings` | `string[]` | เสมอ | |
| `flags` | `MarketSignalFlag[]` | เสมอ | union 20 ค่า ดู 4.3 |
| `metrics` | `MarketSignalMetrics` | เสมอ | 30 field ตัวเลข/`null` ดู 4.2 |
| `confidenceBreakdown` | 6 ตัวเลข | เสมอ | `completeness, agreement, evidenceStrength, volumeConfirmation, regimeClarity, conflictPenalty` |
| `gate?` | `MarketSignalGate` | **เฉพาะ GATE เปิด** | *หายไปทั้ง key* ไม่ใช่ `undefined` |
| `zones?` | `MarketSignalZones` | **เฉพาะ ZONES เปิด และมี ATR** | |
| `actionable?` | `MarketSignalActionable` | **เฉพาะ ACTIONABLE เปิด และมี zone** | |
| `history?` | `MarketSignalHistory` | **เฉพาะ HISTORY เปิด และมีแถวใน DB** | |

**status = `available`:**

| field | ชนิด | สถานะ |
| --- | --- | --- |
| `state` | `STRONG_BULLISH \| BULLISH \| SIDEWAYS \| SQUEEZE \| OVEREXTENDED \| BEARISH \| STRONG_BEARISH` | |
| `bias` | `bullish \| bearish \| neutral` | |
| `score` | `number` (−100…+100) | |
| `confidence` | `number` | 🔴 **deprecated** — อ่าน `evidenceAgreement` แทน ค่าเท่ากันเป๊ะ |
| `confidenceLabel` | `Low \| Medium \| High` | 🔴 **deprecated** — อ่าน `evidenceAgreementLabel` |
| `evidenceAgreement` | `number` 0–100 | **ไม่ใช่ความน่าจะเป็น** วัดว่าหลักฐาน 5 หมวดสอดคล้องกันแค่ไหน |
| `evidenceAgreementLabel` | `Low \| Medium \| High` | |

**status = `insufficient-data`:** `state/bias/score` = `null`, `confidence` = 0, `confidenceLabel`/`evidenceAgreementLabel` = `'Insufficient'`, และมี `reason: string` เพิ่มมา

> ทำไม deprecated แล้วยังอยู่: **การลบ field ไม่ใช่ additive** ถ้าจะลบต้องเป็น breaking change ที่ตั้งใจ และตอนนี้ยังไม่มีใครตัดสินใจ

### 4.2 `metrics` (30 field, ทุกตัวเป็น `number \| null` เว้นที่ระบุ)

จัดกลุ่มแทนการไล่ทีละแถว: `close` · EMA (`ema20/50/200` + slope % ทั้งสาม + `emaCompressionRatio`) · momentum (`rsi14`, `macd`, `macdSignal`, `macdHistogram`) · trend strength (`adx14`, `plusDi14`, `minusDi14`) · volume (`relativeVolume20`, `obvTrend: 'rising'|'flat'|'falling'|null`) · แถบ (`bollinger*`, `keltner*`, `squeezeOn: boolean|null`) · ระยะ (`atr14`, `ema20DeviationPct`, `atrNormalizedDistance`) · โครงสร้าง (`nearestSupport`, `nearestResistance`, `divergence: 'bullish'|'bearish'|null`)

⚠️ `nearestSupport` / `nearestResistance` **ไม่ใช่กรอบของ zone** — มันคือแนวที่ใกล้ราคาปัจจุบันที่สุด การ์ดเรียกมันว่า "แนวใกล้สุด" คนละอย่างกับ `zones.support/resistance` (ดู §9)

### 4.3 `flags` — 20 ค่า แยกตาม phase

| phase | flags |
| --- | --- |
| v1 (เสมอ) | `squeeze` `overextended` `high_volume` `bullish_divergence` `bearish_divergence` `strong_momentum` `weak_confirmation` |
| P1 GATE | `conflicting_evidence` `low_volume_confirmation` `stale_or_partial_data` `earnings_imminent` `earnings_soon` `pre_earnings_breakout` |
| P2 ZONES | `pending_breakout` `pending_breakdown` `stale_zone` `narrow_range` |
| P3 ACTIONABLE | `unfavorable_risk_reward` `risk_leg_inside_noise` |
| P6 HISTORY | `recent_flip` — **ตัวเดียวที่ service เติม ไม่ใช่ engine** |

### 4.4 ตัวอย่างจริง — IREN, ปิดทุก flag vs เปิด

ที่มา: `__golden__/signal/IREN.json` (baseline) เทียบ `__golden__/preview/IREN.json` (preview)
input เดียวกันเป๊ะ (`__golden__/candles/IREN.json`, `calculatedAt` พินไว้ที่ `2026-01-01T00:00:00.000Z`)

> ⚠️ "เปิดทุก flag" ในไฟล์ preview = **GATE + ZONES + ACTIONABLE** เท่านั้น
> `SIGNAL_CONTEXT` ไม่มีโค้ดหลังมัน และ `SIGNAL_HISTORY` ต้องมี DB จริง snapshot ทำแทนไม่ได้ → **ไม่มี golden ของ history**

| field | ปิดทุก flag | เปิด (gate+zones+actionable) |
| --- | --- | --- |
| `state` | `BULLISH` | `BULLISH` |
| `bias` | `neutral` | `bullish` |
| `score` | **16** | **11** (volume ถูก cap เพราะ rel-vol ต่ำกว่าค่าเฉลี่ย) |
| `confidence` / `evidenceAgreement` | **62** (Medium) | **27** (Low) |
| `flags` | `bullish_divergence`, `strong_momentum` | `strong_momentum`, `risk_leg_inside_noise`, `conflicting_evidence`, `low_volume_confirmation` |
| `warnings` | 0 ข้อ | 1 ข้อ |
| `reasons` | 10 ข้อ | 11 ข้อ |
| `gate` | *ไม่มี key* | มี |
| `zones` | *ไม่มี key* | มี |
| `actionable` | *ไม่มี key* | มี |

`confidenceBreakdown` ขยับด้วย (คนละสูตร: บวก → คูณ):

| | completeness | agreement | evidenceStrength | volumeConfirmation | regimeClarity | conflictPenalty |
| --- | --- | --- | --- | --- | --- | --- |
| ปิด | 93 | 84 | 36 | 50 | 27 | 10 |
| เปิด | 100 | 40 | 32 | 80 | 18 | 10 |

**`gate` ที่โผล่มา:**
```
band: 'neutral'          conflicts: ['ema_vs_momentum']      forcedNeutral: false
earningsProximity: 'unknown'   daysToEarnings: null
confidenceFactors: base 72.66 × completeness 1 × agreement 0.7
                   × regimeClarity 0.5917 × conflict 0.9 × earnings 1  →  27
```

**`zones` ที่โผล่มา:** frame `structural` · support 28.93 · resistance 42.24 · upperTrigger 43.2544 · lowerTrigger 27.9156 · close 44.06 (2026-08-14)
→ `positionPct` **113.7** (ตั้งใจไม่ clamp) · `zone: 'uptrend'` · `nearestTriggerAtr −0.2` (ติดลบ = ข้ามมาแล้ว) · `proximity: 'near_trigger'` · `zoneAgeBars 1` · `frameAgeBars 1` · `triggerCrossings 29`

**`actionable` ที่โผล่มา:** invalidation 42.24 (`zone_floor`, 0.45 ATR, 4.13%) · target 58.51 (`measured_move`, 3.56 ATR, `targetIsConvention: true`) · riskReward **7.94** · notes `['risk_leg_inside_noise']`

IREN คือกรณีที่สอนอะไรได้เยอะที่สุดในสิบตัว: มันเป็น **1 ใน 3 instrument จาก 108 (2.8%) ที่มี zone มีทิศทาง และ gate เจอ conflict พร้อมกัน** — เป็นเคสที่ตัดสินกฎ precedence ใน §5 และ R:R 7.94 ของมันคือหนึ่งในสี่ค่าสูงสุดของ corpus ที่ล้วนเกิดจากราคาปิดนั่งอยู่บน invalidation ของตัวเอง ไม่ใช่จากสัญญาณที่ดีกว่า

**สิบตัวใน golden set** (flags OFF, จาก gate run ล่าสุด): IREN BULLISH/16/62 · SPY BULLISH/59/74 · QQQ BULLISH/54/70 · DIA BULLISH/57/73 · IWM BULLISH/58/73 · REMX BULLISH/4/62 · GC-F BULLISH/53/70 · SI-F BULLISH/41/63 · CL-F SIDEWAYS/7/69 · BTC-USD SQUEEZE/−12/74
สังเกต REMX: score 4 แต่ได้ `BULLISH` — นี่คือปัญหาที่ `SIGNAL_GATE` มีไว้แก้

---

## 5. กฎที่ตัดสิน label

```
# ---- ขั้นที่ 0: สิ่งที่คำนวณเสมอ ----
scoreBreakdown = 5 หมวด (weights 30/25/15/15/15)
score          = Σ points, normalize เป็น -100..+100
regime         = classifyRegimeEvidence(metrics)   # squeeze / overextended / sideways
bias_v1        = biasFromScore(score)              # ±20

# ---- ขั้นที่ 1: GATE คำนวณสิ่งที่ตัวเองจะใช้ (เฉพาะเมื่อเปิด) ----
if gateOn:
    band       = bandFromScore(|score|)            # <15 neutral | <40 weak | <70 moderate | else strong
    conflicts  = detectComponentConflicts()        # ema↔momentum, structure↔momentum
                                                   # นับเฉพาะหมวดที่ใช้ range >= 0.2 ของตัวเอง
    earningsPx = imminent(<=3d) | soon(<=10d) | clear | unknown
    gatedBias  = neutral ถ้า (conflicts ไม่ว่าง หรือ band == neutral) มิฉะนั้นตาม sign(score)

# ---- ขั้นที่ 2: ZONES คำนวณกรอบ (เฉพาะเมื่อเปิด) ----
if zonesOn:
    zones = calculateTrendZones()   # anchor = swing high/low ล่าสุดใน lookbackBars
                                    # entry ต้องปิดเลย level ± 0.25 ATR
                                    # confirm ด้วย rel-vol >= 1.2x หรือ ปิดยืน 2 แท่ง
                                    # exit แค่ปิดกลับเข้ามาใน level  (hysteresis ไม่สมมาตรโดยตั้งใจ)
    zoneBias = uptrend→bullish | downtrend→bearish | sideways→neutral

# ---- ขั้นที่ 3: ตัดสิน label ----
# ทั้งสามเส้นทางเริ่มเหมือนกัน: regime มาก่อนทุกอย่าง
if regime.squeeze:      state = SQUEEZE          # veto สูงสุด
if regime.overextended: state = OVEREXTENDED     # veto รองลงมา

if zones exists:                                  # (ก) โครงสร้างเป็นคนตั้งชื่อ
    if zone == sideways:
        # ★ P7 — เดิมบรรทัดนี้คือ `state = SIDEWAYS` เฉยๆ
        # trend_diagnosis.md §B วัดว่า บรรทัดเดียวนี้คือ 100% ของ 11,330 แท่ง
        # ที่ ground truth บอกว่าเป็นเทรนด์แต่ engine ตอบ SIDEWAYS
        # และบนแท่งชุดเดียวกัน engine flags-OFF เรียกทิศถูก 95.3%
        if conflicts ว่าง and band >= RANGE_DIRECTION.minimumBand:
            state = BULLISH/BEARISH ตาม sign(score)   # ไม่มีทาง STRONG_* จากในกรอบ
        elif conflicts ว่าง and band >= RANGE_DIRECTION.retentionBand
             and แท่งก่อนหน้าเรียกทิศเดียวกัน:
            state = BULLISH/BEARISH ตามเดิม           # buffer margin (เข้ายากกว่าอยู่)
        else:
            state = SIDEWAYS
    else:
        state = STRONG_* ถ้า presentationState() ยืนยัน  มิฉะนั้น BULLISH/BEARISH ตาม zone
    if gateOn and conflicts ไม่ว่าง:
        state = demoteStrong(state)               # STRONG_* → BULLISH/BEARISH เท่านั้น
                                                  # ★ conflict ไม่ลบทิศทางทิ้งอีกต่อไป

elif gateOn:                                      # (ข) gate อย่างเดียว
    if gatedBias == neutral: state = SIDEWAYS     # conflict หรือ |score| < 15 → SIDEWAYS
    else:
        state = presentationState(...)
        if state คือ STRONG_* and (band != strong or earningsPx == imminent):
            state = BULLISH/BEARISH               # ลดชั้น

else:                                             # (ค) v1
    state = presentationState(score, bias_v1, ...)

# ---- ขั้นที่ 4: hold rule (P8) — ทำหลังสุด กับ label เท่านั้น ----
# trend_agreement.md §1 วัดว่า flip ratio = 1.63 (OFF) / 1.17 (ON)
# เกิน 1.0 แปลว่าการ์ดเปลี่ยนคำบ่อยกว่าสิ่งที่มันอธิบายเปลี่ยน
rawState = state
if มี gap หรือ true range >= 2 × ATR14(แท่งก่อน):
    published = rawState                          # ตลาด reprice แล้ว ไม่ต้องรอ
else:
    published = ค่าล่าสุดใน [raw(t), raw(t-1), raw(t-2)]
                ที่ยืนติดกันครบ minDurationBars (2) แท่ง
                มิฉะนั้น = rawState
# raw(t-1), raw(t-2) ได้จากการเรียก calculateMarketSignal ซ้ำบน
# finalized.slice(0, -k) — engine ยังเป็น pure function เหมือนเดิม
# `replayDepth` กันไม่ให้ replay ซ้อน replay → ต้นทุน = lookbackBars ครั้ง (วัดได้ 92ms → 306ms)
#
# ★ score / evidenceAgreement / confidence / reasons / flags / gate
#   คำนวณจาก rawState ทั้งหมด และ **ไม่** คำนวณใหม่ตรงนี้
#   §6.8 ห้ามอายุ label เป็น input ของ threshold ใดๆ — นี่คือกฎเดียวกันอ่านกลับทาง

# ---- ขั้นที่ 5: bias สุดท้าย ----
bias = ทิศของ published            ถ้า hold rule เปลี่ยนคำ  # การ์ดต้องสีเดียวกับคำที่พูด
     : zoneBias  ถ้ามี zone         # ★ ราคาอยู่ตรงไหนก็คือตรงนั้น แม้หลักฐานจะเถียงกัน
       (P7: ถ้ากรอบ sideways แต่หลักฐานเรียกทิศ zoneBias ตามทิศนั้น)
     : gatedBias ถ้า gateOn
     : bias_v1
```

**สองเลขอายุ ไม่ใช่เลขเดียว (P8).** hold rule ทำให้ป้ายที่เผยแพร่ยืนนานขึ้นเสมอ ถ้าการ์ดโชว์อายุของป้ายที่ถูก hold ตัวเลขจะโตขึ้นด้วยเหตุผลที่ไม่เกี่ยวกับตลาดเลย ซึ่ง §6.8 ห้ามไว้ตรงๆ payload จึงมี `persistence.rawState` และ history มีสองเลข: `currentLabelDays` (ป้ายที่เผยแพร่) กับ `currentRawLabelDays` (ค่าที่อ่านได้จริง) — **การ์ดอ่านตัวหลังเท่านั้น** และมี test บังคับข้อนี้

`presentationState` (ตัวร่วมของทุกเส้นทาง) จะให้ `STRONG_*` ต่อเมื่อครบทุกข้อ: `|score| >= 60` **และ** หมวดเห็นด้วย ≥ 4 จาก 5 **และ** `ADX >= 25` **และ** rel-vol ≥ 1.5 **และ** trendStrength ชี้ทางเดียวกัน

### อะไร veto อะไรได้

| ตัว veto | ยับยั้งอะไร | ทำงานเมื่อ |
| --- | --- | --- |
| `regime.squeeze` | **ทุกอย่าง** — เขียนทับ label เป็น SQUEEZE ทุกเส้นทาง | เสมอ |
| `regime.overextended` | ทุกอย่างที่เหลือ → OVEREXTENDED | เสมอ |
| `regime.sideways` / non-trending fallback | ทิศทาง → SIDEWAYS | เฉพาะเส้นทาง v1 และ gate |
| `conflicts` (gate) | **ทั้งทิศทาง** → SIDEWAYS | GATE เปิด **และ ZONES ปิด** |
| `conflicts` (gate) | **แค่ STRONG_*** ลดเป็น BULLISH/BEARISH | GATE **และ** ZONES เปิดพร้อมกัน |
| `band == neutral` (\|score\| < 15) | ทิศทาง → SIDEWAYS | GATE เปิด **และ ZONES ปิด** |
| `earningsPx == imminent` | STRONG_* เท่านั้น | GATE เปิด (เส้นทาง gate) |
| ~~`zone == sideways`~~ | ~~ทิศทางทั้งหมด~~ → **P7: ไม่ veto แล้ว** ถ้า conflicts ว่าง และ band ถึง `minimumBand` | ZONES เปิด |
| `conflicts` (P7, ในกรอบ) | ทิศทางที่จะมาจากหลักฐาน → SIDEWAYS | ZONES **และ** GATE เปิด และ zone == sideways |
| `band < minimumBand` (P7) | ทิศทางที่จะมาจากหลักฐาน → SIDEWAYS | ZONES **และ** GATE เปิด และ zone == sideways |
| hold rule (P8) | การ *เปลี่ยน* คำ จนกว่าค่าใหม่จะยืนครบ `minDurationBars` | เสมอ ทั้งสอง flag state |
| gap / true range >= 2×ATR | ยกเลิก hold rule สำหรับแท่งนั้น | เสมอ |
| hysteresis + confirmation | การ *เข้า* zone ใหม่ (ออกง่ายกว่าเข้า) | ZONES เปิด |
| `mode == atr_band` | invalidation และ target ทั้งคู่ | ACTIONABLE เปิด |
| `invalidation == null` | target และ R:R (ไม่มี target ถ้าไม่มี invalidation เด็ดขาด) | ACTIONABLE เปิด |

**จุดที่ต้องอ่านสองรอบ:** เมื่อ ZONES เปิด `band` **ไม่บังคับ** SIDEWAYS อีกต่อไป และ conflict **ไม่ลบทิศทาง** เหตุผลที่บันทึกไว้: zone ตอบว่า "ราคาไปถึงไหนแล้ว" ซึ่งเป็น *ข้อเท็จจริง* ส่วน gate ตอบว่า "หลักฐานหนุนแค่ไหน" ซึ่งเป็น *คุณภาพ* — คนละคำถาม การ์ดจึงแสดงทั้งคู่แทนที่จะให้อันหนึ่งลบอีกอันทิ้ง
วัดผลกระทบไว้แล้ว: 3 จาก 108 instrument (2.8%) เข้าเงื่อนไขนี้ ซึ่งอยู่ห่างจาก 30% ที่จะทำให้กฎนี้เป็นกฎที่ผิดมาก

**P7 คือหลักการเดียวกันนี้ ใช้กับกรอบ.** `zone == sideways` เคยลบทิศทางทิ้งแบบไม่มีเงื่อนไข ซึ่งเป็นสิ่งเดียวกับที่ conflict เคยทำก่อนจะถูกแก้ — และ `trend_diagnosis.md` §B วัดราคาของมันไว้: **11,330 แท่ง** (100% ของแท่งที่ ON ตอบ SIDEWAYS ทั้งที่ ground truth บอกว่าเป็นเทรนด์) โดยที่ engine flags-OFF เรียกทิศถูกบน **95.3%** ของแท่งชุดเดียวกัน คำตอบมีอยู่แล้ว แค่ถูกปิดปาก
§C ของไฟล์เดียวกันขยับ threshold ที่กรอบเป็นเจ้าของทั้งสองตัว ±20% แล้ววัดว่ากู้คืนได้เท่าไร: **มากสุด 428 จาก 11,330 แท่ง (3.8%)** — ต้นเหตุจึงไม่ใช่ตัวเลข และ P7 ไม่ได้ขยับตัวเลขไหนเลย (`minimumBand` อ้างชื่อ band ที่ `MARKET_SIGNAL_GATE.bands` นิยามไว้อยู่แล้ว)
ผลที่วัดได้จริงอยู่ใน `trend_persistence.md` พร้อมเกณฑ์ผ่านที่เขียนก่อนรัน

---

## 6. ผลการวัด

ทุกตัวเลขในหมวดนี้มาจาก `__calibration__/20260818T113633Z/report.md` (P4b ซึ่งเท่ากับ P4a byte-for-byte) และจาก `docs/market-signal/*.md`

**นิยามสองคอลัมน์ที่รับน้ำหนักทั้งหมด:**
- `clust` = subset ที่ใหญ่ที่สุดซึ่ง **ไม่มี outcome bar ทับกัน** — ที่ horizon 20 แท่ง stride 5 แท่ง `n` ดิบพองเกินจริงประมาณ 4 เท่า
- `edge` = signal − base rate โดย base คือ instrument เดียวกัน วันเดียวกัน ถ่วงเป็น long/short mix เดียวกัน **ตัวเลข hit rate ที่ไม่มี base rate ไม่ได้บอกอะไร** — ในตลาดขาขึ้น สัญญาณซื้อทุกตัวดูแม่นหมด

### 6.1 P4a — headline

```
corpus 108 instruments · 14,154 observations · stride 5 · 2023-04-09..2026-07-27 (403 as-of dates)
directional 3,629 (25.6%) · both barriers 2,562 (18.1%) · window self-check 36/36 ผ่าน
bucket guard: n < 30 = insufficient และ "ห้ามรวม bucket เพื่อให้ถึง 30"
```

| horizon | signal | n | clust | base | n | **edge** |
| --- | --- | --- | --- | --- | --- | --- |
| 5 | 51.4% | 3626 | 3626 | 51.3% | 14143 | **+0.0pp** |
| 10 | 51.4% | 3626 | 2510 | 51.6% | 14146 | **−0.2pp** |
| 20 | 51.5% | 3628 | 1853 | 51.9% | 14148 | **−0.4pp** |

ทุกช่องอยู่ในความคลาดเคลื่อนของตัวเอง (±2.3pp ที่ 20 แท่ง บน 1,853 observation อิสระ)
คำที่การ์ดพูดคือ **"ยังไม่พบ"** ไม่ใช่ "ไม่มี" — เป็นข้ออ้างที่เล็กกว่าและเป็นข้อที่หลักฐานรองรับ

**แยกตาม regime** (SPY 200-day):

| regime | 5 | 10 | 20 | หมายเหตุ |
| --- | --- | --- | --- | --- |
| up | +0.0pp | +0.5pp | −0.6pp | n ใหญ่ (clust 3338/2320/1724) |
| down | +5.1pp | −4.9pp | +4.1pp | **clust แค่ 225/186/171 และสลับเครื่องหมาย — อ่านไม่ได้** |

**Criterion A** (target ถึงก่อน invalidation ซึ่งเป็นสิ่งที่การ์ดอ้างตรงๆ):

| horizon | signal | clust | control | edge | unresolved | target/all |
| --- | --- | --- | --- | --- | --- | --- |
| 5 | 37.7% | 1384 | 37.7% | +0.1pp | 1178 | 20.4% |
| 10 | 39.2% | 1502 | 39.1% | +0.1pp | 720 | 28.2% |
| 20 | 40.5% | 1408 | 39.4% | +1.2pp | 335 | 35.2% |

`target/all` คือเลขที่คนรออยู่จริงจะรู้สึก — ที่ 5 แท่ง มีแค่ 1 ใน 5 ที่ถึงเป้า

### 6.2 Reliability table ของ `evidenceAgreement`

นี่คือตารางที่ตัดสินว่าจะไม่มีการ calibrate

| bucket | reported | hit @5 | hit @10 | hit @20 | clust @20 | **gap @5** |
| --- | --- | --- | --- | --- | --- | --- |
| 10-19 | 15.6% | insuff. | insuff. | insuff. | 7 | — |
| 20-29 | 25.2% | 53.0% | 53.0% | 44.3% | 110 | **+27.8pp** |
| 30-39 | 34.5% | 47.3% | 43.5% | 44.4% | 157 | +12.8pp |
| 40-49 | 44.6% | 53.4% | 46.6% | 46.6% | 192 | +8.8pp |
| 50-59 | 54.5% | 53.1% | 52.7% | 48.7% | 293 | −1.4pp |
| 60-69 | 64.8% | **45.8%** | 46.2% | 46.2% | 339 | −19.0pp |
| 70-79 | 75.6% | 53.8% | 52.7% | 53.3% | 560 | −21.7pp |
| 80-89 | 84.6% | 49.9% | 51.6% | 53.7% | 760 | −34.7pp |
| 90-99 | 93.5% | 53.3% | 54.6% | 55.0% | 532 | **−40.2pp** |

**สองสิ่งที่ฆ่าการ calibrate และเป็นคนละเรื่องกัน:**
1. **มันแบน** — hit rate กวาดแค่ 45.8%–53.8% ตลอดทั้งช่วง เทียบ base ~51% mapping ที่ fit จากนี้คือ *ค่าคงที่ที่ใส่ชุดของฟังก์ชัน*
2. **มันไม่ monotone ด้วยซ้ำ** — bucket 60-69 ได้ 45.8% ขณะที่ 20-29 ได้ 53.0% ถ้า fit ตามรูปจริงจะได้ "ความน่าจะเป็น" ที่ **ลดลง** เมื่อหลักฐานสอดคล้องกันมากขึ้น

ผลลัพธ์: `evidenceAgreement` ยังเป็นสิ่งที่ P4.5 ทำให้เป็น — ตัววัดความสอดคล้องของหลักฐานตัวเอง แสดงบนการ์ด**เป็นคำ ไม่ใช่ %** และตัวเลขย้ายไปอยู่ในหน้า "ทำไม?" คู่กับสิ่งที่ประกอบมันขึ้นมา

**เช็คลิสต์ 5 ข้อก่อนใครจะเสนอ remap อีก** (จาก `p4b-findings.md` §6): edge ต้องอยู่นอกช่วงความเชื่อมั่นที่ **มากกว่าหนึ่ง horizon** · เครื่องหมายเดียวกันทั้งสองครึ่งของ split · hit rate **monotone** ในสิ่งที่กำลัง calibrate · observation อิสระพอที่ guard `n>=30` ไม่ใช่ตัวตัดสินว่า bucket ไหนมีอยู่ · เขียน remap ลงกระดาษและตกลงกัน **ก่อน** implement
**ข้อแรกตกทันที**

### 6.3 สามสมมติฐานที่ถูกทดสอบ

| สมมติฐาน | ที่มา | ผล |
| --- | --- | --- |
| **proximity** — `near_trigger` แปลว่า label เปราะ | P2.6 อ้างไว้ ไม่มีใครเช็ค | **ถูก แต่แคบกว่าที่คิดมาก** ดู 6.4 |
| **conflict** — gate ควรลด confidence ตอนหลักฐานขัดกัน | P1 สร้างขึ้น | **ครึ่งเดียว** ดู 6.5 |
| **pending breakout** — "รอปิดยืนยัน" อ่านเหมือนเหตุการณ์ที่กำลังจะมา | ภาษาบนการ์ด | **ผิด** ดู 6.6 |

### 6.4 proximity — เปราะจริง แต่ไม่ได้แปลว่าผิด

**ความแม่นยำ ไม่ต่างกันเลยทุก horizon:**

| bucket | edge @5 | @10 | @20 | clust @20 |
| --- | --- | --- | --- | --- |
| near_trigger | +1.8pp | −0.2pp | −1.1pp | 554 |
| mid_range | +0.4pp | −0.4pp | −0.4pp | 1461 |
| deep_range | −3.3pp | +0.6pp | +0.1pp | 438 |

**อายุของ label ต่างกันจริง — แต่แค่ที่ 5 แท่ง:**

| proximity | zone เปลี่ยน @5 | @10 | @20 |
| --- | --- | --- | --- |
| near_trigger | **64.8%** | 78.9% | 83.0% |
| mid_range | 60.4% | 78.2% | **84.1%** |
| deep_range | **51.4%** | 74.4% | 81.5% |

ที่ 5 แท่งช่องว่าง 13.4pp ที่ 20 แท่งเหลือ 1.5pp และ `mid_range` กลายเป็นตัวที่อยู่สั้นที่สุด — **ลำดับพังที่ horizon ยาว**

**ผลผูกพันกับ UI:** ห้ามให้อะไรใน UI สื่อว่า `deep_range` คือสัญญาณที่น่าเชื่อถือกว่า มันไม่ใช่ ตอนนี้การ์ดพูดว่า `near_trigger` = "ป้ายนี้มีโอกาสเปลี่ยนภายในไม่กี่แท่ง" และ `deep_range` = "อยู่ห่างจากทุกแนว N ATR" เฉยๆ ซึ่งถูกต้องตามที่วัดได้

### 6.5 conflict — gate ได้ค่าตัวเองคืนครึ่งเดียว

| bucket | edge @5 | @10 | @20 | clust @20 |
| --- | --- | --- | --- | --- |
| conflict | +0.3pp | −0.0pp | **−3.5pp** | 390 |
| no conflict | +0.0pp | −0.2pp | +0.0pp | 1694 |

อ่านตรงๆ: ที่ 20 แท่ง สัญญาณที่มี conflict แย่กว่า base rate 3.5pp ขณะที่สัญญาณไม่มี conflict เท่ากับ base เป๊ะ ทิศทางถูก แต่ **มันมีอยู่ที่ horizon เดียว** และ 390 observation อิสระที่ 20 แท่งให้ช่วงความเชื่อมั่นราว ±5pp ดังนั้นนี่คือ "ไม่ขัดกับเหตุผลที่สร้าง gate" ไม่ใช่ "พิสูจน์ว่า gate ถูก"

**ของแถมที่ P3.5 ถาม — R:R ที่พุ่งเพราะขา risk สั้น:**

| risk leg | edge @5 | @10 | @20 |
| --- | --- | --- | --- |
| < 0.5 ATR | +0.5pp | +0.5pp | −0.8pp |
| 0.5–1.5 ATR | +4.4pp | +1.8pp | +0.1pp |
| 1.5–3 ATR | −1.1pp | −2.3pp | −1.4pp |
| ≥ 3 ATR | −3.1pp | +0.5pp | +1.1pp |

bucket `< 0.5 ATR` **ไม่ได้ดีกว่า** — ซึ่งเป็นเหตุผลที่ R:R 17.79 ไม่ถูกลบทิ้ง (มันคำนวณถูก) แต่ถูก **ติดป้าย** `risk_leg_inside_noise` แทน

### 6.6 pending breakout / breakdown — และ SIDEWAYS

| flag | horizon | confirmed | กลับเป็น sideways | n |
| --- | --- | --- | --- | --- |
| pending_breakout | 5 | **53.2%** | 45.0% | 220 |
| pending_breakout | 10 | 27.6% | 64.5% | 217 |
| pending_breakout | 20 | **21.2%** | 70.8% | 212 |
| pending_breakdown | 5 | 42.5% | 55.0% | 120 |
| pending_breakdown | 20 | 17.9% | 63.2% | 117 |

**SIDEWAYS — ป้ายอยู่นานกว่าสิ่งที่มันบรรยาย:**

| horizon | ยังเป็น sideways | ราคายังอยู่ในกรอบ | n |
| --- | --- | --- | --- |
| 5 | 79.3% | 62.9% | 10525 |
| 10 | 73.8% | 44.8% | 10525 |
| 20 | **72.6%** | **25.7%** | 10525 |

ช่องว่าง 72.6% vs 25.7% คือข้อค้นพบที่ผูกมัด P6 มากที่สุด — **label มีอายุยืนกว่าเรื่องที่มันเล่า**

**Full cross** (zone × proximity × conflict × confidence, 10 แท่ง): 26 ช่องมีตัวเลข **49 ช่องถูก guard ตัด** ไม่มีการรวม bucket เพื่อให้ถึง 30 เพราะการรวมคือการเปลี่ยนคำถามโดยไม่มีใครเห็น

### 6.7 P5 — สี่ candidate และเหตุผลที่ไม่ผ่าน

เกณฑ์จากบรีฟ: สร้างแยก → วัดกับ base rate เดียวกับ P4a → **ต่ำกว่า 1pp ทุก horizon = ไม่สร้าง รายงานแล้วข้าม**
ทุกตัวหยุดที่ขั้น 3 (หรือที่การทดสอบนัยสำคัญข้างๆ มัน) ขั้น 4-5 ไม่เคยถูกไปถึง **ไม่มีไฟล์ engine ไหนถูกแตะเลย**

| candidate | largest \|edge\| | ±adj (Bonferroni, บน clust) | ผล |
| --- | --- | --- | --- |
| relative strength vs SPY (63b, 2% band) | 0.67pp | ±1.3 / ±1.8 / ±2.5pp | **SKIP** — ต่ำกว่า 1pp ทุก horizon และติดลบที่ 10/20 แท่ง (ของที่ชนะ SPY มาทั้งไตรมาส *มีโอกาสไปต่อน้อยกว่า* base rate เล็กน้อย) train −1.1/−1.6/−2.4 vs test +1.6/+1.7/+1.7 |
| volatility compression + 20-bar move | **1.75pp** | ±2.6 / ±3.3 / **±4.0pp** | **SKIP — แต่เป็นตัวที่น่าสนใจที่สุด** +1.4/+1.4/+1.8pp เครื่องหมายเดียวกันทุก horizon และ control แบบ ungated ได้แค่ +0.3/+0.0/+0.5 (แปลว่า compression เพิ่มราว 1.3pp ด้วยตัวมันเอง) ตกเพราะพูดแค่ 3,103 วัน = **1,273 ข้อเท็จจริงอิสระ** ที่ 20 แท่ง +1.8pp ในแถบ ±4.0pp คือตัวเลข ไม่ใช่ข้อค้นพบ train +1.8/+1.7/+1.0 vs test +0.7/+0.9/+2.8 — เครื่องหมายเดียวกัน (ดีที่สุดในสี่ตัว) แต่ขนาดไม่นิ่ง |
| momentum ungated (control ของตัวบน) | 0.49pp | ±1.2 / ±1.7 / ±2.4pp | **SKIP** — และมันคือสิ่งที่ vol gate ควรจะชนะให้ได้ |
| price vs volume POC (120b, 0.5 ATR) | 0.90pp | ±1.3 / ±1.8 / ±2.4pp | **SKIP** — ผิดเครื่องหมายที่ 5 และ 10 แท่ง train −2.1/−1.9/−0.9 vs test +0.9/+1.3/+2.1 พูดตรงๆ: ไม่ได้แปลว่า volume profile ไร้ค่าบนกราฟ แปลว่าข้ออ้าง "ราคาเหนือ POC ไปต่อขึ้น" ไม่รอดการวัด และนั่นคือข้ออ้างเดียวที่ engine ทำอะไรกับมันได้ |
| **Options / Expected Move** | — | — | **วัดไม่ได้ ไม่ใช่ตก** — corpus เป็น OHLCV ไม่มี provider ไหนใน project นี้ backfill historical chain จึงไม่มีทางรู้ว่า expected-move band จะพูดอะไรวันที่ 2024-03-15 อีกสามตัวสอบตก ตัวนี้ไม่ได้เข้าสอบ |

ช่วงความเชื่อมั่นปรับ Bonferroni สำหรับการมองหลัก 9 ครั้ง เพราะ 3 feature × 3 horizon = โอกาส 37% ที่จะเจอผลนัยสำคัญ 5% หนึ่งอัน แม้ทุก feature จะไร้ค่าทั้งหมด

**เลขที่ควรพกติดตัว — Expected Move ต้องรอนานแค่ไหน** ถ้าเริ่มเก็บวันนี้ (ต้องการ `n > 0.96/d²` observation **อิสระ** และมีราว 85 จาก 108 ตัวที่ chain สภาพคล่องพอ):

| | 5 แท่ง | 10 แท่ง | 20 แท่ง |
| --- | --- | --- | --- |
| ตรวจ edge 2pp | ~7 เดือน | ~14 เดือน | **~27 เดือน** |
| ตรวจ edge 1pp (เกณฑ์ที่ P5 ใช้จริง) | ~27 เดือน | ~55 เดือน | **~110 เดือน** |

เกณฑ์ P5 บังคับให้ edge ต้องยืนทุก horizon → **ช่องขวาล่างคือตัวผูกมัด** ราว 3 ปีสำหรับ 2pp และราวสิบปีสำหรับ 1pp และนั่นยังเป็นแค่เลขการสุ่มตัวอย่าง กฎ regime จาก P4a ทับอีกชั้น: หน้าต่างเก็บข้อมูลที่ครอบคลุมสภาวะตลาดเดียวสอบ "เครื่องหมายเดียวกันทั้งสองครึ่ง" ไม่ผ่านอยู่ดี
**การมองครั้งแรกที่ซื่อสัตย์อยู่ที่ราว 12 เดือน ที่ horizon 5 แท่งเท่านั้น และเป็นได้แค่ข้อบ่งชี้**

### 6.8 P6 — worth-it check

**คำถามที่ถามก่อนสร้าง:** ป้ายที่ยืนมานานกว่า พูดอะไรได้มากกว่าไหม
**คำตอบ: ไม่**

| อายุ label | edge @5 | @10 | @20 | ±adj @20 | clust @20 |
| --- | --- | --- | --- | --- | --- |
| 0-5 แท่ง | +0.2pp | −0.7pp | −1.1pp | ±3.6pp | 1786 |
| 10-15 แท่ง | −1.3pp | +2.3pp | **+5.2pp** | ±8.3pp | 322 |
| 20-30 แท่ง | +2.4pp | +5.6pp | −3.5pp | ±22.1pp | 47 |
| 35-60 แท่ง | 4 observation | | | | |
| 65+ แท่ง | **0 observation** | | | | |

`+5.2pp` คือเลขที่คนสร้างฟีเจอร์จากมันได้ง่ายมาก มันอยู่ในแถบ ±8.3pp และ split ข้างใต้อ่านว่า train +3.8 vs test +7.1 ส่วน bucket 20-30 อ่าน **train −15.3pp vs test +10.5pp** บน 24 และ 23 observation อิสระ — bucket ที่ไม่มีสัญญาณอยู่ข้างในและมีที่ว่างพอให้ผลิตพาดหัวแบบไหนก็ได้

**และข้อค้นพบที่ตัดสิน UI จริงๆ:** ป้ายทิศทางไม่แก่

```
directional observations                3629
zone เปลี่ยนที่ sample นี้พอดี          2169  (59.8%)
อายุถึง 20+ แท่ง                          80  ( 2.2%)
อายุถึง 35+ แท่ง                           4  ( 0.1%)
อายุถึง 65+ แท่ง                           0
```

สามในห้าของการอ่านที่มีทิศทาง อยู่ในวันแรกที่ถูกสุ่ม หนึ่งใน 45 อยู่ครบเดือน
ตัวที่จะมีเลขอายุใหญ่ๆ คือ **SIDEWAYS** ซึ่งเป็นป้ายที่ผู้ใช้มีแนวโน้มจะตีความเกินมากที่สุด และเป็นป้ายที่ harness มั่นใจที่สุดว่าไม่ได้แบกอะไรไว้

**SIDEWAYS แยกตามอายุ ที่ 20 แท่ง:**

| อายุ | ยังเป็น sideways | ราคายังอยู่ในกรอบ | n |
| --- | --- | --- | --- |
| 0-5 แท่ง | 74.5% | 49.9% | 3781 |
| 35-60 แท่ง | 74.0% | 55.6% | 1605 |
| 65+ แท่ง | 73.1% | **49.2%** | 457 |

จาก 49.9% ไป 49.2% — กรอบที่ยืนมา 65 วันไม่ได้อธิบายตลาดที่นิ่งกว่ากรอบที่เพิ่งเกิดเมื่อเช้า มันอธิบาย engine ที่ยังไม่เปลี่ยนใจ

**worth-it verdict: สร้าง แต่เป็น disclosure เท่านั้น** เหตุผลที่ยังคุ้ม: สิ่งที่ตารางเก็บ (การ์ดพูดอะไรวันไหน) คือสิ่งเดียวที่ **สร้างย้อนหลังไม่ได้** — replay engine วันนี้บนแท่งเมื่อวานให้ "ป้ายเมื่อวานที่ engine วันนี้" ซึ่งเป็นคนละคำพูด ต้นทุนคือหนึ่งตารางกับหนึ่ง strip

| อนุญาต | ห้าม (ผูกมัดโดยการวัด) |
| --- | --- |
| strip 30 วัน แสดงว่าพูดอะไรและเปลี่ยนเมื่อไร | จัดอันดับ/ให้คะแนน/เรียง/ไฮไลต์ตามอายุ label |
| `label นี้ยืนมา N วัน` เป็นข้อเท็จจริงเปล่าๆ | สี น้ำหนัก หรือขนาด ที่โตตามอายุ |
| `recent_flip` เป็นคำเตือนว่าการอ่านยังไม่นิ่ง | copy แนว "ยืนมานาน จึงน่าเชื่อถือ" / "ยืนยันแล้ว" |
| ช่องว่างวาดเป็นช่องว่าง | ใช้อายุเป็น input ของ `evidenceAgreement`, gate หรือ threshold ใดๆ |

โค้ดบังคับข้อนี้จริง: cell ระบายสีตาม state โดยไม่มี ramp ไม่มี fade ไม่มี opacity ที่โตตามอายุ และมี test assert ว่าทุก cell ของ label เดียวกันถูกสไตล์เหมือนกันไม่ว่าอยู่ตำแหน่งไหนของ run
หนึ่ง cell = หนึ่งวัน**ที่ถูกบันทึก** ไม่ใช่หนึ่งวันปฏิทิน — เพราะแถวจะมีก็ต่อเมื่อมีคนเปิดการ์ด ~~ตาราง 30 ช่องตายตัวจะเป็นวันหยุดกับวันที่ไม่มีคนดูเสียส่วนใหญ่ ความหนาแน่นถูกเปิดเผยเป็นตัวเลขแทน ("N จาก 30 วันล่าสุด")~~

**→ `65357e2` — มี track 30 ช่องตายตัวแล้ว และความหนาแน่นถูกเปิดเผย *สองทาง* ไม่ใช่ทางเดียว**

**ทำไมถึงเปลี่ยน.** cell ทุกช่องเป็น `flex-1` ใน flex row — N ช่องจึงแบ่งความกว้างเต็มกันเสมอ ไม่ว่า N จะเล็กแค่ไหน สองวันที่บันทึกได้วาดออกมาเป็นบล็อกครึ่งความกว้างสองอัน ซึ่งตาอ่านว่า "แถบเต็มความกว้าง มีรอยแบ่งตรงกลาง" — อยู่เหนือประโยคที่บอกว่าบันทึกได้ 2 จาก 30 วันพอดี ภาพกับประโยคอ้างตรงข้ามกัน และภาพชนะ นั่นไม่ใช่การเปิดเผยความหนาแน่น มันคือการกลบความหนาแน่นด้วยรูป

**ตอนนี้เป็นแบบไหน.** track กว้าง `windowDays` ช่องเสมอไม่ว่าข้างในมีกี่แถว · วันที่บันทึกได้ระบายสีตาม state เรียงตามลำดับที่บันทึก ชิดขอบขวา (ใหม่สุด) · ช่องที่เหลือถูกวาดเป็นช่องว่างจริง โทนเดียวแบน ๆ · และประโยค "บันทึกได้ N วัน จาก 30 วันที่ผ่านมา" **ยังอยู่ครบ** สองอย่างนี้พูดความหนาแน่นตัวเดียวกัน คนละภาษา ไม่มีอันไหนแทนอันไหน

**ข้อโต้แย้งในประโยคที่ขีดฆ่ายังยืนอยู่ทุกคำ — แต่มันคัดค้านการวาง *ตามปฏิทิน* ไม่ได้คัดค้าน track ตายตัว** ถ้า 30 ช่องคือ 30 วันปฏิทินจริง ช่องเสาร์-อาทิตย์ราว 8-9 ช่องจะว่างถาวรเพราะตลาดปิด ซึ่งทำให้ประโยคที่การ์ดต้องพูด — "ช่องว่างแปลว่าไม่มีแถว ไม่ใช่ตลาดปิด" — เป็นเท็จในตัวมันเองราวหนึ่งในสามของ track การเรียงตามลำดับที่บันทึกทำให้ประโยคนั้นจริงทุกช่อง และนั่นคือเหตุผลที่เลือกทางนี้ ไม่ใช่เพราะสวยกว่า

**`minStripDays: 7`** (product choice เขียนกำกับไว้ใน `src/config/signal.ts` ว่าไม่ได้มาจากการวัด) — ต่ำกว่านี้ไม่วาดรูปเลย เหลือบรรทัดนับบรรทัดเดียว พฤติกรรม "ตัวเลขอย่างเดียว" ของประโยคที่ขีดฆ่าจึงยังมีอยู่จริง **ในฐานะสาขาใต้เส้น ไม่ใช่ในฐานะรูปแบบเดียว** เหตุผลเดียวกับที่ประโยคเดิมให้ไว้: มาร์กไม่กี่อันใน track 30 ช่องเชิญให้อ่าน *รูปทรง* ออกมาจาก observation สองสามตัว

**ตาราง ห้าม/อนุญาต ข้างบนยังบังคับใช้ครบทุกข้อ ไม่มีข้อไหนถูกผ่อน** — `ช่องว่างวาดเป็นช่องว่าง` ตอนนี้เป็นการวาดจริง ๆ ไม่ใช่แค่ "ไม่ interpolate" · ไม่มี ramp ไม่มี fade ไม่มี opacity ที่โตตามอายุ และช่องว่างทุกช่องโทนเดียวกัน (การไม่มีแถวทุกครั้งคือการไม่มีแถวแบบเดียวกัน) · ไม่มีการจัดอันดับหรือไฮไลต์ตามอายุ · อายุยังอ่านจาก `currentRawLabelDays` เท่านั้น และ commit นี้เพิ่ม test ที่ fail ถ้า `currentLabelDays` โผล่ที่ไหนก็ตามบนบล็อก ปิดทางที่มันจะเข้ามาเป็น fallback ด้วย

### 6.9 train/test sign flip — เรื่องที่ต้องเล่าให้ครบ

**สิ่งที่สังเกตเห็น:** feature สี่ตัวที่ไม่มีอะไรร่วมกันในการสร้าง บวกกับ engine เอง **ติดลบบนครึ่ง train และเป็นบวกบนครึ่ง test ทุก horizon โดย flip ตกวันเดียวกัน**

```
                        train (2023-04 → 2025-06)   test (2025-06 → 2026-07)
engine direction (P4a)      -0.8 / -1.7 / -2.3pp        +1.2 / +1.9 / +2.2pp
relative strength           -1.1 / -1.6 / -2.4pp        +1.6 / +1.7 / +1.7pp
vpvr POC                    -2.1 / -1.9 / -0.9pp        +0.9 / +1.3 / +2.1pp
momentum ungated            +0.1 / -0.6 / -0.1pp        +0.6 / +0.9 / +1.4pp
```

สัญญาณที่ไม่เกี่ยวกันไม่เปลี่ยนเครื่องหมายพร้อมกันเองในวันเดียวกัน → **feature ไม่พัง ครึ่งสองครึ่งต่างกัน** trend-following ทุกชนิดถูกลงโทษในช่วงแรกและได้รางวัลเล็กน้อยในช่วงหลัง

**ทำไมมันสำคัญกว่าที่เห็นตอนแรก:** ตัวเลขพาดหัวของทุกตัว (รวมทั้ง engine) คือ **ค่าเฉลี่ยเต็มกลุ่มตัวอย่างของสองครึ่ง** ถ้าสองครึ่งคือสองสภาวะตลาดที่สัญญาณเดียวกันทำงานต่างกันจริง — ช่วยในสภาวะหนึ่ง ทำร้ายในอีกสภาวะ — **ค่าเฉลี่ยใกล้ศูนย์ก็ไม่ใช่การไม่มีสัญญาณ แต่คือสัญญาณสองตัวเครื่องหมายตรงข้ามหักล้างกัน**

สองคำพูดนี้ต่างกันมากในเชิงผลิตภัณฑ์:
- **"ไม่มีสัญญาณ"** — ทิศทางของ engine ไม่แบกข้อมูลอะไร และการ์ดพูดถูกที่บอกอย่างนั้น
- **"สองสภาวะหักล้างกัน"** — ทิศทางแบกข้อมูล **โดยมีเงื่อนไข** บนบางอย่างที่ยังไม่อยู่ในโมเดล และค่าเฉลี่ยไร้เงื่อนไขซ่อนมันไว้

P4a และ P5 วัดอย่างแรก และ **แยกมันออกจากอย่างที่สองไม่ได้** การ split ด้วย SPY 200-day ก็ไม่ใช่การแยกนั้น — มันแบ่งด้วยนิยามที่เลือกไว้ล่วงหน้า และ flip ไม่ตรงกับมัน (แถว regime `down` เล็ก มั่ว และเครื่องหมายไม่คงเส้นคงวาข้าม horizon)

**ทำไมยังไม่ทดสอบ และทำไมการทดสอบมันอันตราย** — สมมติฐานนี้มีรูปร่างที่ผลิต false discovery ได้แน่นอนที่สุด:
- **จุด split รู้อยู่แล้ว** จากการที่ไปดูข้อมูลมา — test ใดๆ ที่ใช้เส้น 2025-06-30 คือการทดสอบเส้นที่ถูกเลือกเพราะมันเวิร์ก
- "หาตัวแปรเงื่อนไขที่ทำให้ edge โผล่" คือการค้นในพื้นที่ตัวแปรที่ไม่มีขอบเขต และ **มีบางอย่างฟิตเสมอ**
- สองครึ่ง = degree of freedom เดียว และราว 1,800 observation อิสระต่อครึ่งที่ 20 แท่ง ไม่พอจะยืนยัน conditional effect ที่ unconditional test มองไม่เห็น
- conditional model ที่เวิร์ก บน corpus ชุดนี้ **แยกไม่ออกจากโมเดลที่จำวันที่ได้**

**เงื่อนไข 5 ข้อก่อนจะเอาจริง (เข้มกว่า P5 ไม่ใช่หลวมกว่า):** ตัวแปรเงื่อนไขต้อง **ตั้งชื่อและนิยามล่วงหน้า** จากเหตุผลเชิงเศรษฐศาสตร์ ไม่ใช่จากการส่องข้อมูล · คำนวณได้ **ที่แท่ง as-of** โดยไม่มี look-ahead · ทดสอบบน **ช่วงที่สาม** ที่ corpus ยังไม่มี · ผลต้องรอดเมื่อ **ขยับจุด split** (ถ้ามีอยู่เฉพาะที่ 2025-06-30 มันคือวันที่นั้น ไม่ใช่ regime) · มีการแก้ค่าสำหรับจำนวนตัวแปรที่ลองไปแล้ว

**จนกว่าจะครบทั้งห้า จุดยืนของผลิตภัณฑ์ไม่เปลี่ยน และมันคือสิ่งที่การ์ดพูดอยู่: ไม่พบ edge** ประโยคนั้นยังจริง และไม่ได้ถูกทำให้อ่อนลงด้วยบันทึกนี้ — "เราไม่ได้เจอ" คือสิ่งที่มันพูดพอดี และนี่คือบันทึกเกี่ยวกับที่ที่ยังไม่มีใครไปมอง

🔴 **`p5-context-findings.md` ส่วนนี้ทำเครื่องหมาย INTERNAL ONLY** ห้ามให้ถึงการ์ด changelog หน้าราคา หรือพื้นผิวใดๆ ที่ผู้อ่านเห็น

**สิ่งที่จะตัดสินมันได้จริง:** corpus เพิ่ม ไม่ใช่ความฉลาดเพิ่ม ขยาย corpus ย้อนกลับไป 2020-2022 จะให้ drawdown จริงและ recovery จริง และทำให้ตั้งคำถามได้โดยนิยาม split **ก่อน** เห็นข้อมูล นั่นเป็นงานเก็บข้อมูล ไม่ใช่งานสร้างโมเดล

### 6.10 P4b — การวัดซ้ำที่พิสูจน์ว่า harness deterministic

```
$ diff <report 20260818T092020Z> <report 20260818T113633Z>
6c6
< corpus             108 instruments
---
> corpus             108 instruments — pinned to the list run 20260818T092020Z measured
```

หนึ่งบรรทัด และมันคือบรรทัดที่บอกว่ามีการ pin ทุกตาราง ทุก bucket ทุก rate ทุก clustered count และ window self-check เหมือนกัน byte ต่อ byte manifest ต่างกันแค่ `runId`

การ pin ด้วย `--like` คือเหตุผลที่การเทียบนี้มีความหมาย: `__golden__/corpus/` เป็น cache และมันโตขึ้นหนึ่งตัวระหว่าง P5 ตอน probe อีกตัวไปดึงรายชื่อของตัวเอง run ที่ไม่ pin จะวัด 109 ตัวและได้ตัวเลขต่างกันนิดหน่อยทุกที่ ซึ่งจะถูกอ่านว่า engine ขยับ

**`completeness` ยัง inert อยู่:** โน้ต P1.5 ใน `signal.ts` บอกว่ามันจะตื่นใน P5 ตอน optional source เริ่มขาดจริง P5 ไม่ได้เพิ่ม optional source เลย มันจึงไม่ตื่น — median 1.000 ทั้งสองครั้ง **คอมเมนต์ในไฟล์ที่สัญญาว่า P5 จะปลุกมัน ตอนนี้ผิดแล้วและยังไม่มีใครแก้**

---

## 7. งานค้าง

### 7.1 ที่ Claude Code ทำได้ แต่ยังไม่ได้ทำ

| งาน | ทำไมยังค้าง |
| --- | --- |
| **commit งานใน working tree ทั้งสองกลุ่ม** | กลุ่ม copy ผ่านเทสต์แล้ว กลุ่ม expected-move ยังไม่มีเทสต์ — commit รวมกันจะเป็น commit ที่ครึ่งหนึ่งไม่มีอะไรค้ำ |
| **`docs/market-signal/expected-move-collection.md`** | **ถูกอ้างถึงจาก 3 ที่** (`derive.ts`, `collect-expected-move.ts`, migration `202608180002`) แต่ไฟล์ยังไม่มี — เลขการรอ (12 เดือน / 3 ปี / 10 ปี) อยู่ใน `p5-context-findings.md` แล้ว ยังไม่ได้ย้ายมาเป็นไฟล์ของตัวเอง |
| ~~**`docs/market-signal/open-work.md`**~~ | **มีแล้ว** — 7 หัวข้อ ล่าสุดคือการชนของชื่อ `คะแนนทิศทาง` ระหว่างสอง engine และ test double สองตัวที่อ่านนาฬิกาจริง |
| **test ของ expected-move** | `derive.ts` (139 บรรทัด) `repository.ts` (69) `collect-expected-move.ts` (134) และ migration 137 บรรทัด — **ศูนย์เทสต์** เทียบกับ `market_signal_history` ที่มี migration test รันกับ Postgres จริง นี่คือช่องว่างที่ชัดที่สุดในรีโปตอนนี้ |
| **แก้คอมเมนต์ `completeness` ใน `signal.ts`** | P5 findings บอกไว้เองว่าคอมเมนต์นี้ผิดแล้ว และเว้นไว้ให้คนที่เปิดไฟล์ต่อไป เพราะการแก้แปลว่าต้อง commit ไฟล์ engine เพื่อคอมเมนต์ |
| **`docs/market-signal/README.md` ยังไม่ list ไฟล์ใหม่** | README เขียนก่อน expected-move จะเกิด |
| **`npm run test` เต็มชุด + `npm run lint`** | รันเฉพาะ path ของ signal ในเซสชันนี้ |
| ~~**regenerate `__golden__/preview/`**~~ | **ตรวจแล้ว ไม่ต้อง regenerate** — `SIGNAL_GATE=true SIGNAL_ZONES=true npm run snapshot:signal -- --check` ให้ `PREVIEW gate-zones PASSED · 10 symbol(s) byte-identical` และรอบ flags-OFF ให้ `GATE PASSED` ทั้งก่อนและหลัง ผลเต็มอยู่ใน `rollout-checklist.md` §4 |

### 7.2 ที่ต้องให้เจ้าของทำ (Claude ทำไม่ได้)

| งาน | ทำไมต้องเป็นเจ้าของ |
| --- | --- |
| ~~**รัน migration `202608180001_market_signal_history.sql`**~~ | **ทำแล้ว** — ยืนยัน 2026-08-31 ว่าตารางอยู่บน production ยังต้องรัน **ก่อน** เปิด `SIGNAL_HISTORY` ตามเดิม (flag ที่ไม่มีตารางจะไม่บันทึกและไม่แสดงอะไร ไม่พัง แต่ก็ไม่ทำงาน) |
| **ตัดสินใจ + รัน migration `202608180002` (expected move)** | เป็นการตัดสินใจว่าจะเริ่มเก็บข้อมูลที่จะตอบอะไรไม่ได้ไปอีกปี ต้นทุนไม่กี่ KB ต่อวัน ถ้าไม่เริ่ม คำถามนี้จะตอบไม่ได้ถาวร ซึ่งก็เป็นทางเลือกที่ชอบธรรม (เป็นสถานะปัจจุบันและไม่มีต้นทุน) |
| **ตั้ง schedule ให้ `npm run collect:expected-move`** | วันละครั้งหลังตลาดสหรัฐปิด ต้องมี infra + service key |
| **เปิด flag ตามลำดับใน `rollout-order.md`** | env variable บน production ลำดับ: GATE → ZONES → ACTIONABLE → สื่อสาร → HISTORY (พร้อม migration) → CONTEXT (ไม่มีอะไรให้เปิด) |
| **อนุมัติ wording ทั้ง 3 ดราฟต์** | `changelog.md` / `in-app-notice.md` (Version A แนะนำ) / `pricing-copy.md` (จุดยืน 1-2-3 — เอกสารแนะนำจุดยืน 2) — เป็นคำสัญญาที่ให้กับคนที่จ่ายเงิน ไม่ใช่การตัดสินใจของ developer |
| **ตรวจ release notes ใน DB** | เก็บใน database ไม่ใช่ในรีโป (`ReleaseNoteEditor.tsx` เขียนลงไป) มองจากที่นี่ไม่เห็น ถ้ามีโน้ตเก่าที่บรรยาย Technical Outlook แบบพยากรณ์ ต้องเข้า admin console ไปดูก่อนเปิด flag |
| **mobile clip probe** | ยังไม่เคยดู ZoneBar / HistoryStrip / ActionableRows บนจอมือถือจริงตอนเปิด flag — ต้องรันแอปจริง + บัญชีที่มี capability `technical.outlook` **ไม่มีสคริปต์ QA ตัวไหนครอบคลุมการ์ดนี้** (`scripts/qa/` มี 2 ไฟล์ที่เอ่ยถึง signal แต่ **ไม่ได้ตรวจ** ว่าครอบคลุมแค่ไหน) ที่ต้องดูเฉพาะ: marker ที่ `positionPct` 113.7 ถูก clamp ไว้ที่ 100 สำหรับการวาด แต่ตัวเลขที่พิมพ์ยังเป็น 113.7 |
| **ตัดสินใจเรื่อง Options Signal Engine** | มันขาย `คะแนนความมั่นใจ` อยู่ 3 ที่ และ **ยังไม่เคยถูกวัดเลย** จะวัดหรือจะปล่อย ทั้งสองทางยังเป็นของเจ้าของ · **สถานะ 2026-08-23:** เจ้าของสั่งให้แก้เฉพาะ*ความขัดแย้งภายใน*แล้ว (ดู §7.4) การ**วัด**ยังไม่ได้เกิดขึ้น และยังเป็นการตัดสินใจที่ค้างอยู่ |
| **`sweep_market_signal_history(400)` ในโหมดรายงาน** | หลังเปิด HISTORY ไปสักเดือน — เห็นมันทำงานนานก่อนที่จะมีอะไรให้ลบ การตั้ง schedule เป็น migration แยกและการตัดสินใจแยก และมีเวลาเกินหนึ่งปีก่อนจะสำคัญ |

### 7.3 ตัดสินใจแล้วว่าจะไม่ทำ

| ไม่ทำ | เหตุผล |
| --- | --- |
| **สร้างอะไรก็ตามหลัง `SIGNAL_CONTEXT`** | ทั้ง 4 candidate ตกการวัด flag คงอยู่แต่ว่างเปล่า ถ้า corpus ในอนาคตทำให้ volatility compression น่ากลับไปวัด **นั่นคือการวัดใหม่ ไม่ใช่การเปิด flag** |
| **calibrate `evidenceAgreement` เป็นความน่าจะเป็น** | ตารางแบนและไม่ monotone remap จะคืนความเข้าใจผิดที่ P4.5 เอาออกไป กลับมาในเสื้อผ้าที่ผ่านการ calibrate |
| **ขยับ `MARKET_SIGNAL_GATE.confidence.*` floors** | ไม่มี outcome signal ให้ fit การขยับคือการขยับตัวเลขจนค่าภายในดูดี |
| **ลบ field `confidence` / `confidenceLabel`** | การลบ field ไม่ใช่ additive — deprecated แต่ค่าเท่ากับ `evidenceAgreement` เป๊ะ |
| **ทดสอบสมมติฐาน sign flip บน corpus ชุดนี้** | จุด split รู้อยู่แล้วจากการมองข้อมูล ทดสอบแล้วจะได้ผลที่แยกไม่ออกจากการจำวันที่ ต้องรอ corpus ที่ยาวกว่านี้ |
| **ให้ label ที่ยืนนานกว่าดูน่าเชื่อถือกว่า** | P6 วัดแล้วว่าอายุไม่แบกอะไร ห้ามจัดอันดับ ห้าม ramp สี ห้ามใช้อายุเป็น input ของ threshold ใดๆ |
| **วัด `recentFlipDays = 3` ให้ถูกต้อง** | ต้องใช้ stride-1 replay = 5 เท่าของจำนวน engine run เพื่อตัวเลขที่เปลี่ยนแค่ chip เตือน สมเหตุสมผลที่จะไม่ทำ **ตราบใดที่ไม่มีใครเอาเลข 5 แท่งไปอ้างว่าตอบคำถาม 3 วันแล้ว** |
| **ตั้ง schedule retention sweep ตอนนี้** | สิ่งแรกที่ฟีเจอร์ใหม่ทำโดยไม่มีคนดูไม่ควรเป็นการลบ และที่ retention 400 วัน มันไม่มีความหมายอะไรไปอีกกว่าหนึ่งปี |
| **จูน copy ของ Options Signal Engine** | engine คนละตัว ไม่เคยวัด แก้คำตอนนี้ = สื่อข้อค้นพบที่ไม่มีอยู่ · **ยังห้ามอยู่** แต่ดู §7.4 สำหรับเส้นแบ่งระหว่าง "จูน copy" กับ "แก้ความขัดแย้งที่ตรวจสอบได้" ซึ่งรอบ `6dab07d..c393d7e` ทำไปแล้วภายใต้ข้อยกเว้นนั้น |
| **เปลี่ยนราคา** | ไม่มีอะไรในเอกสารชุดนี้บอกว่าฟีเจอร์นี้มีค่าน้อยกว่าที่คิดเงิน สิ่งที่หายไปคือข้ออ้างที่ไม่เคยมีใครตรวจ |

### 7.4 เส้นแบ่ง: "จูน copy" (ยังห้าม) กับ "แก้ความขัดแย้งที่ตรวจสอบได้" (ทำไปแล้ว)

รอบ `6dab07d..c393d7e` (2026-08-23) แก้ข้อความบนการ์ด Options Signal ไป 13 commit
ทั้งที่ตารางข้างบนเขียนว่าห้ามแก้ copy ของเอนจินตัวนี้ เอกสารที่ห้ามอย่างหนึ่ง
ทั้งที่เพิ่ง merge สิ่งนั้นเข้าไป จะทำให้คนถัดไปสับสนหนักกว่าตอนที่ยังไม่มีเอกสาร
หัวข้อนี้จึงมีไว้ให้คนถัดไปตัดสินเองได้ว่างานที่ตัวเองจะทำอยู่ฝั่งไหน

#### ข้อห้ามเดิมมีเหตุผลอะไร — **ยังใช้ได้ ห้ามลบทิ้ง**

Options Signal Engine ขายคำว่า "คะแนนความมั่นใจ" อยู่สามที่ และ **ไม่เคยมีใคร
วัดว่ามันทำนายอะไรได้จริงไหม** ไม่มี corpus ไม่มี outcome signal ไม่มี
calibration ใดๆ อย่างที่ Market Signal มี

ในสถานะแบบนั้น การไปขัดถ้อยคำให้ฟังดูมั่นใจขึ้น อ่อนลง หรือแม่นยำขึ้น
คือการ**ส่งสารว่ามีข้อค้นพบใหม่** ทั้งที่ไม่มีอะไรเกิดขึ้นเลยนอกจากคนเขียนคำ
เปลี่ยนใจ ผู้อ่านแยกไม่ออกระหว่าง "คำนี้เปลี่ยนเพราะเราวัดแล้วพบว่า…"
กับ "คำนี้เปลี่ยนเพราะมีคนคิดว่ามันอ่านลื่นกว่า" — และเชื่อแบบแรกเสมอ
นั่นคือการยืมความน่าเชื่อถือที่ยังไม่มี ข้อห้ามนี้จึงไม่ได้หมดอายุ

#### รอบนี้ยกเว้นด้วยเหตุผลอะไร

สิ่งที่แก้ไปไม่ใช่การเปลี่ยน**ข้อสรุป** แต่เป็นการแก้จุดที่**หน้าเดียวกันพูดสองอย่าง
ที่เป็นจริงพร้อมกันไม่ได้** และพิสูจน์ได้ด้วยเลขคณิต ไม่ต้องมี corpus ไม่ต้องมี
outcome signal ตัวอย่างจริงจากรอบนี้:

| ข้อความ A | ข้อความ B (หน้าเดียวกัน) | พิสูจน์ยังไง |
| --- | --- | --- |
| "confidence คือการคูณกันของสามค่า" | 1.00 × 0.11 × 0.20 = 2% ขณะที่การ์ดแสดง 20% | คูณตามที่หน้าเว็บบอก |
| "ความครบของข้อมูล 100%" | "IV Rank: ไม่พร้อมใช้งาน" + เปอร์เซ็นไทล์ที่ยังนับถอยหลัง | 100% กับ "ขาดอยู่" เป็นจริงพร้อมกันไม่ได้ |
| "สภาพคล่องดี · 100 / 100" | "คะแนนรวม: —" | ปฏิเสธที่จะตัดสินและให้คะแนนเต็มพร้อมกัน |
| "ยังไม่แพง" | "งบประกาศในอีก 5 วัน อยู่ในอายุสัญญา 41 วัน" | ชี้ให้ไปซื้อสิ่งที่หน้าเดียวกันกำลังเตือน |
| "ลงถึงแนวรับ −6.23%" | "ลงถึงแนวรับ 6.23%" | เครื่องหมายคนละแบบ ระยะเดียวกัน |
| `score-below-prime` ข้าง 58 / 100 | เกณฑ์ PRIME = 55 | 58 ≥ 55 แต่การ์ดบอกว่าไม่ผ่าน |

ทุกแถวข้างบนตอบได้ด้วยเครื่องคิดเลขและตัวหน้าเว็บเอง ไม่มีแถวไหนที่ต้องรู้ว่า
เอนจิน**ทำนายถูกไหม** — ซึ่งเป็นคำถามที่ยังไม่มีใครตอบและยังห้ามแตะ

#### เส้นแบ่งที่ใช้ตัดสินได้เอง

> **ถ้าแก้แล้วเขียน test ที่ fail ได้ → เป็นการแก้ความขัดแย้ง ทำได้**
> **ถ้าแก้แล้วไม่มีอะไร fail ได้เลย → เป็นการจูน copy ซึ่งยังห้ามอยู่**

เกณฑ์นี้ใช้ได้เพราะความขัดแย้งที่ตรวจสอบได้จะมี "อีกฝั่ง" ให้เทียบเสมอ —
ตัวเลขบนหน้าเดียวกัน, ค่าใน config, ผลของสูตรที่หน้านั้นพิมพ์ไว้เอง
ส่วนการจูนถ้อยคำไม่มีอีกฝั่ง มีแต่รสนิยม

ตรวจตัวเองสองข้อ ก่อนแก้:

1. **assert อะไรได้บ้าง** ถ้าเขียนได้แค่ `expect(text).toBe('ข้อความใหม่')`
   นั่นคือการจดคำที่เพิ่งพิมพ์ลงไป ไม่ใช่ test — มันผ่านเพราะคุณเพิ่งแก้
   ทั้งสองที่ให้ตรงกัน ไม่ใช่เพราะข้อความนั้นถูก
2. **test นี้จะ fail ตอนไหน** ถ้าตอบว่า "ตอนมีคนแก้ข้อความกลับ" อย่างเดียว
   → จูน copy · ถ้าตอบว่า "ตอนที่เลขกับคำไม่ตรงกันอีก" → แก้ความขัดแย้ง

`golden.test.ts` คือรูปแบบที่ต้องการ: มันคำนวณทุกค่าซ้ำจาก input แล้วบังคับให้
เอนจินเห็นด้วย ไม่ใช่ `toBe(41)` กับเลขที่ใครสักคนอ่านจากจอ ถ้าเขียน test แบบนั้น
ให้งานของตัวเองไม่ได้ งานนั้นน่าจะอยู่ฝั่งที่ยังห้าม

#### สิ่งที่รอบนี้ **ไม่ได้** ทำ และยังห้ามเหมือนเดิม

- ขยับ constant ใดๆ เพื่อให้ผลลัพธ์ตกในช่วงที่ใครคาดไว้ — น้ำหนักทั้งห้า
  (15/25/25/10/15) ยังเท่าเดิมทุกตัว
- เปลี่ยนคำที่บรรยาย**คุณภาพ**ของสัญญาณ ("แข็งแรง" / "น่าเชื่อถือ" / "ชัดเจน")
  โดยไม่มีอะไรวัด
- แยก event vol ออกจาก base vol — เป็นงานโมเดล ไม่ใช่งานข้อความ และยังไม่ได้วัด
- อ้างว่า confidence คือความน่าจะเป็นที่จะได้กำไร — disclaimer ท้ายการ์ดยังอยู่ครบ

---

---

## 8. สิ่งที่รู้ว่ายังไม่รู้

### 8.1 ข้อจำกัดของผลการวัดทุกตัวในเอกสารนี้

| ข้อจำกัด | รายละเอียด |
| --- | --- |
| **Survivorship** | 108 instrument ที่วัดยังซื้อขายอยู่ทั้งหมด corpus ไม่มีชื่อที่ถูกถอด ทุกตัวเลขจึงมีเงื่อนไขว่ารอดมาแล้ว และมองโลกในแง่ดีเกินจริง **ในปริมาณที่ไม่รู้** |
| **ไม่มีค่าธรรมเนียม / spread / slippage** | นี่คือการเคลื่อนของราคา ไม่ใช่ผลตอบแทน |
| **ช่วงเวลาเดียว** | 2023-04-09 ถึง 2026-07-27 ส่วนใหญ่เป็นตลาดขาขึ้น regime `down` มี clust แค่ 171-225 ที่ 20 แท่ง — อ่านอะไรไม่ได้ |
| **train/test split ไม่ใช่ overfit control** | ยังไม่มีอะไรถูก fit จึงไม่มี fit ให้มันปกป้อง มันมีไว้ให้ P4b ได้ held-out period ที่นิยามก่อนตัวเลขไหนขยับ |
| **`clust` คือขีดจำกัดจริง** | ที่ 20 แท่ง มี observation อิสระแค่ ~1,853 ตัว บางการตัดเหลือ 24 |
| **"ยังไม่พบ" ≠ "ไม่มี"** | วัดแล้วไม่เจอ บน corpus ชุดนี้ ช่วงเวลานี้ ไม่ได้แปลว่าไม่มีทางเจอ |
| **markdown ไม่มี test** | ตัวเลขใน `changelog.md` มาจาก `MARKET_SIGNAL_MEASURED` แต่ถูกพิมพ์ลงไป — รัน `signal:calibrate` ใหม่แล้วไฟล์นั้นเก่าเงียบๆ (ต่างจาก copy บนการ์ดซึ่ง interpolate จาก config และมี test ค้ำ) |

### 8.2 อะไรที่ยังไม่เคยทดสอบเลย

| ยังไม่เคยทดสอบ | หมายเหตุ |
| --- | --- |
| **Options Signal Engine** | 🔴 **ตัวใหญ่ที่สุด** — engine คนละตัว ขาย `คะแนนความมั่นใจ` อยู่ที่ `upgrade-copy.ts:85`, `plan-catalog.ts:121` และ `OptionsSignalSection.tsx:101` **ไม่เคยมี harness ตัวไหนรันผ่านมันเลย** นี่คือคำถามเดียวกับที่ P4a ถาม Market Signal ถามกับผลิตภัณฑ์ที่ไม่มีใครวัด |
| **Expected Move / options chain** | วัดไม่ได้ — ไม่มี historical chain collector เพิ่งถูกเขียนและยังไม่ commit ไม่มีข้อมูลแม้แต่วันเดียว |
| **`recentFlipDays = 3`** | ละเอียดกว่าอะไรก็ตามที่ P6 probe วัดได้ (stride 5) |
| **`anchor.lookbackBars` ค่าอื่น** | สคริปต์ sweep มี แต่ผลไม่ได้เก็บเป็นไฟล์ **ไม่ได้ตรวจ** |
| **threshold ส่วนใหญ่ใน §3** | ดูคอลัมน์ "ที่มา" — ส่วนใหญ่คือ `ตั้งเอง` หรือ `สืบทอด` |
| **ช่วงตลาด 2020-2022** | drawdown จริงและ recovery จริงไม่อยู่ใน corpus — และนี่คือสิ่งเดียวที่จะตัดสิน sign flip ได้ |
| **พฤติกรรมจริงตอนเปิด flag บน production** | มีแค่ `__golden__/preview/` ซึ่งเป็น 10 instrument บนแท่งแช่แข็ง ไม่มีใครเคยเห็นการ์ดนี้ตอนเปิด flag ด้วยตาบนอุปกรณ์จริง |
| **history strip กับข้อมูลสะสมจริง** | ตารางยังไม่ถูกสร้าง strip จึงไม่เคยมีข้อมูลจริงให้วาด logic ผ่านเทสต์ที่เขียนวันด้วยมือ |
| **สัดส่วน SIDEWAYS หลังเปิด GATE บน corpus ทั้งหมด** | รู้ว่ามันจะเพิ่ม (นั่นคือจุดประสงค์) แต่ **ไม่ได้ตรวจ** ว่าเพิ่มเป็นเท่าไรบน 108 ตัว — `rollout-order.md` ระบุให้เฝ้าดูตัวนี้เป็นอันดับแรกหลังเปิด |
| **อัตรา `stale_zone` / `narrow_range` ในสภาพจริง** | ควรจะพบไม่บ่อยทั้งคู่ ถ้าตัวใดตัวหนึ่งพบบ่อยขึ้น แปลว่ากฎ frame เจอตลาดที่มันไม่เคยถูกวัดกับมัน |
| **อัตราการเงียบของ ACTIONABLE ในสภาพจริง** | ออกแบบไว้ว่า 4 ใน 5 instrument จะเงียบ ถ้าเลขนี้ขยับไกลจากนั้น แปลว่า anchoring เปลี่ยน |

---

## 9. ประวัติที่ผู้อ่านควรรู้

รายการนี้มีไว้ให้ผู้อ่าน **ไม่เสนอทางที่ลองแล้วไม่ได้ผลซ้ำ** ข้อละบรรทัด

| # | สเปคเดิมว่าไง | ความจริงคืออะไร |
| --- | --- | --- |
| 1 | **MACD** — บรีฟรายงานว่า histogram คำนวณผิด (`-0.1121 / -0.1386 / +1.2741`) | **ไม่ได้ผิด** — signal line ถูกถอดมาผิดเป็น `-0.1386` ทั้งที่ engine ให้ `-1.3862` (หารสิบพอดี) histogram `+1.2741` ตามมาจากค่าที่ถูก และมันใหญ่เพราะเส้น MACD ไต่จาก −3.75 ไป −0.11 ใน 12 session · `reference.test.ts` คำนวณทุก metric ด้วยมือจาก OHLCV ดิบโดยไม่แตะ indicator library และมี test เรนเดอร์ component จริงแล้วอ่าน DOM |
| 2 | **nearest levels เป็นกรอบของ zone** | `nearestSupport`/`nearestResistance` นิยามว่าเป็นแนวที่ใกล้ราคา**ปัจจุบัน**ที่สุด → trigger ที่สร้างจากมัน **ถอยหนีทุกครั้งที่ราคาเดิน และข้ามไม่ได้ตลอดกาล** · เปลี่ยนไป anchor กับ swing high/low ที่ยืนอยู่ในอดีต · falsification: closes ที่เลย trigger ตอนนั้น = 0/108 instrument ที่มีค่าศูนย์ (median 33, min 9, max 70) · โหมด `open_above`/`open_below` ที่เคยผลิต label มีทิศทางได้ ที่จริงคือการตรวจจับความใกล้ all-time high — เหตุผลที่ SPY, DIA, IWM ตกอยู่ในโหมดนั้นพร้อมกัน |
| 3 | **Price Structure อ่าน pivot ย้อนหลังไม่จำกัด** | ค้น pivot 5 ปีหา "แนวรับใกล้สุดใต้ราคาปิดก่อนหน้า" แล้วรายงานว่าราคาเพิ่งทะลุมัน — ผลิต breakdown ของ low อายุ 9 เดือนบน IREN, breakout ของแนวปี 2023 บน REMX/CL-F, และแนวที่แตะครั้งสุดท้ายเดือนตุลาคม 2021 บน BTC-USD · แก้ด้วย `pivotLookbackBars = 120` + ให้ราคาปิดล่าสุดร่วมเป็น provisional extreme |
| 4 | **invalidation = ฝั่งตรงข้ามของกรอบ** | ไม่ใช่ — คือ **ขอบที่โซนยืนอยู่** (`zone_floor` สำหรับ uptrend, `zone_ceiling` สำหรับ downtrend) เพราะนั่นคือขอบที่ hysteresis ของ engine เองอ่านเพื่อตัดสินว่าโซนจบแล้ว · และเนื่องจากกรอบ re-anchor ที่แท่ง breakout ขอบอาจไปอยู่ผิดฝั่งของราคาปิด → กรณีนั้นไม่พิมพ์เลข แต่พิมพ์ code `invalidation_behind_close` |
| 5 | **`anchor.lookbackBars = 120` ตัดสินสัดส่วน sideways** | ตั้งมาโดยไม่มีหลักฐาน จึง sweep ก่อน P4 (`npm run signal:lookback`) — **ผลตัวเลขไม่ได้ถูกเก็บเป็นไฟล์ จึงยืนยันข้อสรุปไม่ได้: ไม่ได้ตรวจ** · สิ่งที่รู้แน่: ตัวที่กลายเป็นปัญหาจริงคือคนละตัว — กรอบกว้างเลี้ยงตัวเองได้ภายใต้กฎ re-anchor สองข้อเดิม (CL-F นั่งบนกรอบกว้าง 56 ที่ราคาไม่เข้าใกล้มา 110 แท่ง ห่าง trigger ตัวเอง 9.4 ATR ถาวร) จึงเพิ่มกฎที่สาม `untestedReanchorBars = 60` |
| 6 | **methodology ของ regime test** | "regime ไม่ใช่ทิศทาง" — ทดสอบตามที่สเปคเขียนไม่ได้ · เปลี่ยนไปทดสอบข้ออ้างที่คนพูดจริง ("regime บีบตัวนำหน้าการขยายตัวที่ไปต่อตามทิศเดิม") **และต้องมี control แบบ ungated เสมอ** — ไม่งั้น +1.4pp ของ gated version อ่านไม่ออกว่ามาจาก compression หรือจาก momentum |
| 7 | **สัดส่วน uptrend:downtrend = 20:2 คือบั๊กของ swing-low detector** | **ไม่ใช่บั๊ก** — detector ยืนยัน swing high 12,852 ตัวเทียบ swing low 13,125 ตัว (ratio 0.979 ถ้าจะเอียงก็เอียงไปหา low) · เป็น artefact ของการอ่าน **ชั่วขณะเดียว**: zone dwell time สั้นเพราะกรอบ re-anchor snapshot จึงจับทิศที่เพิ่งเข้าล่าสุดเป็นส่วนใหญ่ และ 29 จาก 45 instrument ราคาขึ้น · นับ **การเข้า zone** แทน: ตัวที่ราคาตกเข้า downtrend 95 ครั้งเทียบ uptrend 57 · COIN ที่ −53% เข้า downtrend 7 ครั้ง uptrend 2 ครั้ง — กลไกกลับทิศตามตลาดจริง |
| 8 | **methodology ของ "worst SPY window" test เดิม** | มันแมป index range ของ instrument หนึ่งลงบน instrument อื่นที่ยาวไม่เท่ากัน จึงไม่เคยวาง instrument เหล่านั้นในหน้าต่างปฏิทินเดียวกันเลย — รันซ้ำก็ตอบอะไรไม่ได้ |
| 9 | **`conflictMinimumMagnitude` แค่ดูเครื่องหมายก็พอ** | ไม่พอ — silver มี 4 ใน 5 หมวดเป็นบวก score 36 แต่ EMA component อยู่ที่ −0.11 ของ range ตัวเอง แล้วถูกบังคับเป็น NEUTRAL · conflict ควรแปลว่าหลักฐานสองส่วนเถียงกันจริง ไม่ใช่ส่วนหนึ่งปัดผิดฝั่งของศูนย์ |
| 10 | **`completeness` จะตื่นใน P5** | ไม่ตื่น P5 ไม่ได้เพิ่ม optional source เลย — **คอมเมนต์ใน `signal.ts` ที่สัญญาข้อนี้ตอนนี้ผิดและยังไม่ถูกแก้** |

---

## คำถามที่อยากให้ช่วยคิด

เขียนจากมุมของคนที่ทำงานนี้มาตั้งแต่ P0 — นี่คือจุดที่ยังไม่มั่นใจจริงๆ ไม่ใช่คำถามมารยาท

**1. sign flip: บันทึกไว้เฉยๆ ถูกแล้วหรือขี้ขลาด?**
ผมเขียนเงื่อนไข 5 ข้อที่เข้มจนแทบเป็นไปไม่ได้บน corpus ปัจจุบัน แล้วปิดเรื่อง เหตุผลคือการ "หาตัวแปรที่ทำให้ edge โผล่" สำเร็จเสมอ และผมกลัวว่าตัวเองจะไปฟิตวันที่ แต่ผลข้างเคียงคือ: **ถ้าเป็นสองสภาวะหักล้างกันจริง เรากำลังบอกลูกค้าว่า "ไม่มีสัญญาณ" ทั้งที่ความจริงคือ "มีสัญญาณแบบมีเงื่อนไขที่เรายังไม่รู้เงื่อนไข"** สองอันนี้ต่างกันมาก มีวิธีไหนที่แยกสองอันนี้ออกได้โดยไม่ต้องรอ corpus ใหม่ และโดยไม่ตกกับดัก data snooping? หรือคำตอบคือ "ไม่มี รอไปเถอะ" จริงๆ

**2. ZONES เปิดแล้ว conflict ไม่ veto ทิศทางอีกต่อไป — นี่คือการถอยหรือการก้าวหน้า?**
เหตุผลที่เขียนไว้ฟังดูดี (fact vs quality) และผลกระทบเล็ก (2.8% ของ corpus) แต่ผลลัพธ์สุทธิคือ **การ์ดสามารถแสดง BULLISH พร้อมชิป `conflicting_evidence` และ agreement 27% พร้อมกัน** ซึ่ง IREN เป็นตัวอย่างจริง คนที่อ่านเร็วจะเห็นแค่ BULLISH คำถามคือ: มันมีทางกลางที่ดีกว่าทั้งการลบทิศทางทิ้ง (เดิม) และการแสดงทั้งคู่ (ปัจจุบัน) ไหม เช่นชื่อ state ที่สาม? หรือการแสดงทั้งคู่คือคำตอบที่ถูก และปัญหาอยู่ที่ลำดับสายตาใน UI ล้วนๆ

**3. threshold ที่ไม่มีหลักฐาน — ปล่อยไว้ หรือทำอะไรสักอย่าง?**
ตาราง §3 มีค่าราว 40 ตัว มีสามตัวที่วัดมา ผมรู้สึกไม่สบายใจกับสิ่งนี้แต่ก็รู้ว่า sweep ทุกตัวคือเดือนของงานที่จะให้ผลแบบ "เส้นแบน" เหมือน `conflictMinimumMagnitude` เกือบแน่นอน **มีเกณฑ์ไหนที่ใช้ตัดสินได้ว่า threshold ตัวไหน "คุ้มที่จะ sweep"** นอกจากลางสังหรณ์? ผมเดาว่าคำตอบเกี่ยวกับว่ามันเปลี่ยน label ของกี่ instrument ต่อการขยับหนึ่งหน่วย — แต่นั่นก็ต้อง sweep ถึงจะรู้

**4. `evidenceAgreement` ควรมีอยู่ต่อไหม?**
เราพิสูจน์แล้วว่ามันไม่ใช่ความน่าจะเป็น เราเปลี่ยนชื่อ เปลี่ยนเป็นคำ ย้ายตัวเลขไปหน้า "ทำไม?" — แต่มันก็ยัง**เรียงลำดับได้** และผู้ใช้จะเรียงลำดับด้วยมันอยู่ดี ตารางบอกว่า bucket 90-99 กับ 20-29 hit rate เท่ากัน **แล้วเหลือเหตุผลอะไรให้แสดงมันเลย** นอกจาก "มันเคยอยู่ที่นั่น"? ผมยังไม่กล้าเสนอให้เอาออกเพราะกลัวว่ากำลังทำลายของที่คนคุ้นเคย แต่ผมก็หาเหตุผลเชิงบวกให้มันไม่ได้จริงๆ

**5. Options Signal Engine — วัด หรือปล่อย?**
มันขาย "คะแนนความมั่นใจ" อยู่ตอนนี้ และไม่เคยถูกวัด เรามีเครื่องมือครบ (harness, corpus, base rate methodology) แต่ options ไม่มี historical chain เหมือนกัน — ซึ่งอาจแปลว่า **มันวัดไม่ได้ด้วยวิธีเดียวกัน** ถ้าวัดไม่ได้ ตำแหน่งที่ซื่อสัตย์คืออะไร? ปล่อยให้ขายคำที่เราเพิ่งพิสูจน์ว่าไร้ความหมายบนผลิตภัณฑ์พี่น้องของมัน ดูจะรับไม่ได้ แต่การเอาคำออกโดยไม่มีการวัดก็คือการสื่อข้อค้นพบที่ไม่มีอยู่ — **มีจุดยืนที่สามไหม**

**6. rollout ห้าขั้นตอน realistic แค่ไหน?**
`rollout-order.md` บอกให้เปิด GATE ตัวเดียวแล้วรอหลายวัน ผมเขียนมันเองและก็ยังไม่แน่ใจว่าจะมีใครทนทำตามจริง ถ้าเจ้าของเปิดทั้งห้าตัวพร้อมกันในวันเดียว **อะไรพังก่อน และมันพังแบบที่กู้คืนได้ไหม** — ผมเชื่อว่าใช่ (ทุก phase เป็น additive, unset ตัวแปรคือ rollback, ยกเว้น HISTORY ที่แถวยังอยู่) แต่ผมไม่เคยทดสอบสถานการณ์นั้น

**7. expected-move collector — ผมกำลังสร้างสิ่งที่ตัวเองเพิ่งเถียงว่าไม่ควรสร้างหรือเปล่า?**
P5 บอกว่าอย่าสร้างอะไรที่วัดไม่ได้ แล้วผมก็เขียน collector ทันที เหตุผลที่ให้ตัวเองคือ "นี่ไม่ใช่ฟีเจอร์ ไม่มีอะไรอ่านมัน ต้นทุนไม่กี่ KB ต่อวัน" ซึ่งผมยังเชื่ออยู่ แต่มันก็คือโค้ด 342 บรรทัด + migration อีก 137 บรรทัด + ตาราง production ที่ **ไม่มีใครแตะไปอีกปี** และตอนนี้ยังไม่มีเทสต์สักตัว **เส้นแบ่งระหว่าง "เก็บถูกๆ แล้วลืม" กับ "สร้างของที่ไม่มีใครขอ" อยู่ตรงไหน** และถ้ามันอยู่ผิดฝั่ง ทางที่ถูกคือลบทิ้ง หรือย่อให้เหลือ cron หนึ่งบรรทัดที่ยิงเข้าตารางเดียว?

---

## ภาคผนวก — Options Signal Engine: distribution regression (2026-08-19)

*เขียนโดย Claude ในเซสชัน `fix/options-signal-score-history-badges` · ทุกตัวเลขมาจาก `npm run signal:distribution` ที่รันจริง*

### ข้อจำกัดของตัวเลขชุดนี้ ที่ต้องอ่านก่อนเชื่อ

รันครั้งเดียว **วันเดียว regime เดียว** (19 ส.ค. 2026) กับ 30 tickers
(mega 10 / mid 10 / small 10) จึงยัง**ไม่ใช่หลักฐานว่าโมเดลคาลิเบรตดี**
เป็นแค่หลักฐานว่าการเปลี่ยนสูตร confidence ไม่ได้ทำให้ PRIME หายไป

| metric | n | mean | median | p10 | p90 |
| --- | ---: | ---: | ---: | ---: | ---: |
| score · OLD | 30 | 68.5 | 65 | 47.4 | 89.2 |
| score · NEW | 30 | 68.6 | 66 | 48.6 | 91.0 |
| confidence · OLD | 30 | 69.4 | 66 | 50.6 | 90.2 |
| confidence · NEW | 30 | 57.0 | 57.5 | 13.0 | 91.3 |

PRIME: OLD 8/30 (27%) · NEW 8/30 (27%) · **หายไป 0%** · label เปลี่ยน 2 ตัว
(GOOGL, DKNG: CALL_WATCH → SIDEWAYS ทั้งคู่ agreement 22–23%)

### สามข้อที่ต้องตามต่อ

1. **PRIME rate 27% น่าจะสูงเกินไป**
   ถ้า 1 ใน 4 ของหุ้นที่เปิดดูได้ป้ายแรงสุด ป้ายนั้นก็แทบไม่ได้คัดอะไร
   ต้องรันซ้ำ **หลายวัน หลาย regime** ก่อนสรุป — และการปรับ threshold
   ต้องมาจากข้อมูลชุดนั้น ไม่ใช่จากวันนี้วันเดียว

2. **PRIME_PUT = 0 จาก 30 ตัว ไม่ใช่บั๊ก**
   `symmetry.test.ts` mirror ทุก input แล้วพิสูจน์ว่า engine สมมาตร:
   points สลับเครื่องหมายครบทุกปัจจัย, |score − 50| เท่ากัน,
   confidence ต่างกัน ≤ 1, label สลับ PRIME_CALL ↔ PRIME_PUT, primeBlockers ว่างทั้งคู่
   คำอธิบายที่เหลือคือ **regime**: macro ใช้ SPY/QQQ ร่วมกันทุกสัญลักษณ์
   วันนั้นทั้งคู่อยู่เหนือ EMA20 → **ทุกตัวได้ macro +15 เหมือนกันหมด**
   PRIME_PUT จึงต้องการความเป็นขาลงเฉพาะตัวที่แรงพอจะกลบ +15 นั้น
   → ต้องรันซ้ำในวันที่ SPY/QQQ อยู่ใต้ EMA20 ถึงจะรู้ว่าฝั่ง Put ออกได้จริงไหม

3. **ข้อยกเว้นความสมมาตรมีจุดเดียว และตั้งใจ**
   แถบ Put/Call แบบสัมบูรณ์ (0.40–0.70 ฝั่ง call / 1.10–1.50 ฝั่ง put)
   ไม่ใช่ส่วนกลับของกันและกัน เพราะ Put/Call OI ปกติอยู่ราว 0.7–1.0
   ไม่ใช่ 1.0 การทำให้สมมาตรรอบ 1.0 จะแปลว่า book ธรรมดากลายเป็นขาลง
   เกณฑ์ percentile ซึ่ง engine เลือกใช้ก่อนเสมอเมื่อมีประวัติพอ **สมมาตรอยู่แล้ว**
   ล็อกไว้ใน `symmetry.test.ts` แล้ว

### วิธีรันซ้ำ

```
npm run signal:distribution
```

เทียบโมเดลเก่ากับใหม่บน input ชุดเดียวกัน ไม่แก้ threshold ใดๆ รายงานอย่างเดียว

---

## ภาคผนวก 2 — R:R saturation band + audit แนวรับ/แนวต้าน (2026-08-19)

### ทำไมเลือกทาง B ไม่เอา A

**A (`opposingCap` — จำกัดน้ำหนักเมื่อ R:R สวนทาง) ถูกปฏิเสธ** เหตุผลของเจ้าของ:
หลักฐานที่ขัดกับสมมติฐานจะมีน้ำหนักน้อยกว่าหลักฐานที่สนับสนุน ซึ่งเป็นการ
เอนเอียงเชิงระบบ และจะกัดกับ geometric-mean confidence ที่เพิ่งทำ — confidence
ตัวใหม่ทำงานโดยลงโทษความไม่สอดคล้อง ถ้าไปกดหลักฐานฝั่งที่สวนให้เบาลงก่อน
agreement ก็จะสูงเทียม แล้ว confidence ก็จะสูงตามแบบที่ไม่ควร **สองกลไกจะหักล้างกันเอง**

**B (ขยายจุดอิ่มตัว) เลือกใช้** และมีข้อมูลรองรับ: วัดจาก 30 สัญลักษณ์
rrCall กระจายตั้งแต่ 0.06 ถึง 35.27 median 2.31 — ด้วยแถบเดิมที่อิ่มตัวที่
0.5 และ 2.0 จึงมี **22 จาก 27 ตัวที่ปักอยู่ปลายใดปลายหนึ่ง** ปัจจัยนี้แยก
0.49 กับ 0.236 ไม่ออก และแยก 2.1 กับ 12 ไม่ออก แถบที่อิ่มตัวกับ 4 ใน 5
ของตลาดไม่ได้วัดอะไรเลย

### ค่าฐานที่ใช้

`OPTIONS_SIGNAL_CONFIG.riskReward.tiltSaturationRatio = 4.5`

- tilt = `log(rr) / log(4.5)` → อิ่มตัว +1 ที่ 4.5:1 และ −1 ที่ 1:4.5 (≈0.222)
- **สมมาตรโดยโครงสร้าง** เพราะ `log(1/x) = −log(x)` ฝั่งบวกได้ +15 ยากขึ้นเท่ากับ
  ที่ฝั่งลบได้ −15 ยากขึ้น — เป็นเจตนา ไม่ใช่ผลข้างเคียง
- **แยกจาก `saturationRatio = 2` ที่ยังคงเดิม** ซึ่งใช้กับ `setupQuality`
  และ `workableRatio` — "ฝั่งนี้เทรดได้" กับ "เรขาคณิตนี้คือหลักฐานทิศทางสูงสุด"
  เป็นคนละประโยค การรวมสองอันเข้าด้วยกันคือสาเหตุที่ปัจจัยนี้กลายเป็นสวิตช์ 3 จังหวะ
- **ไม่ได้แตะ threshold ใดๆ** (primeScore / watchScore / direction / primeConfidence เดิมทั้งหมด)

ผลกับเคสจากภาพ: rr −15 → −14 · raw 13 → 14 · score 57 → 58 · confidence 38 → 40 ·
**label ยังเป็น SIDEWAYS** (ข้อสรุปเดิมถูกอยู่แล้ว ที่เปลี่ยนคือความละเอียด)
0.236 กับ 0.49 ตอนนี้ต่างกัน 7 points จากเดิม 0

### distribution 3 ชุด (30 tickers วันเดียว)

| metric | n | mean | median | p10 | p90 |
| --- | ---: | ---: | ---: | ---: | ---: |
| score · pre-B | 30 | 68.5 | 65 | 47.4 | 89.2 |
| score · post-B | 30 | 68.8 | 66 | 48.6 | 91.1 |
| score · post-curve | 30 | 68.6 | 65.5 | 48.5 | 89.2 |
| confidence · pre-B | 30 | 67.5 | 60.5 | 46.7 | 89.1 |
| confidence · post-B | 30 | 55.3 | 52.5 | 14.8 | 91.0 |
| confidence · post-curve | 30 | 55.6 | 54.5 | 13.0 | 91.0 |

PRIME: pre-B 7 · post-B 7 · post-curve 7 → **การขยาย band เปลี่ยน PRIME 0%**
label เปลี่ยนจากการขยาย band: **0 จาก 30**

### audit แนวรับ/แนวต้าน — ยังไม่ต้องแก้ แต่มีงานค้าง

`npm run signal:levels`

**วิธีหา:** swing pivot ที่ยืนยันแล้ว (pivotWindow 3 → ต้องเป็นจุดสุดขั้วของกรอบ 7 แท่ง
และใช้ได้หลังผ่านไปอีก 3 แท่ง) จับกลุ่มด้วย tolerance ATR×0.6 ต้องมี ≥ 2 touches
strength ≥ 24/100 · แล้ว Options Signal หยิบ**ตัวที่ใกล้ที่สุด**ของแต่ละฝั่ง

**lookback: ไม่จำกัด** — ป้อนแท่งที่ปิดแล้วทั้งหมดจาก range `5y` = ~1254 แท่ง
ไม่มีการตัดที่ไหนเลย · recency มีน้ำหนักแค่ 20 จาก 100 และเป็นเส้นตรงตลอดทั้งชุด

| metric | median | p90 | max |
| --- | ---: | ---: | ---: |
| upside ATR | 1.60 | 2.97 | 9.12 |
| **downside ATR** | **0.76** | 1.91 | 5.68 |
| อายุแนวรับ (วัน) | 20 | 95 | 204 |
| อายุแนวต้าน (วัน) | 26.5 | 205.6 | **1650** |

**สรุป: median downside 0.76 ATR ต่ำกว่าเส้น 2.5 ATR มาก → lookback ยังรับได้
สำหรับ TF 1D ไม่ต้องแก้ level logic** และ rrCall 0.236 ในเคสจากภาพไม่ได้เกิดจาก input ที่ผิด

**งานค้างที่ควรตามต่อ:** หางยาวของอายุแนวต้าน — ROKU ใช้แนวต้านที่ถูกแตะครั้งสุดท้าย
เมื่อ **1650 วัน (4.5 ปี) ที่แล้ว** และ 4 จาก 30 ตัวใช้แนวที่เก่ากว่า 180 วัน
เป็นผลของ lookback ที่ไม่จำกัดบวก recency ที่มีน้ำหนักแค่ 20% ไม่กระทบค่ากลาง
จึงยังไม่ถึงเกณฑ์แก้ แต่ควรพิจารณา cap lookback หรือเพิ่มน้ำหนัก recency ในรอบหน้า

### อื่นๆ

`app/auth/actions.test.ts` เคย flake ตอนรันเต็มชุด — ไม่ได้มี timer หรือ network
แต่ `await import('./actions')` ใน `beforeEach` ช้า (2.8s เดี่ยวๆ) และชน CPU
ตอนรันขนาน · แก้ด้วย `vi.setConfig({ testTimeout: 30_000 })` ไม่ใช่ retry
เพราะ retry จะกลบ hang จริง

### เช็คปิดท้าย — เคสต้นเรื่องอยู่ใน tail ของแนวเก่าหรือเปล่า? **ไม่**

**ข้อเท็จจริงแรก: เคส `screenshot-baseline` ไม่มีสัญลักษณ์จริงอยู่เบื้องหลัง**
มันคือ fixture ที่ประกอบด้วยมือ (`symbol: 'TEST'`, support/resistance เป็นค่าคงที่
`89.425` / `102.5` ที่เลือกมาให้ได้ rrCall 0.236 / rrPut 4.23 พอดี) ไม่ได้ผ่าน
`calculateSupportResistance` จึง **ไม่มีอายุแนว / touches / strength ให้พิมพ์**
และไม่เคยมีการระบุ ticker จริงของภาพต้นเรื่องในเซสชันไหนเลย

**จึงวัดตัวแทนที่ใกล้ที่สุดแทน** — สัญลักษณ์จริงที่มีรูปทรงเดียวกัน (rrCall < 0.5
คือราคาอยู่ใกล้แนวต้านมากกว่าแนวรับมาก) จาก `npm run signal:levels`:

| symbol | rrCall | down % | down ATR | อายุแนวรับ (วัน) | touches | strength |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| MSFT | 0.37 | 3.48 | 1.24 | 78 | 7 | 73.94 |
| ENPH | 0.27 | 8.89 | 1.37 | 20 | 13 | 78.27 |
| CROX | 0.06 | 7.52 | 1.84 | 41 | 26 | 76.41 |
| RIVN | 0.34 | 6.88 | 1.26 | 54 | 30 | 77.36 |
| ACHR | 0.17 | 12.80 | 1.64 | 28 | 26 | 82.13 |
| JOBY | 0.13 | 10.65 | 1.59 | 20 | 24 | 77.62 |
| LUNR | 0.37 | 47.73 | 5.68 | 5 | 112 | 78.71 |

**สรุป: รูปทรงแบบเคสต้นเรื่องไม่ได้เกิดจากแนวเก่า** — แนวรับที่สร้าง downside ก้อนใหญ่
ล้วนสดใหม่ (median 28 วัน), ถูกแตะหนักมาก (24–112 ครั้ง เทียบเกณฑ์ขั้นต่ำ 2)
และแข็งแรง (74–82 จาก 100 เทียบเกณฑ์ 24) · มีแค่ 1 ใน 7 (MSFT) ที่ใช้แนวเก่ากว่า
180 วัน และเป็น**แนวต้าน** (202 วัน) ไม่ใช่แนวรับที่ทำให้ R:R เอียง

เพราะฉะนั้น **downside 12.53% ในภาพคือแนวจริง ไม่ใช่ artefact ของ lookback**
งานค้างเรื่อง cap lookback / เพิ่มน้ำหนัก recency ยังคงอยู่ (ROKU 1650 วัน)
แต่ไม่ใช่สาเหตุของเคสนี้ และไม่ควรถูกใช้เป็นเหตุผลในการแก้ R:R

---

## งานค้าง — สองฟิลด์ที่ต้องเข้า payload ก่อนแปล reason ได้ครบ

**สถานะ:** ค้างโดยตั้งใจ ไม่ใช่ลืม · เปิดไว้ตอนทำ `REASON_COPY`
(`src/components/analytics/market-signal/reason-copy.ts`)

`REASON_COPY` แปล reason ของ engine เป็นภาษาที่มือใหม่อ่านได้ โดย**ประกอบประโยคใหม่
จากฟิลด์ชุดเดียวกับที่ engine ใช้** ไม่ได้ parse `reason.text` ดังนั้น id ไหนที่ต้องใช้
ข้อมูลซึ่ง payload ไม่ได้ส่งออกมา จะแปลไม่ได้โดยไม่ทำข้อมูลหาย และจะ fallback ไปใช้
ประโยคเดิมของ engine แทน (ดู `REASON_IDS_WITHOUT_COPY`)

### ~~ที่ค้างอยู่ตอนนี้~~ ทำแล้ว: `macd-histogram`

**สถานะ: ปิดแล้ว** — ทำครบทั้ง 4 ขั้นตามแผนด้านล่างในคอมมิตเดียว
`metrics.histogramExpanding: boolean | null` เข้า payload แล้ว, `macd-histogram`
ย้ายเข้า `REASON_COPY`, และ `REASON_IDS_WITHOUT_COPY` ว่างเปล่าแล้ว
(ตารางยังอยู่ เพราะกฎที่มันถืออยู่ไม่ได้เปลี่ยน)

golden ที่เขียนทับ: 10 ไฟล์ · +10 บรรทัด · -0 บรรทัด — ทุกไฟล์กลับมา
byte-identical กับของเดิมทันทีที่ลบคีย์ใหม่ออก และ `--check` ผ่านหลังเขียนใหม่

หมายเหตุที่ต้องรู้ก่อนอ่านฟิลด์นี้: `histogramExpanding` คือ**การอ่านของ engine**
ไม่ใช่การเทียบความยาวตรง ๆ — เป็น `true` เมื่อแท่งบวก**ยาวขึ้น** และเมื่อแท่งลบ
**สั้นลง** (สองเคสที่ engine บวกคะแนนขึ้น 0.25) ดังนั้นคำว่ายาว/สั้นใน `REASON_COPY`
จึงต้องคำนวณจาก `macdHistogram > 0` คู่กับฟิลด์นี้ ไม่ใช่อ่านจากฟิลด์เดียว

ที่มาของเรื่องเดิมอยู่ข้างล่างนี้ เก็บไว้เพราะมันคือเหตุผลที่ท่าแก้เป็นแบบนี้


ประโยค engine: `MACD Histogram เป็นบวกและขยายตัว` / `แต่หดตัว`

ท่อน "ขยายตัว / หดตัว" มาจากการเทียบกับ `previousHistogram` (ค่าแท่งก่อนหน้า)
ซึ่ง **ไม่มีใน `MarketSignalMetrics`** — มีแค่ `macdHistogram` ของแท่งล่าสุด

**วัดแล้วว่าเติมไม่ได้ตอนนี้:** ลองเติม `histogramExpanding: boolean | null`
เข้า `MarketSignalMetrics` แล้วรัน `npm run snapshot:signal -- --check --symbols=IREN`
ผลคือ

```
IREN     DIFF
       "emaCompressionRatio": 0.061621,
  -    "keltnerLower": 34.809382961249554,
  +    "histogramExpanding": true,
GATE FAILED · 1 symbol(s) differ
```

`scripts/snapshot-signal.ts` serialize `MarketSignalResult` **ทั้งก้อน** ผ่าน
`stableStringify(result)` — คีย์ใหม่ใต้ `metrics` จึงเพิ่มบรรทัดใน JSON และทำให้
`--check` แตกทุก symbol

**ทางแก้เมื่อจะทำจริง** (ต้องทำพร้อมกันในคอมมิตเดียว):
1. เติม `histogramExpanding: boolean | null` ใน `MarketSignalMetrics`
   (`types.ts`) และใน `emptyMetrics()` (`calculations.ts`)
2. คำนวณจาก `previousHistogram` ที่ `calculations.ts` มีอยู่แล้วในสโคปนั้น
3. `npm run snapshot:signal` (เขียนทับ golden) แล้ว **review diff ให้เห็นว่ามีแต่
   คีย์ใหม่** ไม่มีค่าเดิมตัวไหนขยับ — นี่คือขั้นที่ห้ามข้าม
4. เพิ่ม entry `macd-histogram` ใน `REASON_COPY` และลบออกจาก
   `REASON_IDS_WITHOUT_COPY` (test บังคับว่าห้ามอยู่ทั้งสองที่)

### ที่แก้ได้แล้วโดยไม่ต้องแตะ payload: `bullish/bearish-divergence`

เคยคิดว่าต้องใช้ `divergenceStrength` ซึ่งไม่อยู่ใน payload **แต่ไม่ต้อง** —
engine ต่อท้ายวงเล็บ "จึงถ่วงน้ำหนักต่ำ" เมื่อ `gateOn && strength < minimumFlagWeight`
และ gate chip ออกเมื่อ `!gateOn || strength >= minimumFlagWeight` ซึ่งเป็น
**เงื่อนไขตรงข้ามกันพอดี** ดังนั้น

> มี `result.gate` **และ** ไม่มี flag `${direction}_divergence` ⟺ ตัวที่ถูกถ่วงน้ำหนักต่ำ

UI จึงสร้างเงื่อนไขขึ้นใหม่ได้ครบ ไม่มีข้อมูลหาย ไม่ต้อง parse string
มี test คุมไว้แล้ว — ถ้าวันหนึ่ง engine แยกสองเงื่อนไขนี้ออกจากกัน test จะแดง
