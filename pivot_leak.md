# look-ahead audit: confirmed swing pivot → zone frame

## VERDICT: **CLEAN** — k = 3

`confirmedSwingPivots()` **ใช้แท่งขวามือ 3 แท่ง** ในการยืนยัน pivot
แต่ **ไม่ใช่ leak** เพราะโค้ดไม่เคยสมมติว่ารู้ค่านั้นเร็วกว่าที่รู้จริง —
ทุก pivot ถูกประทับเวลาที่ `confirmedAtIndex` (= `index + 3`) และผู้ใช้ทุกรายกรองด้วยฟิลด์นั้น
ไม่ใช่ `pivot.index`

`k = 3` — จาก `MARKET_SIGNAL_THRESHOLDS.structure.pivotWindow` ([signal.ts:55](src/config/signal.ts#L55))

---

## 1. แท่งขวามือถูกใช้ตรงไหน

[support-resistance/calculations.ts:48-70](src/lib/analytics/support-resistance/calculations.ts#L48-L70)

```
for (let confirmedAtIndex = window * 2; confirmedAtIndex < candles.length; confirmedAtIndex += 1) {
  const index = confirmedAtIndex - window;                              // index = confirmedAtIndex - 3
  const knownWindow = candles.slice(index - window, confirmedAtIndex + 1);  // [index-3 .. index+3]
```

`knownWindow` เป็นหน้าต่างสมมาตร 7 แท่ง (`2*window + 1`) — แท่งซ้าย 3, ตัวเอง 1, **แท่งขวา 3**
แท่งที่ `index` จะเป็น pivot ก็ต่อเมื่อสูง/ต่ำกว่าอีก 6 แท่งทั้งหมด ซึ่ง 3 ในนั้นยังไม่เกิดตอนแท่งนั้นปิด

**แต่** ลูปวิ่งด้วย `confirmedAtIndex` เป็นตัวนับ และ slice จบที่ `confirmedAtIndex` พอดี —
ไม่มีการอ่านแท่งใดที่เลย `confirmedAtIndex` ออกไป นั่นคือ pivot ที่ประทับว่า
"รู้ได้ตอนแท่งที่ N" ใช้ข้อมูลถึงแท่งที่ N เท่านั้นจริง ๆ

---

## 2. หลักฐานเชิงประจักษ์

รัน probe บน corpus จริง (`__golden__/candles`, 10 instrument, **2,462 pivot**):

| ตรวจอะไร | ผล |
|---|---|
| `confirmedAtIndex - index` | **= 3 ทุกตัว** (2462/2462) ไม่มี lag อื่นเลย |
| ตัด series ที่ `confirmedAtIndex` แล้ว pivot ยังโผล่ครบไหม | **ครบ 100%** — 0 fail |
| ตัดที่ `confirmedAtIndex - 1` แล้ว pivot โผล่ก่อนกำหนดไหม | **ไม่โผล่เลย** — 0 ตัว |

ข้อที่สองพิสูจน์ว่า **ไม่ leak** (ไม่ต้องใช้อนาคตเกินแสตมป์)
ข้อที่สามพิสูจน์ว่าแสตมป์ **ไม่หลวม** (ไม่ได้ประทับช้ากว่าที่ควร) — `confirmedAtIndex` แน่นพอดีเป๊ะ

---

## 3. zone frame สืบทอด lag เดียวกันไหม → **สืบทอด และสืบทอดอย่างถูกต้อง**

[calculations.ts:690](src/lib/analytics/market-signal/calculations.ts#L690)

```
const usable = pivots.filter((pivot) => pivot.confirmedAtIndex <= index && index - pivot.confirmedAtIndex <= lookback);
```

กรองด้วย `confirmedAtIndex <= index` ไม่ใช่ `pivot.index <= index` — ซึ่งเป็นความต่างที่สำคัญทั้งหมด
ถ้าใช้ `pivot.index` frame ย้อนหลังจะไป anchor กับ swing ที่ตลาดยังปั้นไม่เสร็จ และ trigger
ในอดีตทุกอันจะดู "ข้ามง่าย" กว่าความจริง คอมเมนต์เหนือบรรทัดนั้นระบุเจตนานี้ไว้ตรง ๆ

จุดอื่นในการเดิน frame ที่ตรวจแล้วว่า causal ทั้งหมด:

| จุด | ที่ไหน | อ่านอนาคตไหม |
|---|---|---|
| re-anchor เมื่อเจอ pivot ใหม่นอก frame | [:779](src/lib/analytics/market-signal/calculations.ts#L779) | ไม่ — `confirmedAtIndex === index` |
| `breakConfirmed()` ยืนยันการทะลุ | [:640-653](src/lib/analytics/market-signal/calculations.ts#L640-L653) | ไม่ — วนถอยหลัง `index - back` |
| touch / `lastTouch` | [:782-784](src/lib/analytics/market-signal/calculations.ts#L782-L784) | ไม่ — `candles[index]` |
| `trailingVolumeConfirmation()` | [sr:37-46](src/lib/analytics/support-resistance/calculations.ts#L37-L46) | ไม่ — `slice(index-19, index+1)` |
| backtest harness | [calibrate.ts:368](scripts/calibrate.ts#L368) | ไม่ — replay ทั้ง engine ด้วย `bars.slice(index + 1 - WINDOW, index + 1)` |

`.index` ดิบถูกใช้ 3 ที่ ([:236-238](src/lib/analytics/market-signal/calculations.ts#L236-L238),
[sr:74-105](src/lib/analytics/support-resistance/calculations.ts#L74-L105)) — ทั้งหมดเป็นการวัด
*ระยะห่างระหว่าง pivot* และการหาวันที่ของแท่งในอดีต ไม่มีที่ไหนใช้ `.index` เป็นเวลาที่ค่านั้น
"รู้ได้" divergence เองก็ emit ด้วย `confirmedAtIndex` ([:254-258](src/lib/analytics/market-signal/calculations.ts#L254-L258))

---

## 4. ผลที่ตามมาของ k = 3 (ถูกต้องแล้ว ไม่ใช่บั๊ก — แต่ควรรู้)

**4.1 ขอบ frame แก่อย่างน้อย 3 แท่งเสมอ**
`anchorAt()` หยิบ pivot ที่ confirm ล่าสุด ⇒ แท่งที่เป็นขอบจริงอยู่ห่างออกไปอย่างต่ำ 3 แท่ง
`upperTrigger = frame.resistance + 0.25×ATR` จึงอ้างอิงราคาที่เกิดเมื่อ ≥3 แท่งก่อน — by design

**4.2 หน้าต่าง 120 แท่งวัดเป็น "เวลา confirm" ไม่ใช่ "เวลาราคา"**
[:1215-1217](src/lib/analytics/market-signal/calculations.ts#L1215-L1217) กรอง
`confirmedAtIndex >= length-1-120` ⇒ แท่ง pivot ที่เข้าข่ายจริงคือ **แท่งที่ 3 ถึง 123 ย้อนหลัง**
"120 แท่ง" ในเชิงราคาจึงกินช่วง 123 แท่ง และไม่มีวันรวม 3 แท่งล่าสุด

**4.3 โค้ดรู้ตัวเรื่อง lag นี้ และชดเชยไว้แล้วหนึ่งจุด**
[:1228-1239](src/lib/analytics/market-signal/calculations.ts#L1228-L1239) พับ `close` เข้าไปเป็น
extreme ล่าสุดแบบ provisional ตอนให้คะแนน swing structure พร้อมคอมเมนต์อธิบายเคสจริงที่เคย
อ่านเป็น "lower highs" ทั้งที่ราคาทะลุไปแล้ว — **แต่ `breakoutDirection()` ไม่ได้ชดเชยแบบเดียวกัน**
มันเทียบ `close` กับ pivot ที่แก่ ≥3 แท่งตรง ๆ ซึ่ง *ถูกต้องในเชิง causality*
(นี่คือ boundary ที่ [reason-copy.ts:243](src/components/analytics/market-signal/reason-copy.ts#L243) พูดถึง — งาน A)

---

## 5. ข้อสังเกตรอง (เจอระหว่างตรวจ — ไม่ได้แก้ ไม่ใช่ leak)

**5.1 `bandAt()` ใช้ ema20 ของ "วันนี้" กับ frame ในอดีต** —
[:700-704](src/lib/analytics/market-signal/calculations.ts#L700-L704) รับ `ema20` มาเป็น scalar
ค่าเดียว (ของแท่งล่าสุด) แล้วใช้เป็นจุดกึ่งกลางของ band ทุก index ที่เดินผ่าน
ไม่ใช่ future leak — ข้อมูลทั้งหมดยังอยู่ในขอบเขต "ถึงตอนนี้" และ backtest replay ก็คำนวณ
ema20 ใหม่ทุกสเต็ป — แต่แปลว่า *ประวัติ* ที่การ์ดเล่า (`zoneAgeBars`, `crossings`, `entry.level`)
ไม่ใช่ replay ของเส้นที่เคยวาดจริง ซึ่งคอมเมนต์ที่ [:662-665](src/lib/analytics/market-signal/calculations.ts#L662-L665)
ก็ยอมรับไว้แล้วว่าตั้งใจ (แม้ตัวโค้ดจะ re-anchor ราย index จริง ๆ ทำให้คอมเมนต์อ่านคลาดกับโค้ดอยู่บ้าง)

**5.2 `latestTouchAt` ประทับเวลาที่แท่ง pivot ไม่ใช่แท่งที่ confirm** —
[sr:166](src/lib/analytics/support-resistance/calculations.ts#L166) ใช้ `candles[latest.index].date`
ถูกในฐานะ "วันที่ราคาไปแตะ" แต่ถ้ามีใครอ่านมันเป็น "โซนนี้มีตั้งแต่วันนั้น" จะเร็วไป 3 แท่ง
ตอนนี้ไหลไปแค่ [levels.ts:65](src/lib/analytics/support-resistance/levels.ts#L65) เพื่อแสดงผล
ยังไม่มี consumer ที่เอาไปตัดสินใจ

---

## หมายเหตุ

- **ไม่ได้แก้โค้ดใด ๆ ในงาน B** ตามที่สั่ง — probe ที่เขียนเพื่อวัดถูกลบทิ้งแล้ว
- ครอบคลุม: ผู้เรียก `confirmedSwingPivots()` ทั้ง 4 จุด, `.index` ดิบทุกจุด, backtest harness
