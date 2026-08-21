import type {
  MarketSignalActionable,
  MarketSignalGate,
  MarketSignalMetrics,
  MarketSignalReason,
  MarketSignalResult,
  MarketSignalZones,
} from '@/src/lib/analytics/market-signal/types';
import { MARKET_SIGNAL_MEASURED, MARKET_SIGNAL_THRESHOLDS } from '@/src/config/signal';

/**
 * The reasons, said again in the words the rest of the card uses.
 *
 * WHY THIS IS NOT A CHANGE TO THE ENGINE. `reasons[].text` is payload: it is
 * written in `calculations.ts`, it is what the engine recorded about its own
 * arithmetic, and `__golden__/signal/*.json` is a byte-for-byte snapshot of it.
 * Rewording it there would move a gate that has nothing to do with copy. So the
 * strings stay exactly as they are and this is a presentation layer over them —
 * the card shows a sentence a beginner can finish, the payload keeps the record
 * an engineer can check, and `snapshot:signal --check` never sees this file.
 *
 * NOTHING HERE PARSES `reason.text`. Every entry rebuilds its sentence from the
 * SAME fields the engine built its own from — `metrics`, `gate`, `zones`,
 * `actionable`, `flags` and the config thresholds — so a number on the card can
 * never drift away from the number in the payload, and a wording change in the
 * engine can never silently corrupt a translation here. Where a fact is not in
 * the payload at all, the entry is absent and the engine's own sentence is
 * shown instead — `REASON_IDS_WITHOUT_COPY` is where such an id is named, and
 * it is empty today because `macd-histogram`, the last one on it, got the field
 * it was waiting for (`metrics.histogramExpanding`).
 *
 * THE LANGUAGE STANDARD every entry is held to, enforced by
 * `reason-copy.test.ts`:
 *
 *   1. Every number carries the threshold it is judged against. "ADX 24" is a
 *      reading; "24 — ต่ำกว่า 25 ถือว่ายังไม่มีแนวโน้มชัด" is a fact a reader
 *      can act on. All such thresholds are read from `MARKET_SIGNAL_THRESHOLDS`
 *      rather than typed in, so the sentence cannot outlive the rule.
 *   2. A sentence describing a state carries what that state MEANS. "เส้นสั้น
 *      อยู่เหนือเส้นยาว" is a description of a picture; the reader needs the
 *      clause after the dash.
 *   3. 15-35 words, measured with `Intl.Segmenter`. A list where one item is
 *      six words and the next is fifty reads as though the short ones matter
 *      less.
 *   4. At most two clauses to a sentence. Longer splits into two sentences.
 *   5. The test a draft has to pass: somebody who has never traded reads it
 *      ONCE and can say what is happening and whether it is good or bad. An
 *      entry that answers only one of those is not finished.
 *
 * The indicator's own name rides in brackets — "(RSI)", "(ADX)" — so a reader
 * who goes looking for it elsewhere has the word to search for, without having
 * to learn it to read the sentence. Five ids have no standard abbreviation and
 * carry none: the two structure breaks, the swing structure, the pending frame
 * break and the narrow-range band.
 */

export type ReasonBaseContext = Omit<ReasonContext, 'polarity'>;

export type ReasonContext = {
  polarity: MarketSignalReason['polarity'];
  metrics: MarketSignalMetrics;
  gate: MarketSignalGate | null;
  zones: MarketSignalZones | null;
  actionable: MarketSignalActionable | null;
  flags: readonly string[];
  timeframe: string;
};

const T = MARKET_SIGNAL_THRESHOLDS;

/** A number the way the card prints numbers: no trailing zeros, no exponent. */
const n = (value: number, digits = 1): string =>
  Number(value.toFixed(digits)).toLocaleString('en-US', { maximumFractionDigits: digits });

/**
 * "แท่ง", and what a bar actually is on the timeframe in front of the reader.
 *
 * The engine counts in bars because that is what it iterates over, and "5 แท่ง"
 * means nothing to somebody who has not been told what a bar is. On the only
 * timeframe this card ships on, a bar is a trading day, so the sentence says
 * both: the engine's unit, and the thing it corresponds to. On any other
 * timeframe the gloss would be wrong, so it is simply not added.
 */
