import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { billingPlans, formatBillingBaht } from '@/src/lib/billing/billing-plans';
import {
  SUPPORT_CONTACTS,
  legalDocumentSlugs,
  legalDocuments,
  legalLinkOrder,
  legalLinks,
} from './documents';

/**
 * The trust pages, as a contract.
 *
 * Every claim asserted here is one a reader could be materially misled by if it
 * were edited away: what a plan costs, that the Founder discount is one invoice
 * only, that a card renews itself and PromptPay does not, that a downgrade keeps
 * their data, and that this product is not a broker.
 *
 * The tests read the *copy*, so they fail if the sentence disappears — not just
 * if a flag is flipped.
 */

function allText(slug: (typeof legalDocumentSlugs)[number]): string {
  const document = legalDocuments[slug];
  const parts: string[] = [document.title, document.subtitle, document.intro];
  for (const section of document.sections) {
    parts.push(section.heading);
    for (const block of section.blocks) {
      switch (block.kind) {
        case 'paragraph':
        case 'callout':
          parts.push(block.text);
          break;
        case 'list':
          parts.push(...block.items);
          break;
        case 'definitions':
          parts.push(...block.items.map((item) => `${item.term} ${item.description}`));
          break;
        case 'table':
          parts.push(...block.columns, ...block.rows.flat());
          break;
        default:
          break;
      }
    }
  }
  return parts.join('\n');
}

const EVERY_DOCUMENT = legalDocumentSlugs.map((slug) => allText(slug)).join('\n');

describe('the documents exist and are routable', () => {
  it('has a route file for every slug', () => {
    for (const slug of legalDocumentSlugs) {
      const path = resolve(process.cwd(), 'app', slug, 'page.tsx');
      expect(() => readFileSync(path, 'utf8')).not.toThrow();
    }
  });

  it('links to itself at the href it is served from', () => {
    for (const slug of legalDocumentSlugs) {
      expect(legalDocuments[slug].href).toBe(`/${slug}`);
    }
  });

  it('lists every document in the shared link row, once', () => {
    const links = legalLinks();
    expect(links).toHaveLength(legalDocumentSlugs.length);
    expect(new Set(links.map((link) => link.href)).size).toBe(links.length);
    expect(legalLinkOrder).toHaveLength(legalDocumentSlugs.length);
  });

  it('states one effective date across every document', () => {
    const dates = new Set(legalDocumentSlugs.map((slug) => legalDocuments[slug].effectiveDate));
    expect(dates.size).toBe(1);
  });
});

describe('prices are read from the catalogue, not typed', () => {
  it('states every plan’s first-period and renewal price', () => {
    const terms = allText('terms');
    for (const plan of Object.values(billingPlans)) {
      expect(terms).toContain(plan.name);
      expect(terms).toContain(formatBillingBaht(plan.firstPeriodBaht));
    }
  });

  it('shows a Founder plan’s full renewal price beside its discounted first bill', () => {
    const policy = allText('subscription-policy');
    const founder = billingPlans.elite_annual_founder;
    const renewsInto = billingPlans[founder.renewsIntoKey];
    expect(policy).toContain(formatBillingBaht(founder.firstPeriodBaht));
    expect(policy).toContain(formatBillingBaht(renewsInto.renewalBaht));
    expect(founder.firstPeriodBaht).toBeLessThan(renewsInto.renewalBaht);
  });
});

