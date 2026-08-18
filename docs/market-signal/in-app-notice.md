# In-app notice — first sight of the new card

**Status: DRAFT.** Wording not approved. Not built, not wired, no component.

Shown once, to a subscriber who already has `technical.outlook` or
`technical.outlook.commodity`, the first time they open a page carrying the
Technical Outlook card after the flags go on. Dismissible, never shown again.
It is not shown to anyone who has never seen the old card — there is nothing to
explain to somebody meeting the product for the first time.

---

## Version A — the short one (recommended)

> ### การ์ด Technical Outlook เปลี่ยนไป
>
> เราวัดการ์ดนี้ย้อนหลัง 108 สินทรัพย์ ตลอด 3 ปี แล้วพบว่าทิศทางที่มันระบุ
> ไม่ได้แม่นกว่าอัตราพื้นฐานของตลาด เราจึงแก้ให้มันพูดตามที่มันทำได้จริง
>
> - คำว่า **Confidence** หายไป กลายเป็น **ความสอดคล้องของหลักฐาน** เพราะมันวัด
>   ตัวระบบเอง ไม่ได้วัดโอกาสที่ราคาจะไปทางไหน
> - หลายสินทรัพย์จะขึ้นว่า **SIDEWAYS** แทนขาขึ้น/ขาลง — ป้ายทิศทางต้องมีหลักฐาน
>   มากกว่าเดิมถึงจะได้
> - ตัวชี้วัด แนวรับ แนวต้าน และเหตุผลทุกข้อ ยังอยู่ครบเหมือนเดิม
>
> [อ่านผลการวัดฉบับเต็ม] · [ปิด]

## Version B — the blunter one

> ### เราวัดการ์ดนี้แล้ว และผลไม่ได้อย่างที่หวัง
>
> Technical Outlook ระบุทิศทางถูก 51.4% ส่วนอัตราพื้นฐานของตลาดในช่วงเดียวกัน
> อยู่ที่ 51.3% — ต่างกันน้อยเกินกว่าจะเรียกว่าต่าง
>
> การ์ดจึงเลิกสื่อว่ามันพยากรณ์ได้ ตัวเลข Confidence ที่เคยขึ้นเป็นเปอร์เซ็นต์ถูกเอาออก
> จากบรรทัดหลัก และป้ายทิศทางต้องผ่านเกณฑ์หลักฐานก่อน หลายตัวจึงกลายเป็น SIDEWAYS
>
> สิ่งที่การ์ดยังทำได้ดีคือรวบข้อมูลทางเทคนิคที่กระจายอยู่หกที่ มาไว้ในที่เดียว
> พร้อมเหตุผลว่าทำไมถึงสรุปแบบนั้น
>
> [อ่านผลการวัดฉบับเต็ม] · [ปิด]

---

## Notes for you, not for the notice

**Why A is the recommendation.** B leads with the number, and a number in a
dismissible box is the thing people screenshot. A leads with what we did — we
measured our own product — and puts the number one click away in the changelog,
where it sits next to its own caveats. B is the better sentence and the worse
placement.

**What neither version does.** Neither apologises, and neither offers a refund.
The feature still does what the pricing page will say it does after the copy fix;
what changed is that it stopped claiming something extra that was never true.
If you would rather offer something, offer it separately — bundling it into this
notice turns a disclosure into a settlement.

**One thing to decide.** Version A says "3 ปี" and B says nothing about the
period. The measured window is 2023-04 to 2026-07. If you would rather the notice
carry the exact dates, take them from `MARKET_SIGNAL_MEASURED.period` rather than
typing them — that block is the only place in the codebase allowed to state them,
and a test keeps it matched to the calibration run.
