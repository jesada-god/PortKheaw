# Pricing copy that no longer describes the product

**Status: DRAFT.** Wording not approved. No code changed by this file.

Two strings sell this feature, and both of them sell a number the card has
stopped showing. They are not on a marketing page — they are in
`src/lib/subscription/upgrade-copy.ts`, which feeds the locked notice on the card
itself and the plan comparison. So the current state is that the locked preview
promises "ความมั่นใจ" directly above a card that deliberately no longer has it.

---

## 1. `technical.outlook` — Elite

`src/lib/subscription/upgrade-copy.ts`

**Now**

> เห็นสถานะแนวโน้ม คะแนนทิศทาง **ความมั่นใจ** และตัวชี้วัดจริงที่ระบบใช้สรุป

**Draft**

> เห็นสถานะแนวโน้ม คะแนนทิศทาง ตัวชี้วัดจริงที่ระบบใช้ และเหตุผลรายข้อว่าทำไมถึงสรุปแบบนั้น

## 2. `technical.outlook.commodity` — Pro

**Now**

> เห็นแนวโน้ม คะแนนทิศทาง และ**ความมั่นใจ**ของทองคำ เงิน และน้ำมัน WTI จากราคาจริงของสัญญาล่วงหน้า

**Draft**

> เห็นแนวโน้ม คะแนนทิศทาง และตัวชี้วัดของทองคำ เงิน และน้ำมัน WTI จากราคาจริงของสัญญาล่วงหน้า ไม่ใช่จากกองทุนที่อ้างอิงมัน

## 3. The plan catalog line — no change needed

`src/lib/subscription/plan-catalog.ts` says `Technical Outlook · Market Signal`
and `Technical Outlook · ทองคำ เงิน และน้ำมัน WTI`. Those name the feature and
claim nothing. Leave them.

---

## The question underneath, which is yours and not mine

The two rewrites above are the minimum: they remove a word for a thing that is no
longer on the card. What they do not do is tell a prospective buyer what the
measurement found before they pay.

Three positions, in increasing order of how much they cost you:

1. **Fix the two strings, say nothing else on pricing.** The disclosure is on the
   card, including in the locked preview a Basic user sees, so nobody can buy
   this without having had the chance to read it. Defensible, and the least
   generous reading of "telling the truth".
2. **Fix the strings and add one line to the feature description** — something
   like `อ่านโครงสร้างราคาให้ ไม่ได้พยากรณ์ราคา`. Costs some conversions, and is
   the version that matches what the card itself now says.
3. **Fix the strings and link the measurement from pricing.** Most honest, and
   asks a prospective buyer to read a report about a product they have not bought.

I would take 2. Position 1 is technically fine and reads as technically fine,
which is its problem — the disclosure exists but is placed where it is least
likely to change a decision. Position 3 sounds like the most honest option and in
practice puts a wall of caveats in front of someone who has not yet been given a
reason to care.

**Not a recommendation to change the price.** Nothing here says the feature is
worth less than it costs. It reads the tape, shows the levels, and explains its
own reasoning in one place, and that is what it was always doing; the part that
went away was a claim nobody had checked.
