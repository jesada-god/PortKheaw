import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SubscriptionFaq } from './SubscriptionFaq';

/**
 * The FAQ makes claims about money, and two of them were written when this
 * product had no payment provider at all:
 *
 *   * "ระบบชำระเงินจริงยังไม่เปิดใช้งานในตอนนี้" — printed on the same page as a
 *     working Subscribe button once billing was configured.
 *   * "ไม่มีการหักเงินและไม่มีการต่ออายุอัตโนมัติ" — an unqualified promise to a
 *     subscriber whose plan renews automatically every billing period.
 *
 * Neither is a cosmetic wording problem: the second one tells somebody who is
 * paying that they will not be charged again.
 */

const BILLING_CLOSED_CLAIM = 'ระบบชำระเงินจริงยังไม่เปิดใช้งานในตอนนี้';
const UNQUALIFIED_NO_RENEWAL = 'ไม่มีการหักเงินและไม่มีการต่ออายุอัตโนมัติ';

const render = (props: { billingEnabled?: boolean } = {}) =>
  renderToStaticMarkup(<SubscriptionFaq {...props} />);

/** One `<details>` per question, so this counts questions rather than prose. */
const questionCount = (markup: string) => markup.split('<details').length - 1;

describe('SubscriptionFaq', () => {
  describe('while billing is closed', () => {
    it('still says payment is not open', () => {
      expect(render({ billingEnabled: false })).toContain(BILLING_CLOSED_CLAIM);
    });

    it('defaults to the closed copy when told nothing', () => {
      expect(render()).toContain(BILLING_CLOSED_CLAIM);
    });
  });

  describe('once billing is open', () => {
    it('never claims payment is closed', () => {
      expect(render({ billingEnabled: true })).not.toContain(BILLING_CLOSED_CLAIM);
    });

    it('says a paid plan renews automatically until it is cancelled', () => {
      const markup = render({ billingEnabled: true });
      expect(markup).toContain('ต่ออายุอัตโนมัติทุกรอบบิลจนกว่าคุณจะกดยกเลิก');
      // The unqualified promise a paying subscriber must never be shown.
      expect(markup).not.toContain(UNQUALIFIED_NO_RENEWAL);
    });

    it('keeps the no-card promise scoped to the trial', () => {
      const markup = render({ billingEnabled: true });
      expect(markup).toContain('ช่วงทดลอง Elite ไม่ต้องใช้บัตร');
    });

    it('asks its card and renewal questions about the trial by name', () => {
      const markup = render({ billingEnabled: true });
      expect(markup).toContain('ทดลอง Elite ต้องผูกบัตรหรือจ่ายเงินไหม');
      expect(markup).toContain('หมดช่วงทดลองแล้วจะถูกหักเงินอัตโนมัติหรือไม่');
    });
  });

  it('answers the same questions either way, and keeps the ones that do not depend on billing', () => {
    const closed = render({ billingEnabled: false });
    const open = render({ billingEnabled: true });

    expect(questionCount(open)).toBe(questionCount(closed));
    for (const markup of [closed, open]) {
      expect(markup).toContain('พอร์ต รายการใน Transaction Ledger และเป้าหมายทั้งหมดยังอยู่ครบ');
      expect(markup).toContain('สิทธิ์ทดลองใช้ได้ครั้งเดียวต่อบัญชี');
    }
  });
});
