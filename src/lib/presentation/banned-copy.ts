/**
 * The words PortKheaw does not say, in one place.
 *
 * Two lists, because they forbid two different things and are enforced over two
 * different scopes.
 *
 * They live in `src/lib` rather than in a test because they are now read by
 * three callers: the eslint rule that scans the five reader-facing pages, the
 * market-signal card's own copy sweep, and anybody writing new copy. The
 * trading-jargon list used to be a `const` inside
 * `MarketSignalSection.test.tsx`, where a second surface could not reach it —
 * which is exactly how a locked Tools card came to say "เครื่องมือนี้จะช่วยให้
 * คุณ" while one card two files away was held to a vocabulary.
 */

/**
 * TRADING JARGON — the market-signal card's list, held to the card.
 *
 * The card explains a reading to somebody who does not trade for a living. Each
 * of these is a term that only means something to somebody who already knows
 * what the card is about to tell them, and a card that reaches for one has
 * stopped explaining and started naming.
 *
 * Scoped to the card ON PURPOSE. "ATR" belongs in the dialog that shows the
 * arithmetic, "โซน" is a legitimate word on the chart's own controls, and a
 * product-wide ban would be a ban on the vocabulary rather than on its misuse.
 */
export const CARD_MUST_NOT_SAY = [
  'โซน', 'ไซด์เวย์', 'เบรก', 'breakout', 'breakdown', 'sideways',
  'หลุด', 'พลิกกลับ', 'ตกกลับ', 'โมเมนตัม', 'วอลุ่ม', 'โครงสร้าง',
  'swing', 'ATR', 'divergence', 'ของกรอบ', 'เงื่อนไขยืนยัน',
] as const;

/**
 * THE PRODUCT-WIDE LIST — phrases that misdescribe where a number came from,
 * or sell the reader something.
 *
 * Every entry is here for one of two reasons:
 *
 *  - IT CLAIMS A NARRATOR THE PRODUCT DOES NOT HAVE. "ระบบประเมินว่า",
 *    "AI วิเคราะห์ว่า", "จากการวิเคราะห์ปัจจัยต่าง ๆ" all describe a judgement
 *    being formed somewhere the reader cannot inspect. Every figure in
 *    PortKheaw comes from a named service with a stated method, and a sentence
 *    that attributes it to a system instead is describing a different product.
 *    "การวิเคราะห์ด้วย AI" is on the list because it shipped: a banner on the
 *    stock page's Analysis tab announced it as coming soon.
 *
 *  - IT SELLS. "เครื่องมือนี้จะช่วยให้คุณ" is the register of a feature list,
 *    and it was the register the whole Tools index was written in.
 *
 * "มีความเป็นไปได้ว่า" is the subtlest and the most important. It is the
 * grammar of a forecast, and nothing here forecasts — the signal card, the
 * planner and the summary all state what IS, and each carries a footer saying
 * so. A sentence in this shape contradicts the footer under it.
 */
export const NEVER_SAY = [
  'ระบบประเมินว่า',
  'จากการวิเคราะห์ปัจจัย',
  'มีความเป็นไปได้ว่า',
  'เครื่องมือนี้จะช่วยให้คุณ',
  'AI วิเคราะห์ว่า',
  'การวิเคราะห์ด้วย AI',
] as const;
