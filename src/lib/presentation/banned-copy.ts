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

/**
 * THE MARKET-REACTION BLOCK'S LIST — the narrowest scope in this file, and the
 * one with the sharpest reason.
 *
 * ===========================================================================
 * WHAT THE BLOCK IS ALLOWED TO BE
 * ===========================================================================
 * It prints what an index did on days a release was published. Each number is
 * a close-to-close change on a session that happened; it was measured, and it
 * is checkable against any chart. What NOBODY here computed is why the index
 * moved — no correlation, no event study, no control for the six other things
 * that happen on a Friday morning.
 *
 * So the block may state, and may not attribute. Every phrase below crosses
 * that line, in one of three ways:
 *
 *   IT ATTRIBUTES. "ส่งผลให้", "ทำให้ราคา", "กระตุ้นให้", "ตอบสนองต่อ" and
 *   "ปฏิกิริยา" all name the release as the cause of the number beside it.
 *   "ปฏิกิริยา" is on the list even though it is what this feature is called
 *   in conversation — a heading reading "ปฏิกิริยาตลาด" would make the causal
 *   claim in the one place a reader is guaranteed to look.
 *
 *   IT GENERALISES FROM THREE POINTS. "มักจะ", "โดยทั่วไป", "ปกติแล้ว",
 *   "ส่วนใหญ่" and "สถิติชี้" turn a handful of dates into a tendency. Three
 *   observations are three observations.
 *
 *   IT FORECASTS. "คาดว่า", "น่าจะ", "แนวโน้มว่า", "ครั้งนี้" — the last
 *   because "ครั้งก่อน +0.4%, ครั้งนี้..." is a prediction written as a
 *   sentence fragment.
 *
 * "เฉลี่ย" is the one that is not obviously wrong and is the most important.
 * An average of three release days is arithmetic anybody can do and reads as a
 * finding: it implies the three are samples of one repeatable quantity, which
 * is the claim the whole list declines to make. The block shows the dates and
 * their numbers, and lets a reader draw whatever they draw.
 *
 * ===========================================================================
 * SCOPED, FOR THE REASON CARD_MUST_NOT_SAY IS SCOPED
 * ===========================================================================
 * This is NOT added to `NEVER_SAY`. "เฉลี่ย" appears in sixty-five places in
 * the product — ต้นทุนเฉลี่ย, ค่าเฉลี่ย 20 วัน, ราคาไกลค่าเฉลี่ย — where it
 * is the correct word for a real average of a real series. A product-wide ban
 * would be a ban on the vocabulary rather than on its misuse, which is exactly
 * the argument the trading-jargon list above makes for itself.
 *
 * Enforced by `portkheaw/no-banned-copy` scoped to the calendar feature in
 * `eslint.config.mjs`, and asserted over rendered output in
 * `reactions.test.ts` and `MonthCalendar.test.tsx`.
 */
export const EVENT_REACTION_MUST_NOT_SAY = [
  // Attributes the movement to the release.
  'ส่งผลให้', 'ทำให้ราคา', 'กระตุ้นให้', 'ตอบสนองต่อ', 'ปฏิกิริยา',
  // Generalises a handful of dates into a tendency.
  'มักจะ', 'โดยทั่วไป', 'ปกติแล้ว', 'ส่วนใหญ่', 'สถิติชี้', 'เฉลี่ย',
  // Forecasts.
  'คาดว่า', 'น่าจะ', 'แนวโน้มว่า', 'ครั้งนี้',
] as const;
