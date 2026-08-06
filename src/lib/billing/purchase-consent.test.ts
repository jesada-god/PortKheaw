import { describe, expect, it } from 'vitest';
import {
  PURCHASE_CONSENT_LABEL,
  PURCHASE_CONSENT_POLICY_SLUGS,
  currentPurchasePolicyVersions,
  purchaseCommitmentNotes,
  purchaseConsentLinks,
  purchaseDisclosureRows,
  verifyPurchaseConsent,
} from './purchase-consent';
import { REFUND_WINDOW_DAYS } from './refund-window';
import { billingPlans, formatBillingBaht } from './billing-plans';
import { legalDocuments } from '@/src/lib/legal/documents';

/**
 * The consent rule, and the sentences it is given with.
 *
 * The verdict function is where a defect would let somebody be charged without
 * having agreed, so it is tested exhaustively rather than by example — including
 * the shapes a crafted request would actually take.
 */

const CURRENT = currentPurchasePolicyVersions();

const VALID = {
  accepted: true,
  subscriptionPolicyVersion: CURRENT.subscriptionPolicy,
  refundPolicyVersion: CURRENT.refundPolicy,
};

describe('what counts as an acceptance', () => {
  it('accepts a ticked box pinned to the versions this build publishes', () => {
    expect(verifyPurchaseConsent(VALID, CURRENT)).toBe('accepted');
  });

  it('refuses an unticked box, however well-formed the rest is', () => {
    expect(verifyPurchaseConsent({ ...VALID, accepted: false }, CURRENT)).toBe('not-accepted');
    // Truthy is not `true`. A string, a number or a missing field is not consent.
    for (const accepted of ['true', 1, undefined, null] as unknown[]) {
      expect(verifyPurchaseConsent({ ...VALID, accepted } as never, CURRENT)).toBe('not-accepted');
    }
  });

  /*
   * The stale case. A tab left open across a policy edit has agreed to wording
   * nobody is showing any more, so it is refused and told to re-read rather than
   * quietly treated as agreement to the new text.
   */
  it('refuses an acceptance pinned to superseded wording', () => {
    expect(verifyPurchaseConsent({ ...VALID, subscriptionPolicyVersion: '2026-01-01' }, CURRENT))
      .toBe('stale-policy');
    expect(verifyPurchaseConsent({ ...VALID, refundPolicyVersion: '2026-01-01' }, CURRENT))
      .toBe('stale-policy');
    // Including a version that was never published at all.
    expect(verifyPurchaseConsent({ ...VALID, refundPolicyVersion: '9999-99-99' }, CURRENT))
      .toBe('stale-policy');
  });

  it('refuses anything that is not a consent claim', () => {
    for (const claim of [null, undefined, 'accepted', 42, []] as unknown[]) {
      expect(verifyPurchaseConsent(claim as never, CURRENT)).toBe('malformed');
    }
    // A ticked box with no versions is not pinned to anything.
    expect(verifyPurchaseConsent({ accepted: true } as never, CURRENT)).toBe('malformed');
    expect(verifyPurchaseConsent(
      { accepted: true, subscriptionPolicyVersion: 1, refundPolicyVersion: 2 } as never,
      CURRENT,
    )).toBe('malformed');
  });

  /*
   * Order matters: somebody who simply has not ticked the box is told to tick
   * it. Only somebody who *has* agreed is told their agreement was against old
   * wording, which is the only case where "go and re-read it" is the right
   * instruction.
   */
  it('reports the unticked box before the stale version', () => {
    expect(verifyPurchaseConsent(
      { accepted: false, subscriptionPolicyVersion: 'old', refundPolicyVersion: 'old' },
      CURRENT,
    )).toBe('not-accepted');
  });
});