describe('the claims a reader could be misled by', () => {
  it('says the Founder discount applies to the first eligible annual bill only', () => {
    for (const slug of ['terms', 'subscription-policy'] as const) {
      const text = allText(slug);
      expect(text).toContain('รอบแรก');
      expect(text).toContain('เพียงรอบเดียว');
      expect(text).toContain('ราคาปกติ');
    }
  });

  it('says a card and Apple Pay renew automatically', () => {
    for (const slug of ['terms', 'subscription-policy'] as const) {
      const text = allText(slug);
      expect(text).toContain('Apple Pay');
      expect(text).toContain('ต่ออายุอัตโนมัติ');
    }
  });

  it('says PromptPay must be paid again each period', () => {
    for (const slug of ['terms', 'subscription-policy'] as const) {
      const text = allText(slug);
      expect(text).toContain('PromptPay');
      expect(text).toContain('ไม่มีการตัดเงินอัตโนมัติ');
    }
  });

  it('describes cancellation and the refund process', () => {
    expect(allText('subscription-policy')).toContain('ยกเลิก');
    const refund = allText('refund-policy');
    expect(refund).toContain('คำขอคืนเงิน');
    // The sentence that stops "approved" being read as "money is back".
    expect(refund).toContain('ยังไม่ใช่การคืนเงิน');
  });

  it('says a downgrade keeps the reader’s data', () => {
    for (const slug of ['terms', 'refund-policy', 'subscription-policy'] as const) {
      expect(allText(slug)).toContain('ยังคงอยู่ครบ');
    }
  });

  it('says this is an analysis tool and not a broker or personal advice', () => {
    for (const slug of ['terms', 'investment-disclaimer'] as const) {
      const text = allText(slug);
      expect(text).toContain('ไม่ใช่บริษัทหลักทรัพย์');
      expect(text).toContain('นายหน้า');
      expect(text).toContain('ไม่ได้ให้คำแนะนำการลงทุนที่เฉพาะเจาะจงรายบุคคล');
    }
  });
});

describe('what the copy must not do', () => {
  it('invents no uptime, approval-rate or licensing claim', () => {
    // Each of these would be a promise the product cannot keep, and two of them
    // would be a promise about somebody else's system. Guarantee *wording* is
    // handled by the negation test below — these are claims with no honest
    // negated form.
    expect(EVERY_DOCUMENT).not.toContain('คืนเงินทุกกรณี');
    expect(EVERY_DOCUMENT).not.toContain('99.9');
    expect(EVERY_DOCUMENT).not.toContain('ได้รับใบอนุญาตจาก');
    expect(EVERY_DOCUMENT).not.toContain('ตลอด 24 ชั่วโมงทุกวัน');
  });

  it('only ever mentions a guarantee in order to disclaim it', () => {
    /*
     * The word appears legitimately — "we cannot guarantee accuracy" is a
     * disclaimer, not a promise. So rather than banning the word, every
     * occurrence must sit inside a negation. A future edit that drops the
     * "ไม่สามารถ" and leaves a bare guarantee fails here.
     */
    const occurrences = [...EVERY_DOCUMENT.matchAll(/รับประกัน/g)];
    expect(occurrences.length).toBeGreaterThan(0);
    for (const match of occurrences) {
      const lead = EVERY_DOCUMENT.slice(Math.max(0, match.index - 24), match.index);
      expect(lead).toMatch(/ไม่|มิได้/);
    }
  });

  it('says plainly that refunds are judged case by case', () => {
    expect(allText('refund-policy')).toContain('เป็นรายกรณี');
  });

  it('discloses no credential handling it does not do', () => {
    expect(allText('privacy')).toContain('เราไม่เก็บเลขบัตร');
  });
});

describe('support contacts', () => {
  it('names the two fallback channels exactly once, from one source', () => {
    expect(SUPPORT_CONTACTS.facebook.value).toBe('Jesada Tawinteung');
    expect(SUPPORT_CONTACTS.line.value).toBe('0620843259');
  });

  it('is what the support card renders', () => {
    const card = readFileSync(
      resolve(process.cwd(), 'src/components/support/SupportContactCard.tsx'),
      'utf8',
    );
    expect(card).toContain('SUPPORT_CONTACTS.facebook.value');
    expect(card).toContain('SUPPORT_CONTACTS.line.value');
    // Never typed into the markup, so the two can never disagree.
    expect(card).not.toContain('0620843259');
  });
});
