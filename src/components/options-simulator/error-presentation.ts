/**
 * One place that turns an internal failure into something a beginner can act on.
 *
 * The engines, the schemas and the API all speak their own language — "expectedPnL
 * must be greater than 0", "Options chain response ไม่ผ่าน schema validation",
 * "A finite positive starting spot is required". Those strings are correct and
 * they must keep their exact wording, because logs, tests and audits match on
 * them. They were simply being printed straight into the page.
 *
 * Nothing here changes an engine, a code or a threshold. Every function takes the
 * internal text, keeps it verbatim in `detail` for logging, and returns the Thai
 * heading and sentence a reader sees. Anything unrecognised falls through to a
 * safe Thai message rather than leaking English or a variable name.
 */

export interface PresentedError {
  /** Short Thai heading: what did not happen. */
  title: string;
  /** One or two Thai sentences: why, and what the reader can do. */
  message: string;
  /** The untouched internal text. For logs and debugging only — never rendered raw. */
  detail: string;
}

const FALLBACK = {
  title: 'ทำรายการนี้ไม่สำเร็จ',
  message: 'ระบบทำรายการนี้ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง หากยังไม่ได้ ให้ตรวจสอบข้อมูลที่กรอกแล้วลองใหม่',
} as const;

interface Rule { match: RegExp; title: string; message: string }