const bars = (count: number, timeframe: string): string =>
  timeframe === '1D' ? `${count} แท่ง (วันทำการ)` : `${count} แท่ง`;

/** The three EMA slope rows, which differ only in which average they are about. */
const slopeCopy = (span: 20 | 50 | 200, pct: number | null, polarity: ReasonContext['polarity']): string | null => {
  if (pct === null || !Number.isFinite(pct)) return null;
  const size = `เส้นค่าเฉลี่ยราคา ${span} วัน (EMA${span})`;
  const value = `${n(Math.abs(pct), 2)}%`;
  if (polarity === 'positive') return `${size} กำลังชี้ขึ้น ${value} — แปลว่าราคาช่วงหลังยืนสูงกว่าช่วงก่อนหน้า จึงนับเป็นหลักฐานฝั่งขึ้น`;
  if (polarity === 'negative') return `${size} กำลังชี้ลง ${value} — แปลว่าราคาช่วงหลังยืนต่ำกว่าช่วงก่อนหน้า จึงนับเป็นหลักฐานฝั่งลง`;
  return `${size} เกือบทรงตัว เอียงอยู่ ${value} — ยังไม่เอียงไปทางขึ้นหรือทางลงพอจะนับเป็นหลักฐาน`;
};

export const REASON_COPY: Record<string, (context: ReasonContext) => string | null> = {
  'ema-structure': ({ polarity }) => {
    if (polarity === 'positive') return 'ราคายืนอยู่เหนือเส้นค่าเฉลี่ยราคา (EMA) และเส้นระยะสั้นอยู่เหนือเส้นระยะยาว — เป็นการเรียงตัวแบบที่เห็นตอนราคาไต่ขึ้นต่อเนื่อง';
    if (polarity === 'negative') return 'ราคาอยู่ใต้เส้นค่าเฉลี่ยราคา (EMA) และเส้นระยะสั้นอยู่ใต้เส้นระยะยาว — เป็นการเรียงตัวแบบที่เห็นตอนราคาไหลลงต่อเนื่อง';
    return 'ราคากับเส้นค่าเฉลี่ยราคา (EMA) ยังเรียงสลับกันอยู่ ไม่ได้ชี้ไปทางเดียวกันทั้งหมด — จึงยังใช้ตัดสินทิศทางไม่ได้';
  },

  'ema20-slope': ({ metrics, polarity }) => slopeCopy(20, metrics.ema20SlopePct, polarity),
  'ema50-slope': ({ metrics, polarity }) => slopeCopy(50, metrics.ema50SlopePct, polarity),
  'ema200-slope': ({ metrics, polarity }) => slopeCopy(200, metrics.ema200SlopePct, polarity),

  rsi14: ({ metrics }) => {
    if (metrics.rsi14 === null) return null;
    return `แรงซื้อเทียบแรงขายช่วง 14 วัน (RSI) อยู่ที่ ${n(metrics.rsi14)} จาก 100 — เกิน 50 คือฝั่งซื้อแรงกว่า ต่ำกว่า 50 คือฝั่งขายแรงกว่า`;
  },

  'rsi-extreme': ({ metrics }) => {
    if (metrics.rsi14 === null) return null;
    const high = metrics.rsi14 >= T.momentum.rsiBullishExtreme;
    const edge = high ? T.momentum.rsiBullishExtreme : T.momentum.rsiBearishExtreme;
    return `แรงซื้อเทียบแรงขาย (RSI) อยู่ที่ ${n(metrics.rsi14)} ซึ่ง${high ? 'เกิน' : 'ต่ำกว่า'} ${edge} — ราคาวิ่งทางเดียวมาไกลผิดปกติ จึงควรระวังมากกว่าเดิม`;
  },

  'macd-signal': ({ polarity }) => {
    if (polarity === 'positive') return 'เส้นวัดแรงส่ง (MACD) อยู่เหนือเส้นสัญญาณของตัวเอง — แปลว่าแรงส่งช่วงหลังมากกว่าค่าเฉลี่ยแรงส่งของมันเอง จึงนับเป็นหลักฐานฝั่งขึ้น';
    if (polarity === 'negative') return 'เส้นวัดแรงส่ง (MACD) อยู่ใต้เส้นสัญญาณของตัวเอง — แปลว่าแรงส่งช่วงหลังน้อยกว่าค่าเฉลี่ยแรงส่งของมันเอง จึงนับเป็นหลักฐานฝั่งลง';
    return 'เส้นวัดแรงส่ง (MACD) อยู่พอดีกับเส้นสัญญาณของตัวเอง — แรงส่งยังไม่เอียงไปทางไหน จึงยังไม่ช่วยตัดสินทิศทาง';
  },

  /*
   * The row that waited for a field, and the field it waited for.
   *
   * The engine's own sentence says two things: which side the momentum bar is
   * on, and whether it grew or shrank against the bar before it. The first was
   * always in `metrics.macdHistogram`; the second lived only inside the factor
   * that wrote the sentence, so this row could not be restated without dropping
   * half of it and shipped the engine's words instead. `histogramExpanding` is
   * that second half published, and this is the translation it unblocked.
   *
   * WHICH WAY "EXPANDING" POINTS. The field is the engine's reading, not a
   * plain length comparison: it is true when a POSITIVE bar is longer than the
   * one before it and when a NEGATIVE bar is shorter — the two cases where the
   * engine nudges the score up. So the length word here is derived from the two
   * fields TOGETHER (`macdHistogram > 0` against `histogramExpanding`) rather
   * than read off the flag alone, which would print "ยาวกว่า" for a shrinking
   * bar on the falling side and tell the reader the opposite of the chart.
   *
   * `null` is the engine saying neither, and gets its own sentence rather than
   * a guessed one: no previous bar, or a bar that matched it exactly.
   */
  'macd-histogram': ({ metrics }) => {
    if (metrics.macdHistogram === null) return null;
    if (metrics.macdHistogram === 0) return 'แท่งวัดแรงส่ง (MACD Histogram) อยู่พอดีที่ศูนย์ — แรงฝั่งขึ้นกับฝั่งลงเท่ากัน จึงยังไม่ช่วยตัดสินทิศทาง';
    const up = metrics.macdHistogram > 0;
    if (metrics.histogramExpanding === null) {
      return up
        ? 'แท่งวัดแรงส่ง (MACD Histogram) อยู่ฝั่งบวก แต่เทียบกับแท่งก่อนหน้าแล้วยังบอกไม่ได้ว่าแรงเพิ่มหรือแผ่วลง — จึงรู้แค่ว่าแรงอยู่ฝั่งขึ้น'
        : 'แท่งวัดแรงส่ง (MACD Histogram) อยู่ฝั่งลบ แต่เทียบกับแท่งก่อนหน้าแล้วยังบอกไม่ได้ว่าแรงเพิ่มหรือแผ่วลง — จึงรู้แค่ว่าแรงอยู่ฝั่งลง';
    }
    // Longer means the bar moved the way its own sign points, which is the
    // move the engine scored up: a positive bar growing, a negative one deeper.
    const longer = up === metrics.histogramExpanding;
    if (up) {
      return longer
        ? 'แท่งวัดแรงส่ง (MACD Histogram) อยู่ฝั่งบวกและยาวกว่าแท่งก่อนหน้า — แปลว่าแรงฝั่งขึ้นกำลังเพิ่มขึ้น ไม่ใช่แค่ค้างอยู่เท่าเดิม'
        : 'แท่งวัดแรงส่ง (MACD Histogram) อยู่ฝั่งบวกแต่สั้นกว่าแท่งก่อนหน้า — แรงฝั่งขึ้นยังมีอยู่ แต่กำลังแผ่วลงเรื่อย ๆ';
    }
    return longer
      ? 'แท่งวัดแรงส่ง (MACD Histogram) อยู่ฝั่งลบและยาวกว่าแท่งก่อนหน้า — แปลว่าแรงฝั่งลงกำลังเพิ่มขึ้น ไม่ใช่แค่ค้างอยู่เท่าเดิม'
      : 'แท่งวัดแรงส่ง (MACD Histogram) อยู่ฝั่งลบแต่สั้นกว่าแท่งก่อนหน้า — แรงฝั่งลงยังมีอยู่ แต่กำลังแผ่วลงเรื่อย ๆ';
  },

  'adx-dmi': ({ metrics }) => {
    if (metrics.adx14 === null) return null;
    const strong = metrics.adx14 >= T.trendStrength.adxTrendMinimum;
    const lead = metrics.plusDi14 === null || metrics.minusDi14 === null ? null
      : metrics.plusDi14 > metrics.minusDi14 ? 'ฝั่งขึ้นแรงกว่าฝั่งลง'
        : metrics.plusDi14 < metrics.minusDi14 ? 'ฝั่งลงแรงกว่าฝั่งขึ้น' : 'สองฝั่งแรงพอกัน';
    const verdict = strong
      ? `ตั้งแต่ ${T.trendStrength.adxTrendMinimum} ขึ้นไปถือว่ามีแนวโน้มจริง`
      : `ต่ำกว่า ${T.trendStrength.adxTrendMinimum} ถือว่ายังไม่มีแนวโน้มชัด`;
    return `ความแรงของแนวโน้ม (ADX) อยู่ที่ ${n(metrics.adx14)} — ${verdict}${lead === null ? '' : ` และตอนนี้${lead}`}`;
  },

  'relative-volume': ({ metrics, polarity }) => {
    if (metrics.relativeVolume20 === null) return null;
    const value = `${n(metrics.relativeVolume20, 2)} เท่า`;
    const head = `ปริมาณซื้อขายวันล่าสุด (Relative Volume) เป็น ${value}ของค่าเฉลี่ย 20 วัน`;
    if (polarity === 'information') return `${head} — ยังไม่ถึง ${T.volume.relativeVolumeConfirmation} เท่าที่ถือว่ามากพอจะยืนยันทิศทาง`;
    return `${head} — ตั้งแต่ ${T.volume.relativeVolumeConfirmation} เท่าขึ้นไปถือว่าคนสนใจมากพอจะยืนยันการเคลื่อนไหว`;
  },

  'obv-trend': ({ polarity }) => {
    if (polarity === 'positive') return 'ปริมาณซื้อขายสะสมเพิ่มขึ้น — วันที่ราคาขึ้นมีคนซื้อขายมากกว่าวันที่ราคาลง (OBV) เป็นสัญญาณว่าแรงฝั่งซื้อหนุนอยู่จริง';
    if (polarity === 'negative') return 'ปริมาณซื้อขายสะสมลดลง — วันที่ราคาลงมีคนซื้อขายมากกว่าวันที่ราคาขึ้น (OBV) เป็นสัญญาณว่าแรงฝั่งขายหนุนอยู่จริง';
    return 'ปริมาณซื้อขายสะสมทรงตัว — วันที่ราคาขึ้นกับวันที่ราคาลงมีคนซื้อขายพอกัน (OBV) จึงยังไม่หนุนฝั่งไหนเป็นพิเศษ';
  },

  'swing-structure': ({ polarity }) => {
    if (polarity === 'positive') return 'จุดสูงและจุดต่ำล่าสุดของราคาขยับขึ้นกว่ารอบก่อน — เป็นรูปแบบที่บอกว่าคนซื้อยอมจ่ายแพงขึ้นเรื่อย ๆ จึงนับเป็นหลักฐานฝั่งขึ้น';
    if (polarity === 'negative') return 'จุดสูงและจุดต่ำล่าสุดของราคาขยับลงกว่ารอบก่อน — เป็นรูปแบบที่บอกว่าคนขายยอมขายถูกลงเรื่อย ๆ จึงนับเป็นหลักฐานฝั่งลง';
    return 'จุดสูงและจุดต่ำล่าสุดของราคายังขยับสลับกัน ไม่ได้ไล่ขึ้นหรือไล่ลงเป็นชุด — จึงยังบอกทิศทางไม่ได้';
  },

  'structure-breakout': () => 'ราคาปิดขึ้นเหนือแนวที่เคยกดราคาลงมาหลายครั้ง — แนวที่เคยเป็นเพดานถูกผ่านขึ้นไปแล้ว จึงนับเป็นหลักฐานฝั่งขึ้น',
  'structure-breakdown': () => 'ราคาปิดลงใต้แนวที่เคยรับราคาไว้หลายครั้ง — แนวที่เคยเป็นพื้นถูกผ่านลงไปแล้ว จึงนับเป็นหลักฐานฝั่งลง',

  'squeeze-on': () => 'ช่วงที่ราคาแกว่งในแต่ละวันแคบลงกว่าปกติมาก (Bollinger แคบกว่า Keltner) — เป็นเรื่องของความแรง ไม่ได้บอกว่าราคาจะไปทางขึ้นหรือทางลง',

  overextended: ({ metrics }) => {
    if (metrics.ema20DeviationPct === null) return null;
    const above = metrics.ema20DeviationPct > 0;
    return `ราคาอยู่${above ? 'สูง' : 'ต่ำ'}กว่าเส้นค่าเฉลี่ยราคา 20 วัน อยู่ ${n(Math.abs(metrics.ema20DeviationPct), 2)}% ซึ่งไกลกว่าที่หุ้นตัวนี้เคยเป็นตามปกติ — จึงควรระวังการแกว่ง${above ? 'ลง' : 'ขึ้น'}กลับ`;
  },

  /*
   * The two divergence rows, INCLUDING the qualifier the engine appends.
   *
   * That qualifier — "(RSI x อยู่กลางโซน จึงถ่วงน้ำหนักต่ำ)" — fires exactly
   * when `gateOn && divergenceStrength < minimumFlagWeight`, and the engine
   * gates its chip on the complement of the same condition. So a divergence
   * that was weighted down is precisely one where the gate is on and the chip
   * is absent, which are two fields this card already has. Nothing is parsed
   * and nothing is missing: the condition is reconstructed, not inferred.
   */
  'bullish-divergence': (context) => divergenceCopy('bullish', context),
  'bearish-divergence': (context) => divergenceCopy('bearish', context),

  'component-conflict': ({ gate }) => {
    const emaSide = gate?.conflicts.includes('ema_vs_momentum') ?? true;
    const pair = emaSide ? 'เส้นค่าเฉลี่ยราคา กับแรงส่งของราคา' : 'จุดสูง-จุดต่ำของราคา กับแรงส่งของราคา';
    return `${pair} กำลังชี้คนละทาง — เมื่อหลักฐานสองชุดขัดกันเอง ระบบจะไม่สรุปว่าไปทางขึ้นหรือทางลง`;
  },

  'earnings-proximity': ({ gate }) => {
    if (gate?.daysToEarnings === null || gate?.daysToEarnings === undefined) return null;
    return `อีก ${gate.daysToEarnings} วันบริษัทจะประกาศผลประกอบการ — เป็นเหตุการณ์ที่กราฟยังมองไม่เห็น และมักทำให้ราคาขยับแรงกว่าที่หลักฐานชุดนี้บอก`;
  },

  'pending-zone-break': ({ zones, timeframe }) => {
    if (zones === null) return null;
    const measured = MARKET_SIGNAL_MEASURED.pendingBreakout;
    const side = zones.pendingBreakout ? 'เหนือ' : 'ใต้';
    return `ราคาปิด${side}กรอบแล้ว แต่ยังไม่ผ่านเกณฑ์.`
      + ` จากสถิติ ${measured.sampleSize} ครั้ง ราว ${measured.confirmedWithinFiveBars}% ผ่านเกณฑ์ภายใน ${bars(5, timeframe)}`
      + ` และราว ${measured.stillDirectionalAtTwentyBars}% ยังมีทิศทางเมื่อครบ 20 แท่ง`;
  },

  'narrow-range-band': () => 'แนวบนกับแนวล่างของกรอบใกล้กันเกินกว่าจะใช้ตัดสินได้.'
    + ' ระบบจึงคำนวณกรอบจากความเหวี่ยงเฉลี่ยรอบเส้นค่าเฉลี่ยราคา 20 วันแทน ซึ่งขยับทุกวัน',

  'invalidation-from-band': () => 'กรอบตอนนี้คำนวณจากความเหวี่ยงของราคา ไม่ใช่ราคาที่ตลาดเคยชนจริง.'
    + ' ระบบจึงไม่ระบุจุดที่ถือว่ารอบนี้จบ เพราะตัวเลขนั้นจะขยับทุกวัน',

  'no-defensible-target': ({ actionable }) => (
    actionable?.notes.includes('measured_move_reached')
      ? 'ราคาวิ่งไปครบระยะเท่าความสูงกรอบเดิมแล้ว — ธรรมเนียมที่ใช้ตั้งเป้าจึงใช้ต่อไม่ได้ และระบบไม่มีเป้าถัดไปที่อ้างอิงกรอบได้'
      : 'กรอบตอนนี้วัดความสูงไม่ได้ — ธรรมเนียมที่ใช้ตั้งเป้าต้องใช้ความสูงของกรอบ ระบบจึงไม่แสดงเป้าและไม่แสดงการเทียบระยะ'
  ),

  /*
   * THREE WORDS THIS ENTRY MAY NOT USE, and what it says instead.
   *
   * The engine raises this id off `breakoutDirection(...)` — a close through
   * the nearest CONFIRMED SWING PIVOT within 120 bars, buffered by a 0.1%
   * ratio. Naming that object is the whole difficulty:
   *
   *   "กรอบ"       belongs to the rectangle on the zone bar, which is a
   *                different object measured a different way (`frame.resistance`
   *                buffered by 0.25 ATR). The two can sit on opposite sides of
   *                one close by design — that state is `pendingBreakout`. This
   *                line once said "ราคาปิดออกนอกกรอบแล้ว" while the bar a
   *                thumb-length above said "ราคายังอยู่ในกรอบเดิม"; both were
   *                right about their own measurement and the card read as
   *                broken. See ONE WORD FOR ONE THING in `MarketSignalSection`.
   *   "จุดสวิง"    is "swing" in Thai letters. The ban list caught the Latin
   *                spelling and let the transliteration through, which moves the
   *                jargon rather than removing it. `reason-copy.test.ts` now
   *                bans "สวิง" too.
   *   "จุดกลับตัว" is already spoken for: `ZONE_MODE_COPY.structural` uses it to
   *                say where the FRAME's edges come from. Borrowing it here
   *                would repeat the exact collision the first bullet describes,
   *                one word over.
   *
   * What is left is the plainest true description — the high, or the low, that
   * price has now closed past. Direction comes from `reasonIds`, i.e. from the
   * engine's own `breakoutDirection()` answer as published on the sibling row;
   * see the field's note above for why it cannot be recomputed here. When the
   * sibling is absent the sentence simply does not name a side, because a
   * guessed direction is worse than an unspecified one.
   */
  'structure-volume-unconfirmed': ({ metrics, reasonIds }) => {
    const seen = metrics.relativeVolume20 === null ? 'ยังไม่ถึง' : `อยู่ที่ ${n(metrics.relativeVolume20, 2)} เท่า ยังไม่ถึง`;
    const passed = reasonIds.includes('structure-breakout') ? 'ราคาปิดผ่านจุดสูงเดิมแล้ว'
      : reasonIds.includes('structure-breakdown') ? 'ราคาปิดผ่านจุดต่ำเดิมแล้ว'
      : 'ราคาปิดผ่านจุดเดิมแล้ว';
    return `${passed} แต่ปริมาณซื้อขาย${seen} ${T.volume.relativeVolumeConfirmation} เท่าของค่าเฉลี่ย — การผ่านที่ไม่มีคนตามมักอยู่ได้ไม่นาน`;
  },
};