describe('the versions come from the documents themselves', () => {
  it('reads both from the catalogue rather than restating them', () => {
    expect(CURRENT.subscriptionPolicy).toBe(legalDocuments['subscription-policy'].version);
    expect(CURRENT.refundPolicy).toBe(legalDocuments['refund-policy'].version);
    expect(CURRENT.subscriptionPolicy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('links to exactly the two documents an acceptance is pinned to', () => {
    expect(PURCHASE_CONSENT_POLICY_SLUGS).toEqual(['subscription-policy', 'refund-policy']);
    expect(purchaseConsentLinks().map((link) => link.href))
      .toEqual(['/subscription-policy', '/refund-policy']);
    expect(purchaseConsentLinks().map((link) => link.label)).toEqual([
      legalDocuments['subscription-policy'].title,
      legalDocuments['refund-policy'].title,
    ]);
  });

  it('states the window in the checkbox sentence', () => {
    expect(PURCHASE_CONSENT_LABEL).toContain(String(REFUND_WINDOW_DAYS));
    for (const required of ['สมัครสมาชิก', 'ต่ออายุ', 'ยกเลิก', 'คืนเงิน']) {
      expect(PURCHASE_CONSENT_LABEL, required).toContain(required);
    }
  });
});

describe('what a buyer is shown before confirming', () => {
  it('names the plan, the price, the cadence and the rail', () => {
    const rows = purchaseDisclosureRows({ planKey: 'elite_monthly', paymentMethod: 'card' });
    const flat = rows.map((row) => `${row.label}: ${row.value}`).join('\n');
    expect(flat).toContain(billingPlans.elite_monthly.name);
    expect(flat).toContain(formatBillingBaht(billingPlans.elite_monthly.firstPeriodBaht));
    expect(flat).toContain('รายเดือน');
    expect(flat).toContain('บัตรเครดิต/เดบิต');
  });

  it('states a Founder plan’s renewal price beside its discounted first bill', () => {
    const rows = purchaseDisclosureRows({
      planKey: 'elite_annual_founder',
      paymentMethod: 'promptpay',
    });
    const flat = rows.map((row) => row.value).join('\n');
    expect(flat).toContain(formatBillingBaht(billingPlans.elite_annual_founder.firstPeriodBaht));
    expect(flat).toContain(formatBillingBaht(billingPlans.elite_annual.renewalBaht));
    expect(flat).toContain('PromptPay');
    expect(flat).toContain('รายปี');
  });

  /*
   * The two sentences a buyer most often discovers too late. A card keeps
   * charging until it is cancelled; PromptPay never charges again by itself.
   */
  it('states the renewal behaviour of the rail being bought', () => {
    const card = purchaseCommitmentNotes({ planKey: 'pro_monthly', paymentMethod: 'card' }).join('\n');
    expect(card).toContain('บัตรจะถูกเรียกเก็บอัตโนมัติทุกเดือน');
    expect(card).toContain('ยกเลิกได้ทุกเมื่อ');

    const qr = purchaseCommitmentNotes({ planKey: 'pro_annual', paymentMethod: 'promptpay' }).join('\n');
    expect(qr).toContain('ไม่ต่ออายุอัตโนมัติ');
    expect(qr).toContain('ต้องสแกนจ่ายใหม่ทุกปี');
    // And how long the invoice it is about to create stays payable.
    expect(qr).toContain('ใบแจ้งหนี้นี้ต้องชำระภายใน');
  });

  it('states the window, its limit and that a request is reviewed', () => {
    const notes = purchaseCommitmentNotes({ planKey: 'pro_monthly', paymentMethod: 'card' }).join('\n');
    expect(notes).toContain(`ภายใน ${REFUND_WINDOW_DAYS} วัน`);
    expect(notes).toContain('เวลาที่ชำระเงินสำเร็จ');
    expect(notes).toContain('การต่ออายุแต่ละรอบจะเริ่มนับใหม่');
    expect(notes).toContain('กฎหมายที่ใช้บังคับ');
    expect(notes).toContain('ยังไม่ใช่การคืนเงิน');
    // No promise that a request will be granted.
    expect(notes).not.toContain('จะได้รับคืนเงิน');
    expect(notes).not.toContain('รับประกัน');
  });
});
