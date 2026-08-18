# Every place the app describes this feature as if it predicts

**Nothing in this file has been changed.** It is a list and a set of proposals,
for the owner to approve or rewrite. These are promises made to people who paid,
so the wording is not a developer's call.

Swept: `upgrade-copy.ts`, `plan-catalog.ts`, the pricing page, the card's own
locked preview, the glossary, onboarding, app and page metadata, the manifest,
the landing and support pages, and the disclaimer pages.

**Priority: items 1-3 must be settled BEFORE `SIGNAL_GATE` goes on.** All three
are live today with every flag off, and all three sit within a few centimetres of
the card that is about to stop using the word they promise.

---

## 1. `technical.outlook` — the Elite upgrade modal · MUST FIX FIRST

`src/lib/subscription/upgrade-copy.ts:95` — rendered by `UpgradeModal.tsx:66`,
which is what a Basic or Pro reader sees when they tap the padlock on the card.

**Now**

> เห็นสถานะแนวโน้ม คะแนนทิศทาง **ความมั่นใจ** และตัวชี้วัดจริงที่ระบบใช้สรุป

**Proposed**

> เห็นสถานะแนวโน้ม คะแนนทิศทาง ตัวชี้วัดจริงที่ระบบใช้ และเหตุผลรายข้อว่าทำไมถึงสรุปแบบนั้น

The swap is deliberate rather than a deletion: "ความมั่นใจ" is removed and the
per-reason breakdown — which is real, is the most useful thing on the card, and
was never sold — takes its place.

## 2. `technical.outlook.commodity` — the Pro upgrade modal · MUST FIX FIRST

`src/lib/subscription/upgrade-copy.ts:100`

**Now**

> เห็นแนวโน้ม คะแนนทิศทาง และ**ความมั่นใจ**ของทองคำ เงิน และน้ำมัน WTI จากราคาจริงของสัญญาล่วงหน้า

**Proposed**

> เห็นแนวโน้ม คะแนนทิศทาง และตัวชี้วัดของทองคำ เงิน และน้ำมัน WTI จากราคาจริงของสัญญาล่วงหน้า ไม่ใช่จากกองทุนที่อ้างอิงมัน

Same swap, and the tail restores a claim that IS true and is a genuine
differentiator — the contract, not the ETF that tracks it.

## 3. The card's own locked preview · MUST FIX FIRST

`src/components/analytics/market-signal/MarketSignalSection.tsx:236`

This is the worst of the three, because it sits **inside the card**, directly
above the footer that says the card does not forecast. After the flags go on, a
Basic reader would read "ความมั่นใจ" and the not-a-forecast sentence in one
glance, on one surface.

**Now**

> สรุปแนวโน้ม คะแนนทิศทาง และ**ความมั่นใจ**จากข้อมูลทางเทคนิคจริง

**Proposed**

> สรุปแนวโน้ม คะแนนทิศทาง และตัวชี้วัดทางเทคนิคจริง พร้อมเหตุผลว่าทำไมถึงสรุปแบบนั้น

## 4. The glossary entry for Directional Score · lower priority

`src/lib/analytics/glossary/terms.ts:247`

Not a prediction claim — a stale cross-reference to a word the card no longer
uses, which will send a reader looking for a "Confidence" that is not there.

**Now**

> when: 'ดูคู่กับ State, Bias, **Confidence** และคะแนนรายหมวดเสมอ'

**Proposed**

> when: 'ดูคู่กับ State, Bias, ความสอดคล้องของหลักฐาน และคะแนนรายหมวดเสมอ'

(The `signalConfidence` entry two rows below was already rewritten in P4.5 and
needs nothing.)

---

## Checked and clean — no change proposed

| Surface | Why it is fine |
| --- | --- |
| `plan-catalog.ts:123,126` | Names the feature (`Technical Outlook · Market Signal`) and claims nothing. |
| The pricing page | Renders from `plan-catalog.ts`; its own copy is about plans and prices. |
| `lockedLabel` strings | `Technical Outlook ใช้ได้ใน Elite` — availability, not capability. |
| App/page metadata, manifest | `แพลตฟอร์มวิเคราะห์ ติดตามพอร์ต และจำลองการลงทุน…` — no claim about this feature. |
| Onboarding | Does not mention the signal at all. |
| Glossary `directionalScore.what` | Already says `ไม่ใช่เปอร์เซ็นต์ความแม่นยำ`. |
| Every `ไม่ใช่การทำนายราคา` in the app | These are denials, and they are the wording we want more of, not less. |

## Two things outside this feature, flagged not proposed

**Options Signal Engine** — `upgrade-copy.ts:85` and `plan-catalog.ts:121` both
sell `คะแนนความมั่นใจ`, and `OptionsSignalSection.tsx:101` shows
`พร้อมคะแนนความมั่นใจ` on the card. That is a **different engine** and it has
**never been measured**. So this is not a copy problem — it is the same question
P4a asked about Market Signal, asked about a product nobody has run a harness
over. Changing its wording now would imply a finding that does not exist. The
honest options are to measure it or to leave it, and both are yours.

**Release notes** are stored in the database, not in this repository
(`ReleaseNoteEditor.tsx` writes them). If any existing note describes the
Technical Outlook in predictive terms, it is not visible from here and needs a
look in the admin console before the flags go on.

## What is NOT proposed anywhere

No price change, and no line on the pricing page announcing the measurement.
Items 1-3 remove a word for a thing that will not be on the card. Whether to go
further — the "position 2" option in `pricing-copy.md`, adding
`อ่านโครงสร้างราคาให้ ไม่ได้พยากรณ์ราคา` to the feature description — is a
separate decision and is still open.