function divergenceCopy(direction: 'bullish' | 'bearish', { gate, flags, metrics }: ReasonContext): string {
  const head = direction === 'bullish'
    ? 'ราคาทำจุดต่ำใหม่ แต่แรงขายไม่ได้แรงขึ้นตาม — เป็นสัญญาณว่าฝั่งขายเริ่มหมดแรง'
    : 'ราคาทำจุดสูงใหม่ แต่แรงซื้อไม่ได้แรงขึ้นตาม — เป็นสัญญาณว่าฝั่งซื้อเริ่มหมดแรง';
  // The engine weights a divergence down when RSI sits mid-range, and withholds
  // the chip on exactly that condition. Gate on and chip absent IS that case.
  const weightedDown = gate !== null && !flags.includes(`${direction}_divergence`);
  if (!weightedDown) return head;
  const where = metrics.rsi14 === null ? '' : ` (${n(metrics.rsi14)})`;
  return `${head}. แต่ RSI ยังอยู่กลาง ๆ${where} ระบบจึงให้น้ำหนักต่ำ`;
}

/**
 * One reason, in the card's words where there are any and the engine's
 * otherwise.
 *
 * The fallback is the whole contract. An id with no entry, or an entry whose
 * inputs are missing from this payload, renders the engine's own sentence —
 * jargon and all — because a row that says nothing is worse than a row that
 * says something in the wrong register. There is no path here that returns an
 * empty string.
 */