/*
  Ordered: the first rule that matches wins, so the specific gate reasons are
  listed before the broad "could not be calculated" catches.
*/
const RULES: readonly Rule[] = [
  {
    match: /ข้อมูลสำหรับจำลองมีค่าที่ไม่ใช่ตัวเลข/i,
    title: 'ข้อมูลจำลองไม่ถูกต้อง',
    message: 'ข้อมูลสำหรับจำลองมีค่าที่ไม่ใช่ตัวเลข กรุณาตรวจสอบราคา IV จำนวนรอบ และสมมติฐาน',
  },
  {
    match: /จำนวนรอบ ค่าเริ่มสุ่ม หรือสมมติฐานของชุดจำลองไม่ตรงกัน/i,
    title: 'ตั้งค่าชุดจำลองไม่ตรงกัน',
    message: 'จำนวนรอบ ค่าเริ่มสุ่ม หรือสมมติฐานของชุดจำลองไม่ตรงกัน กรุณาตรวจสอบแล้วลองใหม่',
  },
  {
    match: /ระบบจำลองความเป็นไปได้ไม่สำเร็จ/i,
    title: 'จำลองความเป็นไปได้ไม่สำเร็จ',
    message: 'ระบบจำลองความเป็นไปได้ไม่สำเร็จ กรุณาตรวจสอบข้อมูลที่กรอกแล้วลองใหม่',
  },
  {
    match: /ข้อมูลสำหรับคำนวณราคาไม่ครบหรือไม่ใช่ตัวเลข/i,
    title: 'ข้อมูลคำนวณไม่ครบ',
    message: 'ข้อมูลสำหรับคำนวณราคาไม่ครบหรือไม่ใช่ตัวเลข กรุณาตรวจสอบราคาหุ้น ราคาใช้สิทธิ ค่า IV และวันที่',
  },
  {
    match: /สมมติฐาน IV ดอกเบี้ย หรือเงินปันผล/i,
    title: 'สมมติฐานราคาใช้คำนวณไม่ได้',
    message: 'สมมติฐาน IV ดอกเบี้ย หรือเงินปันผลชุดนี้ไม่สามารถใช้คำนวณราคาได้ กรุณาตรวจสอบค่าที่กรอก',
  },
  {
    match: /ระบบคำนวณราคาไม่สำเร็จ/i,
    title: 'คำนวณราคาไม่สำเร็จ',
    message: 'ระบบคำนวณราคาไม่สำเร็จ กรุณาตรวจสอบข้อมูลที่กรอกแล้วลองใหม่',
  },
  {
    match: /ข้อมูลที่ส่งมามีขนาดใหญ่เกินกำหนด/i,
    title: 'ข้อมูลมีขนาดใหญ่เกินกำหนด',
    message: 'ข้อมูลที่ส่งมามีขนาดใหญ่เกินกำหนด กรุณาลดจำนวนสัญญาแล้วลองใหม่',
  },
  {
    match: /expectedPnL must be greater than 0|EVR must be greater than 0/i,
    title: 'ยังไม่ผ่านเกณฑ์ความได้เปรียบ',
    message: 'ระบบยังไม่พบความได้เปรียบของกลยุทธ์นี้ กำไรที่คาดหวังและอัตราผลตอบแทนที่คาดหวังต้องมากกว่า 0',
  },
  {
    match: /commonValidPaths must be at least/i,
    title: 'ผลจำลองยังน้อยเกินไป',
    message: 'จำนวนรอบจำลองที่ใช้ได้ยังน้อยเกินกว่าจะสรุปผล ลองเพิ่มจำนวนรอบจำลองแล้วคำนวณใหม่',
  },
  {
    match: /confidence must be at least/i,
    title: 'ความน่าเชื่อถือของข้อมูลยังต่ำ',
    message: 'ข้อมูลที่ใช้ยังไม่นิ่งพอจะสรุปผล ลองตรวจราคาสัญญาและความผันผวนที่กรอกไว้อีกครั้ง',
  },
  {
    match: /maxLoss|risk-capital/i,
    title: 'ยังคำนวณขอบเขตขาดทุนไม่ได้',
    message: 'ระบบยังหาขาดทุนสูงสุดของสถานะนี้ไม่ได้ จึงยังเทียบผลตอบแทนกับความเสี่ยงไม่ได้ ลองตรวจจำนวนสัญญาและราคาที่กรอกไว้',
  },
  {
    match: /No common valid path/i,
    title: 'ยังเปรียบเทียบผลไม่ได้',
    message: 'รอบจำลองของสองฝั่งยังไม่ตรงกันพอจะเทียบกันได้ กรุณาคำนวณใหม่อีกครั้ง',
  },
  {
    match: /ProfitFactor is unavailable/i,
    title: 'ยังเทียบกำไรกับขาดทุนไม่ได้',
    message: 'ผลจำลองรอบนี้ไม่มีทั้งกำไรและขาดทุนให้เทียบกัน ลองปรับราคาเป้าหมายหรือวันเป้าหมายแล้วคำนวณใหม่',
  },
  {
    match: /valid target date and target price/i,
    title: 'ยังกรอกเป้าหมายไม่ครบ',
    message: 'กรุณาระบุราคาเป้าหมายและวันที่ต้องการดูผลก่อน แล้วจึงจำลองอีกครั้ง',
  },
  {
    match: /starting spot/i,
    title: 'ยังไม่มีราคาหุ้นตั้งต้น',
    message: 'ระบบยังไม่มีราคาหุ้นปัจจุบันสำหรับเริ่มคำนวณ กรุณาเลือกหุ้นใหม่หรือกรอกราคาหุ้นปัจจุบันเอง',
  },
  {
    match: /Scenario score audit failed|Path set seed|does not match the comparison assumptions/i,
    title: 'ผลจำลองยังตรวจสอบไม่ผ่าน',
    message: 'ระบบตรวจแล้วพบว่าผลรอบนี้ยังไม่สอดคล้องกัน จึงไม่แสดงคะแนน กรุณาคำนวณใหม่อีกครั้ง',
  },
  {
    match: /สัญญาที่เลือกหมดอายุแล้ว/i,
    title: 'นำเข้าสัญญาไม่สำเร็จ',
    message: 'สัญญาที่เลือกหมดอายุไปแล้ว กรุณากลับไปเลือกวันหมดอายุถัดไปจากหน้าออปชัน',
  },
  {
    match: /schema validation|ไม่ผ่าน schema|contract identity|chain snapshot/i,
    title: 'นำเข้าสัญญาไม่สำเร็จ',
    message: 'ข้อมูลสัญญาที่ได้รับกลับมาไม่ตรงกับที่เลือกไว้ กรุณาเลือกสัญญาจากหน้าออปชันอีกครั้ง',
  },
  {
    match: /นำเข้าสัญญาไม่ได้|options\/chain/i,
    title: 'นำเข้าสัญญาไม่สำเร็จ',
    message: 'ระบบดึงข้อมูลสัญญาจากผู้ให้บริการไม่สำเร็จ กรุณาลองใหม่อีกครั้งในอีกสักครู่',
  },
  {
    match: /Simulation failed|Monte Carlo/i,
    title: 'จำลองไม่สำเร็จ',
    message: 'ระบบจำลองผลไม่สำเร็จ กรุณาลองกดจำลองใหม่อีกครั้ง',
  },
] as const;

/** Thai heading and sentence for one internal failure message. */
export function presentError(detail: unknown): PresentedError {
  const text = detail instanceof Error ? detail.message : typeof detail === 'string' ? detail : '';
  const rule = RULES.find((candidate) => candidate.match.test(text));
  return rule
    ? { title: rule.title, message: rule.message, detail: text }
    : { ...FALLBACK, detail: text };
}

/**
 * The positive-edge gate reports every failing condition at once. Readers get one
 * heading and the distinct sentences behind it, never the joined raw list.
 */
export function presentEdgeGate(reasons: readonly string[]): PresentedError {
  const detail = reasons.join('; ');
  if (reasons.length === 0) return { ...FALLBACK, detail };
  const presented = reasons.map((reason) => presentError(reason));
  const messages = [...new Set(presented.map((item) => item.message))];
  return { title: presented[0].title, message: messages.join(' '), detail };
}

/** A one-line Thai explanation for a score or result the engine could not produce. */
export function presentUnavailableReason(reason: unknown, fallback: string = FALLBACK.message): string {
  const text = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
  if (!text.trim()) return fallback;
  const rule = RULES.find((candidate) => candidate.match.test(text));
  return rule ? rule.message : fallback;
}
