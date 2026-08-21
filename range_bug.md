# บั๊ก: การ์ดใบเดียวกันรายงาน range state ขัดกัน

## สรุปคำตอบ

**ใช่ — สองจุดนี้อ่านคนละตัวแปร คนละ threshold และคนละนิยามของ "กรอบ"**

แต่ต้นเหตุที่ทำให้มัน *ขัดกันบนหน้าจอ* ไม่ใช่ logic ของ threshold —
เป็นการแปลคำที่หยิบคำว่า "กรอบ" ไปใช้กับ object ที่ไม่ใช่กรอบ

---

## ต้นเหตุ + file:line

### แถบบน — ระบบ zone frame

| อะไร | ที่ไหน |
|---|---|
| ตัวแปร | `zones.pendingBreakout` |
| นิยาม | `zone !== 'uptrend' && close > upperTrigger` — [calculations.ts:853](src/lib/analytics/market-signal/calculations.ts#L853) |
| ขอบกรอบ | `frame.resistance` / `frame.support` (adaptive frame, re-anchor ได้, มี ATR-band mode) — [calculations.ts:801-802](src/lib/analytics/market-signal/calculations.ts#L801-L802) |
| buffer | `MARKET_SIGNAL_ZONE.triggerAtrMultiple * atr` = **0.25 × ATR** (absolute) — [signal.ts:246](src/config/signal.ts#L246) |
| ข้อความ | `PENDING_ZONE_COPY` — [MarketSignalSection.tsx:804-805](src/components/analytics/market-signal/MarketSignalSection.tsx#L804-L805) |
| | `ZONE_COPY.sideways` — [MarketSignalSection.tsx:765](src/components/analytics/market-signal/MarketSignalSection.tsx#L765) |

### หัวข้อความเสี่ยง — ระบบ confirmed pivot

| อะไร | ที่ไหน |
|---|---|
| ตัวแปร | `breakout` (คนละตัว ไม่เกี่ยวกับ `zones` เลย) |
| นิยาม | `breakoutDirection(previousClose, close, support, resistance) === 1` — [calculations.ts:1222-1223](src/lib/analytics/market-signal/calculations.ts#L1222-L1223) |
| ขอบ | confirmed swing pivot ที่ใกล้ที่สุดในกรอบ 120 แท่ง — [calculations.ts:1220-1221](src/lib/analytics/market-signal/calculations.ts#L1220-L1221) |
| buffer | `breakoutBufferRatio` = **0.001 (0.1% ratio)** — [signal.ts:56](src/config/signal.ts#L56) |
| เงื่อนไข | `previousClose <= resistance && close >= resistance * (1 + buffer)` — [calculations.ts:93](src/lib/analytics/market-signal/calculations.ts#L93) |
| emit reason | [calculations.ts:1522](src/lib/analytics/market-signal/calculations.ts#L1522) — `id: 'structure-volume-unconfirmed'`, `polarity: 'caution'` |
| ข้อความ | [reason-copy.ts:228](src/components/analytics/market-signal/reason-copy.ts#L228) — `'ราคาปิดออกนอกกรอบแล้ว แต่ปริมาณซื้อขาย...'` |

### บรรทัดที่เป็นต้นเหตุจริง ๆ

**[reason-copy.ts:228](src/components/analytics/market-signal/reason-copy.ts#L228)**

payload ฝั่ง engine เขียนว่า `Breakout ยังไม่มี Relative Volume ยืนยัน`
([calculations.ts:1522](src/lib/analytics/market-signal/calculations.ts#L1522))
ซึ่ง "Breakout" ตัวนี้หมายถึง **การทะลุ pivot** ไม่ใช่การออกจาก zone frame

ตอนแปลเป็นไทย คำว่า `Breakout` ถูกแปลว่า **"ออกนอกกรอบ"** — ซึ่งชนกับกติกา
"ONE WORD FOR ONE THING" ที่การ์ดตั้งไว้เองที่
[MarketSignalSection.tsx:744-762](src/components/analytics/market-signal/MarketSignalSection.tsx#L744-L762)
ที่ระบุว่าคำว่า **"กรอบ" สงวนไว้สำหรับสี่เหลี่ยมที่วาดบนแถบ (zone frame) เท่านั้น**

เข้ามาพร้อมคอมมิต `25e0dfc` (2026-08-20) *"copy(signal): translate the engine's reasons without touching the payload"*

---

## ตั้งใจให้ต่างกัน (hysteresis) หรือบั๊ก

### ไม่ใช่ hysteresis

hysteresis คือ **ขอบเดียวกัน สอง threshold** (เข้าที่ระดับหนึ่ง ออกที่อีกระดับ)
แต่ที่เจอคือ **สองระบบวัดคนละอัน**:

- คนละแหล่งขอบ — adaptive frame vs. confirmed pivot
- คนละหน่วย buffer — 0.25×ATR (absolute) vs. 0.1% (ratio)
- คนละความหมายของเวลา — `pendingBreakout` เป็น *สถานะต่อเนื่อง*, `breakout` เป็น *เหตุการณ์แท่งเดียว* (มีเงื่อนไข `previousClose <= resistance`)

### ฝั่ง engine ถูก — ฝั่งข้อความผิด

การที่ทั้งสองเป็นจริงพร้อมกันคือ **สถานะที่ถูกออกแบบมาให้เกิดได้** — ทะลุ pivot แล้ว
แต่ยังไม่พ้น zone trigger จึงยังไม่เปลี่ยน label ตัว `pendingBreakout` มีไว้อธิบายสถานะนี้ตรง ๆ
(ดูคอมเมนต์ [calculations.ts:850-852](src/lib/analytics/market-signal/calculations.ts#L850-L852))

**สรุป: เป็นบั๊กของคำ (copy/vocabulary collision) ไม่ใช่บั๊กของ threshold**
ตัวเลขทั้งสองฝั่งถูกทั้งคู่ แต่ประโยคที่ 228 พูดเหมือนเป็นข้อเท็จจริงจบแล้ว
("ออกนอกกรอบแล้ว") ทับกับกรอบที่แถบบนกำลังบอกว่ายังไม่ออก

### มีตัวอย่างที่ทำถูกอยู่ในไฟล์เดียวกัน

[reason-copy.ts:205-211](src/components/analytics/market-signal/reason-copy.ts#L205-L211)
(`pending-zone-break`) อธิบายเหตุการณ์ทางกายภาพเดียวกัน แต่:

- อ่าน `zones.pendingBreakout` — **ตัวแปรเดียวกับแถบบน**
- เขียนว่า `ราคาปิด{เหนือ|ใต้}กรอบแล้ว แต่ยังไม่ผ่านเกณฑ์` — ไม่ขัดกับแถบบน

บรรทัด 228 คือกรณีเดียวในตารางที่ใช้คำว่า "กรอบ" โดยไม่ได้อ่านค่าจาก `zones`

---

## หมายเหตุ

- ไม่ได้แก้โค้ด — รายงานอย่างเดียวตามที่สั่ง
- อ่านจริง 4 ไฟล์จาก 5 ไฟล์ที่รายงานไว้ (`types.ts` ไม่จำเป็น เพราะเจอต้นเหตุก่อน)
- เทสต์ที่ล็อกข้อความฝั่งแถบบนไว้แล้ว: [MarketSignalSection.test.tsx:1390-1419](src/components/analytics/market-signal/MarketSignalSection.test.tsx#L1390-L1419) — ยังไม่มีเทสต์ที่จับการชนกันข้ามสองบล็อกนี้