export function reasonText(reason: MarketSignalReason, base: ReasonBaseContext): string {
  const written = REASON_COPY[reason.id]?.({ ...base, polarity: reason.polarity }) ?? null;
  return written !== null && written.trim() !== '' ? written : reason.text;
}

/**
 * The context every entry reads from, gathered once per render.
 *
 * Polarity is deliberately NOT in here: it belongs to the individual reason and
 * `reasonText` folds it in, so a caller cannot pass one reason's polarity while
 * rendering another's.
 */
export function reasonContextFor(result: MarketSignalResult): ReasonBaseContext {
  return {
    metrics: result.metrics,
    gate: result.gate ?? null,
    zones: result.zones ?? null,
    actionable: result.actionable ?? null,
    flags: result.flags,
    reasonIds: result.reasons.map((reason) => reason.id),
    timeframe: result.timeframe,
  };
}

/**
 * Every id `calculations.ts` can attach to a reason.
 *
 * Mirrored by hand from the engine, and checked two ways by
 * `reason-copy.test.ts`: every id the golden corpus actually emits must be in
 * this list, and every id in this list must either have an entry above or be
 * named in `REASON_IDS_WITHOUT_COPY`. The corpus check alone would not be
 * enough — it only sees the branches those ten instruments happen to take — and
 * the list alone would not be enough, because a new id added to the engine
 * would not appear in it. Together they close both directions.
 */
