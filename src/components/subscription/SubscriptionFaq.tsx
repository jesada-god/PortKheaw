import { ChevronDown } from 'lucide-react';
import { TRIAL_DURATION_DAYS } from '@/src/lib/subscription/trial';

/**
 * Built on `<details>` rather than a disclosure widget in React: the answers are
 * static text, so the browser's own semantics and keyboard behaviour are both
 * correct and free, and the section has no client bundle and no hydration.
 */
/**
 * Two of these answers describe the **trial**, and both used to describe it in
 * words that read as promises about the whole product: that no card is needed
 * because "payment is not open yet", and that nothing renews automatically.
 * Both were true only while this deployment had no provider configured, and both
 * became false — on the same page as a working Subscribe button — the moment one
 * was. The second is the dangerous one: it told a paying subscriber they would
 * not be charged again.
 *
 * So the trial answers now say *trial*, and the sentence about billing being
 * closed is only printed when billing is actually closed.
 */
function faqEntries(billingEnabled: boolean) {
  return [
    {
      question: 'ทดลอง Elite ได้กี่ครั้ง',
      answer: `สิทธิ์ทดลองใช้ได้ครั้งเดียวต่อบัญชี เมื่อกดเริ่มแล้วจะนับ ${TRIAL_DURATION_DAYS} วันทันที และเริ่มใหม่อีกรอบไม่ได้`,
    },
    {
      question: 'ทำไมต้องยืนยันอีเมลก่อน',
      answer: 'การยืนยันอีเมลช่วยให้แน่ใจว่าบัญชีเป็นของคุณจริง และทำให้สิทธิ์ทดลองหนึ่งครั้งผูกกับหนึ่งบัญชีได้อย่างถูกต้อง',
    },
    {
      question: 'ทดลอง Elite ต้องผูกบัตรหรือจ่ายเงินไหม',
      answer: billingEnabled
        ? 'ช่วงทดลอง Elite ไม่ต้องใช้บัตรและไม่ต้องกรอกข้อมูลการชำระเงินใด ๆ ส่วนการสมัครแพ็กเกจแบบเสียเงินจะชำระผ่านหน้าชำระเงินที่ปลอดภัยของผู้ให้บริการ'
        : 'ไม่ต้องใช้บัตรและไม่ต้องกรอกข้อมูลการชำระเงินใด ๆ ระบบชำระเงินจริงยังไม่เปิดใช้งานในตอนนี้',
    },
    {
      question: 'หมดช่วงทดลองแล้วจะถูกหักเงินอัตโนมัติหรือไม่',
      answer: billingEnabled
        ? 'ช่วงทดลองไม่มีการหักเงินและไม่ต่ออายุอัตโนมัติ เมื่อครบกำหนดระบบจะกลับไปที่ Basic ให้เอง ส่วนแพ็กเกจแบบเสียเงินจะต่ออายุอัตโนมัติทุกรอบบิลจนกว่าคุณจะกดยกเลิก'
        : 'ไม่มีการหักเงินและไม่มีการต่ออายุอัตโนมัติ เมื่อครบกำหนดระบบจะกลับไปที่ Basic ให้เอง',
    },
    {
      question: 'หมดช่วงทดลองแล้วข้อมูลจะหายไหม',
      answer: 'ไม่หาย พอร์ต รายการใน Transaction Ledger และเป้าหมายทั้งหมดยังอยู่ครบและเปิดดูได้ตามปกติ',
    },
    {
      question: 'พอร์ตที่เกินสิทธิ์ Basic จะเป็นอย่างไร',
      answer: 'ยังเปิดดูย้อนหลังได้ทั้งหมด แต่จะแก้ไข เพิ่มรายการ หรือโอนเงินสดไม่ได้จนกว่าจะอัปเกรด หากต้องการจัดระเบียบสามารถ Archive พอร์ตที่ยังไม่ใช้ไว้ก่อนได้ โดยข้อมูลยังอยู่ครบ',
    },
  ];
}

export function SubscriptionFaq({ billingEnabled = false }: { billingEnabled?: boolean }) {
  const FAQ = faqEntries(billingEnabled);

  return (
    <section aria-labelledby="faq-heading" className="space-y-4">
      <h2 id="faq-heading" className="text-xl font-bold text-[var(--text)]">คำถามที่พบบ่อย</h2>
      <div className="divide-y divide-[var(--border)] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        {FAQ.map((item) => (
          <details key={item.question} className="group min-w-0">
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-[var(--text)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]">
              <span className="min-w-0">{item.question}</span>
              <ChevronDown
                aria-hidden="true"
                size={18}
                className="shrink-0 text-[var(--text-muted)] transition-transform duration-200 group-open:rotate-180"
              />
            </summary>
            <p className="px-4 pb-4 text-sm leading-relaxed text-[var(--text-secondary)]">{item.answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
