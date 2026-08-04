import Link from 'next/link';
import { billingPlans, formatBillingBaht } from '@/src/lib/billing/billing-plans';

/**
 * The questions that would otherwise become tickets.
 *
 * Every answer that touches money either states the number from the catalogue or
 * sends the reader to the policy page that does — no price is typed here, so the
 * FAQ cannot go stale when a price changes.
 *
 * `<details>` rather than a JavaScript accordion: it opens without hydration,
 * survives a failed bundle, and is searchable by the browser's own find.
 */
const FAQ: readonly { question: string; answer: React.ReactNode }[] = [
  {
    question: 'ทดลอง Elite ฟรีได้อย่างไร',
    answer: (
      <>
        บัญชีที่ยืนยันอีเมลแล้วกดเริ่มทดลอง Elite ฟรี 7 วันได้จากหน้า{' '}
        <FaqLink href="/settings/subscription">แพ็กเกจของคุณ</FaqLink> โดยไม่ต้องผูกบัตร
        ใช้สิทธิ์ได้หนึ่งครั้งต่อหนึ่งบัญชี และเมื่อครบ 7 วันจะกลับไปใช้ Basic เองโดยไม่มีการเรียกเก็บเงิน
      </>
    ),
  },
  {
    question: 'ส่วนลด Founder’s Club ใช้ได้กี่ครั้ง',
    answer: (
      <>
        ใช้ได้กับใบแจ้งหนี้รอบแรกของแพ็กเกจรายปีที่เข้าเงื่อนไขเพียงรอบเดียวต่อหนึ่งบัญชี
        เมื่อต่ออายุปีถัดไปจะคิดราคาปกติเต็มจำนวน เช่น Elite รายปี Founder รอบแรก{' '}
        {formatBillingBaht(billingPlans.elite_annual_founder.firstPeriodBaht)} บาท และรอบต่ออายุ{' '}
        {formatBillingBaht(billingPlans.elite_annual.renewalBaht)} บาท ดูรายละเอียดได้ที่{' '}
        <FaqLink href="/subscription-policy">นโยบายแพ็กเกจและการต่ออายุ</FaqLink>
      </>
    ),
  },
  {
    question: 'จ่ายด้วยบัตรกับ PromptPay ต่างกันอย่างไร',
    answer: (
      <>
        บัตรเครดิต/เดบิตและ Apple Pay จะต่ออายุอัตโนมัติทุกรอบจนกว่าคุณจะยกเลิก
        ส่วน PromptPay ไม่มีการตัดเงินอัตโนมัติ คุณต้องสแกนจ่ายใหม่ทุกครั้งที่ครบรอบ
        และเราจะแจ้งเตือนล่วงหน้า 7 วัน 3 วัน และ 1 วันก่อนหมดอายุ
      </>
    ),
  },
  {
    question: 'ยกเลิกแพ็กเกจแล้วใช้ได้ถึงเมื่อไร',
    answer: (
      <>
        ใช้ได้จนถึงวันสิ้นสุดรอบที่ชำระไว้ ระบบจะแจ้งวันสิ้นสุดที่แน่นอนให้ในการแจ้งเตือนเมื่อยกเลิก
        หลังจากนั้นบัญชีจะกลับไปใช้ Basic
      </>
    ),
  },
  {
    question: 'ลดระดับแพ็กเกจแล้วข้อมูลพอร์ตหายไหม',
    answer: (
      <>
        ไม่หาย ข้อมูลพอร์ต รายการติดตาม การแจ้งเตือน และผลการจำลองยังอยู่ครบ
        แต่ฟีเจอร์เฉพาะแพ็กเกจแบบชำระเงินจะกลับไปอยู่ในสถานะอ่านอย่างเดียวหรือถูกปิดตามสิทธิ์ Basic
        เมื่อกลับมาสมัครใหม่ ข้อมูลเดิมจะใช้งานได้ทันที
      </>
    ),
  },
  {
    question: 'ขอคืนเงินอย่างไร',
    answer: (
      <>
        ส่งคำขอได้จากหน้า <FaqLink href="/settings/refunds">คำขอคืนเงิน</FaqLink> โดยเลือกรายการชำระเงินที่ต้องการ
        การส่งคำขอและการอนุมัติยังไม่ใช่การคืนเงิน และไม่ตัดสิทธิ์การใช้งานของคุณทันที
        เงื่อนไขทั้งหมดอยู่ที่ <FaqLink href="/refund-policy">นโยบายการคืนเงิน</FaqLink>
      </>
    ),
  },
  {
    question: 'ราคาที่เห็นเป็นราคาเรียลไทม์ไหม',
    answer: (
      <>
        ข้อมูลบางส่วนเป็นข้อมูลล่าช้า ไม่ใช่เรียลไทม์ทั้งหมด เราแสดงที่มาและเวลาของข้อมูลไว้ข้างตัวเลขเสมอ
        โปรดอ่าน <FaqLink href="/investment-disclaimer">คำเตือนเรื่องการลงทุน</FaqLink> ก่อนใช้ประกอบการตัดสินใจ
      </>
    ),
  },
  {
    question: 'PortKheaw แนะนำหุ้นให้ซื้อขายได้ไหม',
    answer: (
      <>
        ไม่ได้ PortKheaw เป็นเครื่องมือวิเคราะห์และติดตามการลงทุน ไม่ใช่บริษัทหลักทรัพย์หรือนายหน้า
        และไม่ให้คำแนะนำการลงทุนเฉพาะเจาะจงรายบุคคล ตัวเลขและสัญญาณทั้งหมดเป็นผลจากการคำนวณตามสมมติฐานที่ระบุไว้
      </>
    ),
  },
];

function FaqLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="font-medium text-[var(--accent)] underline underline-offset-4 hover:text-[var(--accent-hover)]"
    >
      {children}
    </Link>
  );
}

export function SupportFaq() {
  return (
    <section className="min-w-0 space-y-3">
      <h2 className="text-base font-semibold text-[var(--text)]">คำถามที่พบบ่อย</h2>
      <div className="min-w-0 divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow)]">
        {FAQ.map((item) => (
          <details key={item.question} className="group min-w-0">
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]">
              <span className="min-w-0">{item.question}</span>
              <span
                aria-hidden="true"
                className="shrink-0 text-[var(--text-muted)] transition-transform group-open:rotate-45"
              >
                +
              </span>
            </summary>
            <div className="px-4 pb-4 text-sm leading-7 text-[var(--text-muted)]">{item.answer}</div>
          </details>
        ))}
      </div>
    </section>
  );
}