export const ENGINE_REASON_IDS = [
  'ema-structure', 'ema20-slope', 'ema50-slope', 'ema200-slope',
  'rsi14', 'rsi-extreme', 'macd-signal', 'macd-histogram', 'adx-dmi',
  'relative-volume', 'obv-trend', 'swing-structure',
  'structure-breakout', 'structure-breakdown',
  'squeeze-on', 'overextended', 'bullish-divergence', 'bearish-divergence',
  'component-conflict', 'earnings-proximity', 'pending-zone-break',
  'narrow-range-band', 'invalidation-from-band', 'no-defensible-target',
  'structure-volume-unconfirmed',
] as const;

/**
 * The ids that keep the engine's words on purpose, each with the reason why.
 *
 * This list is not a backlog of things nobody got to. Anything on it is here
 * because translating it would DROP something the reader is shown today, and
 * the test treats an id that quietly disappears from the table without landing
 * here as a failure.
 *
 * EMPTY IS A STATE, NOT A DELETION. `macd-histogram` was the only entry and it
 * left by being fixed rather than by being excused: the clause it could not say
 * is `metrics.histogramExpanding` now. The table stays because the rule it
 * carries has not changed — the next id that cannot be said from the payload
 * has to be written down here, with its reason, rather than quietly omitted.
 */
export const REASON_IDS_WITHOUT_COPY: Record<string, string> = {};
