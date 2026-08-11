/**
 * The trust surface, as data.
 *
 * Every legal and policy page is described here rather than written as JSX, for
 * three reasons that all turned out to matter:
 *
 *   * **Prices are read, never typed.** The plan table below is generated from
 *     `billingPlans`, which is the same catalogue the checkout uses. A price can
 *     therefore never be right on the plan cards and stale on the terms page —
 *     the failure mode that turns a pricing change into a consumer-protection
 *     problem.
 *   * **The claims are testable.** A contract test asserts that the copy states
 *     the Founder rule, the two renewal behaviours and the not-a-broker
 *     disclaimer, so none of them can be edited away by accident.
 *   * **Six pages, one layout.** The renderer is written once and every document
 *     gets the same heading structure, the same reading width and the same
 *     behaviour at 320px.
 *
 * What this file deliberately does not do is invent a guarantee. There is no
 * uptime promise, no accuracy warranty, no "we will always refund within N
 * days", and no claim about regulatory status. Where the honest answer is "this
 * is decided case by case", the copy says so.
 */

import { billingPlanKeys, billingPlans, formatBillingBaht } from '@/src/lib/billing/billing-plans';
import { REFUND_WINDOW_DAYS } from '@/src/lib/billing/refund-window';
import { TRIAL_IDENTITY_RETENTION_YEARS } from '@/src/lib/trial-identity/retention';
import { TRIAL_ELIGIBILITY_STATEMENT } from '@/src/lib/subscription/trial';

/**
 * The two channels a reader who cannot sign in can still reach us on.
 *
 * The community OpenChat is first because it is the one that scales: a question
 * asked there is answered once and read by everyone who has it next. Facebook
 * stays for the things nobody should post in a room full of strangers — an
 * account or a payment. No personal phone number appears here any more; a
 * number handed to every reader is a support channel that stops working the
 * moment there is more than one of them.
 */
export interface SupportContact {
  label: string;
  value: string;
  detail: string;
  /**
   * The canonical destination, when one exists.
   *
   * Facebook has none — not in this file, not in configuration, not in the
   * environment. A profile URL guessed from a person's name is not a contact
   * channel; it is a link that may open somebody else entirely. The card
   * therefore renders this contact as the name to search for, and becomes a real
   * link the moment a verified URL is added here, with no other change.
   */
  href?: string;
}

export const SUPPORT_CONTACTS: Record<'lineOpenChat' | 'facebook', SupportContact> = {
  lineOpenChat: {
    label: 'LINE OpenChat',
    value: 'PORTKHEAW COMMUNITY',
    detail: 'พูดคุย • สอบถาม • รายงานปัญหา',
    href: 'https://line.me/ti/g2/4TUhjKzNp8vev-RVUGWApqg2CBCDRmAHBUOY1g?utm_source=invitation&utm_medium=link_copy&utm_campaign=default',
  },
  facebook: {
    label: 'Facebook',
    value: 'Jesada Tawinteung',
    detail: 'สำหรับเรื่องบัญชีและการชำระเงิน',
  },
};

export type LegalBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: readonly string[] }
  /** A definition-style row: a short label and the sentence that explains it. */
  | { kind: 'definitions'; items: readonly { term: string; description: string }[] }
  | { kind: 'table'; columns: readonly string[]; rows: readonly (readonly string[])[] }
  /** Set apart visually. Used for the things a reader must not miss. */
  | { kind: 'callout'; tone: 'info' | 'warning'; text: string };

export interface LegalSection {
  heading: string;
  blocks: readonly LegalBlock[];
}

export interface LegalDocument {
  slug: LegalDocumentSlug;
  /** The route this document is served from. */
  href: string;
  title: string;
  subtitle: string;
  /** Shown under the title. A date, not a version number readers cannot use. */
  effectiveDate: string;
  /**
   * The machine-readable vintage of this wording.
   *
   * Never shown to a reader — `effectiveDate` is what a person can use. This
   * exists so an acceptance can be *pinned*: a purchase consent records the
   * version it was given against, and the server refuses a consent claiming any
   * other. Bump it in the same edit that changes the words, and historical
   * consents keep pointing at the wording they were actually given.
   */
  version: string;
  intro: string;
  sections: readonly LegalSection[];
}

export const legalDocumentSlugs = [
  'terms',
  'privacy',
  'refund-policy',
  'subscription-policy',
  'investment-disclaimer',
] as const;
export type LegalDocumentSlug = typeof legalDocumentSlugs[number];

/**
 * The day this wording took effect. One constant, so the six pages cannot drift
 * apart and claim different vintages of the same policy.
 */
const EFFECTIVE_DATE = '6 สิงหาคม 2569';

/**
 * The same day, as the identifier a consent record stores.
 *
 * One constant for the set because the set is published together — the refund
 * window added on this date is described in the subscription policy and the
 * refund policy at once, and a purchase consent pins both. Each document carries
 * its own field rather than reading this directly, so a later edit can move one
 * of them without republishing the rest.
 */
const POLICY_VERSION = '2026-08-06';

const PRODUCT = 'PortKheaw';

/**
 * The price table, built from the catalogue.
 *
 * A Founder row states both numbers — what the first annual invoice costs and
 * what every one after it costs — because stating only the promotional price is
 * exactly the omission that makes a discount misleading.
 */
function planRows(): readonly (readonly string[])[] {
  return billingPlanKeys.map((key) => {
    const plan = billingPlans[key];
    const renewsInto = billingPlans[plan.renewsIntoKey];
    return [
      plan.name,
      plan.interval === 'year' ? 'รายปี (12 เดือน)' : 'รายเดือน (1 เดือน)',
      `${formatBillingBaht(plan.firstPeriodBaht)} บาท`,
      plan.founder
        ? `${formatBillingBaht(renewsInto.renewalBaht)} บาท (ราคาปกติ)`
        : `${formatBillingBaht(plan.renewalBaht)} บาท`,
    ];
  });
}

/** The Founder rule, stated identically wherever it appears. */
const FOUNDER_RULE =
  'ส่วนลด Founder’s Club ใช้ได้กับใบแจ้งหนี้รอบแรกของแพ็กเกจรายปีที่เข้าเงื่อนไขเพียงรอบเดียวต่อหนึ่งบัญชีเท่านั้น '
  + 'เมื่อครบรอบและมีการต่ออายุ จะคิดราคาปกติของแพ็กเกจรายปีนั้นเต็มจำนวน ไม่ใช่ราคาส่วนลดเดิม';

/** The two rails, stated identically wherever they appear. */
const RENEWAL_RULES: readonly { term: string; description: string }[] = [
  {
    term: 'บัตรเครดิต/เดบิต และ Apple Pay',
    description:
      'เป็นการชำระแบบต่ออายุอัตโนมัติ ระบบของผู้ให้บริการชำระเงินจะเรียกเก็บเงินตามรอบโดยอัตโนมัติจนกว่าคุณจะยกเลิก '
      + 'คุณยกเลิกการต่ออายุอัตโนมัติได้ทุกเมื่อจากหน้าแพ็กเกจของคุณ',
  },
  {
    term: 'PromptPay',
    description:
      'ไม่มีการตัดเงินอัตโนมัติ เพราะเป็นการสแกนจ่ายครั้งต่อครั้ง คุณต้องชำระใหม่ทุกครั้งที่ครบรอบ '
      + 'สิทธิ์การใช้งานจะเปิดตามรอบที่ชำระจริงเท่านั้น และจะสิ้นสุดเองเมื่อครบรอบหากยังไม่ได้ชำระรอบถัดไป',
  },
];

/**
 * The refund window, stated identically wherever it appears.
 *
 * Three sentences that have to travel together: how long the window is, what it
 * is measured from, and that each charge gets its own. Splitting them is how a
 * reader ends up believing one subscription has one seven-day window that
 * started the day they first subscribed.
 */
const REFUND_WINDOW_RULES: readonly { term: string; description: string }[] = [
  {
    term: `ระยะเวลา ${REFUND_WINDOW_DAYS} วัน`,
    description:
      `คุณขอคืนเงินเต็มจำนวนของรอบบิลหนึ่งได้ภายใน ${REFUND_WINDOW_DAYS} วันนับจากเวลาที่การชำระเงินของรอบนั้นสำเร็จ `
      + 'ระบบนับจากเวลาที่ผู้ให้บริการชำระเงินยืนยันว่าได้รับเงินแล้วเท่านั้น '
      + 'ไม่ได้นับจากเวลาที่คุณกดเริ่มชำระเงิน และไม่ได้นับจากเวลาบนเครื่องของคุณ',
  },
  {
    term: 'แต่ละรอบนับใหม่ของตัวเอง',
    description:
      'การชำระเงินที่สำเร็จแต่ละครั้งมีระยะเวลาขอคืนเงินเป็นของรอบนั้นเอง '
      + 'ทั้งการชำระครั้งแรก การต่ออายุอัตโนมัติด้วยบัตรหรือ Apple Pay การชำระด้วย PromptPay ในแต่ละรอบ '
      + 'และการกลับมาสมัครใหม่หลังจากยกเลิกหรือหมดอายุไปแล้ว',
  },
  {
    term: 'เมื่อพ้นกำหนด',
    description:
      `เมื่อพ้น ${REFUND_WINDOW_DAYS} วันของรอบนั้นแล้ว ระบบจะไม่รับคำขอคืนเงินตามปกติสำหรับรอบนั้น `
      + 'เว้นแต่กรณีที่กฎหมายที่ใช้บังคับกำหนดไว้เป็นอย่างอื่น เช่น การเรียกเก็บเงินผิดพลาดหรือซ้ำซ้อน '
      + 'ซึ่งคุณติดต่อทีมงานผ่านหน้าช่วยเหลือได้เสมอ',
  },
];

/** The sentence that stops "I asked" being read as "I was refunded". */
const REFUND_IS_REVIEWED =
  'การส่งคำขอคืนเงินภายในกำหนดยังไม่ใช่การคืนเงิน และไม่ใช่การอนุมัติโดยอัตโนมัติ '
  + 'ทีมงานจะตรวจสอบคำขอเป็นรายกรณีก่อนตัดสิน และการส่งคำขอไม่ตัดสิทธิ์การใช้งานของคุณในระหว่างนั้น';

/** Downgrade keeps data. Stated in every document where a downgrade is possible. */
const DATA_ON_DOWNGRADE =
  'เมื่อสิทธิ์แบบชำระเงินสิ้นสุดลง ไม่ว่าจะจากการยกเลิก การหมดรอบ หรือการคืนเงิน บัญชีจะกลับไปใช้สิทธิ์ Basic '
  + 'ข้อมูลพอร์ต รายการติดตาม การแจ้งเตือน และผลการจำลองของคุณยังคงอยู่ครบ ไม่มีการลบข้อมูลจากการลดระดับแพ็กเกจ '
  + 'แต่ฟีเจอร์ที่จำกัดเฉพาะแพ็กเกจแบบชำระเงินจะกลับไปอยู่ในสถานะอ่านอย่างเดียวหรือถูกปิดตามสิทธิ์ Basic';

/** The disclaimer, in one sentence, reused so it cannot be softened in one place. */
const NOT_ADVICE =
  `${PRODUCT} เป็นเครื่องมือวิเคราะห์และติดตามการลงทุน ไม่ใช่บริษัทหลักทรัพย์ ไม่ใช่นายหน้าซื้อขายหลักทรัพย์ `
  + 'และไม่ได้ให้คำแนะนำการลงทุนที่เฉพาะเจาะจงรายบุคคล เราไม่รับฝากเงิน ไม่ส่งคำสั่งซื้อขาย และไม่บริหารเงินลงทุนแทนคุณ';

const TERMS: LegalDocument = {
  slug: 'terms',
  href: '/terms',
  title: 'ข้อกำหนดการใช้งาน',
  subtitle: `เงื่อนไขการใช้บริการ ${PRODUCT}`,
  effectiveDate: EFFECTIVE_DATE,
  version: POLICY_VERSION,
  intro:
    `เอกสารนี้อธิบายเงื่อนไขการใช้งาน ${PRODUCT} เมื่อคุณสมัครใช้งานหรือใช้บริการต่อ `
    + 'ถือว่าคุณได้อ่านและยอมรับเงื่อนไขในหน้านี้แล้ว',
  sections: [
    {
      heading: '1. บริการนี้คืออะไร',
      blocks: [
        { kind: 'paragraph', text: NOT_ADVICE },
        {
          kind: 'paragraph',
          text:
            `${PRODUCT} ให้บริการเครื่องมือดูข้อมูลตลาด บันทึกและติดตามพอร์ตของคุณเอง วิเคราะห์เชิงเทคนิคและปัจจัยพื้นฐาน `
            + 'ตั้งการแจ้งเตือนราคา และจำลองสถานการณ์ของสัญญาออปชัน ทั้งหมดนี้เป็นข้อมูลประกอบการตัดสินใจของคุณเอง',
        },
        {
          kind: 'callout',
          tone: 'warning',
          text:
            'การตัดสินใจลงทุนทุกครั้งเป็นความรับผิดชอบของคุณเอง ผลการดำเนินงานในอดีตและผลการจำลองไม่ได้รับประกันผลตอบแทนในอนาคต',
        },
      ],
    },
    {
      heading: '2. บัญชีผู้ใช้',
      blocks: [
        {
          kind: 'list',
          items: [
            'คุณต้องให้ข้อมูลที่ถูกต้องในการสมัคร และดูแลรหัสผ่านของคุณเอง',
            'หนึ่งบัญชีมีสิทธิ์ใช้แพ็กเกจได้ครั้งละหนึ่งแพ็กเกจ',
            TRIAL_ELIGIBILITY_STATEMENT,
            'ห้ามใช้บัญชีร่วมกันหลายคน หรือใช้เครื่องมืออัตโนมัติดึงข้อมูลออกจากระบบในลักษณะที่กระทบผู้ใช้อื่น',
            'เราอาจระงับบัญชีที่ใช้งานผิดวัตถุประสงค์ ละเมิดกฎหมาย หรือมีการโต้แย้งการชำระเงินที่ยังไม่ได้ข้อยุติ',
          ],
        },
      ],
    },
    {
      heading: '3. ข้อมูลตลาดและความถูกต้อง',
      blocks: [
        {
          kind: 'paragraph',
          text:
            'ข้อมูลราคา งบการเงิน ข่าว และข้อมูลออปชัน มาจากผู้ให้บริการข้อมูลภายนอก เราแสดงที่มาและเวลาของข้อมูลไว้บนหน้าจอ '
            + 'ข้อมูลบางส่วนเป็นข้อมูลล่าช้า (delayed) ไม่ใช่ราคาเรียลไทม์ทั้งหมด',
        },
        {
          kind: 'paragraph',
          text:
            'เราพยายามให้ข้อมูลถูกต้องและตรวจสอบที่มาของข้อมูลอย่างต่อเนื่อง แต่ไม่สามารถรับประกันความถูกต้อง ความครบถ้วน '
            + 'หรือความต่อเนื่องของข้อมูลจากผู้ให้บริการภายนอกได้ หากพบข้อมูลที่ไม่ถูกต้อง โปรดแจ้งเราผ่านหน้าช่วยเหลือ',
        },
      ],
    },
    {
      heading: '4. แพ็กเกจและการชำระเงิน',
      blocks: [
        {
          kind: 'paragraph',
          text: 'ราคาทั้งหมดเป็นเงินบาท และรวมภาษีตามที่ผู้ให้บริการชำระเงินแสดงในขั้นตอนชำระเงิน',
        },
        {
          kind: 'table',
          columns: ['แพ็กเกจ', 'รอบบิล', 'รอบแรก', 'รอบต่ออายุ'],
          rows: planRows(),
        },
        { kind: 'callout', tone: 'info', text: FOUNDER_RULE },
        { kind: 'definitions', items: RENEWAL_RULES },
        {
          kind: 'paragraph',
          text: 'รายละเอียดการต่ออายุ การยกเลิก และการลดระดับแพ็กเกจ อยู่ในหน้านโยบายแพ็กเกจและการต่ออายุ',
        },
      ],
    },
    {
      heading: '5. การยกเลิกและการคืนเงิน',
      blocks: [
        {
          kind: 'paragraph',
          text:
            'คุณยกเลิกแพ็กเกจได้ทุกเมื่อ และขอคืนเงินเต็มจำนวนของรอบบิลหนึ่งได้ผ่านหน้าคำขอคืนเงินในบัญชีของคุณ '
            + `ภายใน ${REFUND_WINDOW_DAYS} วันนับจากเวลาที่การชำระเงินของรอบนั้นสำเร็จ โดยการต่ออายุแต่ละรอบจะเริ่มนับใหม่ของรอบนั้นเอง `
            + 'การส่งคำขอคืนเงินยังไม่ใช่การคืนเงิน และไม่ตัดสิทธิ์การใช้งานของคุณทันที',
        },
        { kind: 'paragraph', text: DATA_ON_DOWNGRADE },
      ],
    },
    {
      heading: '6. ขอบเขตความรับผิด',
      blocks: [
        {
          kind: 'paragraph',
          text:
            'เราไม่รับผิดชอบต่อผลขาดทุนจากการลงทุน การตัดสินใจซื้อขาย หรือความเสียหายที่เกิดจากการพึ่งพาข้อมูลบนแพลตฟอร์ม '
            + 'เท่าที่กฎหมายที่ใช้บังคับอนุญาต',
        },
        {
          kind: 'paragraph',
          text:
            'บริการอาจหยุดชะงักจากการปรับปรุงระบบ หรือจากผู้ให้บริการภายนอก เราจะแจ้งให้ทราบเท่าที่ทำได้ '
            + 'แต่ไม่ได้รับประกันความพร้อมใช้งานต่อเนื่องตลอดเวลา',
        },
      ],
    },
    {
      heading: '7. การเปลี่ยนแปลงเงื่อนไข',
      blocks: [
        {
          kind: 'paragraph',
          text:
            'หากมีการเปลี่ยนแปลงเงื่อนไขหรือราคา เราจะปรับปรุงหน้านี้พร้อมระบุวันที่มีผล '
            + 'การเปลี่ยนแปลงราคาจะไม่ย้อนหลังกับรอบบิลที่ชำระไปแล้ว',
        },
        {
          kind: 'paragraph',
          text: 'หากมีคำถามเกี่ยวกับเงื่อนไขเหล่านี้ ติดต่อเราได้ที่หน้าช่วยเหลือ',
        },
      ],
    },
  ],
};

const PRIVACY: LegalDocument = {
  slug: 'privacy',
  href: '/privacy',
  title: 'นโยบายความเป็นส่วนตัว',
  subtitle: 'เราเก็บข้อมูลอะไร ใช้ทำอะไร และคุณควบคุมอะไรได้บ้าง',
  effectiveDate: EFFECTIVE_DATE,
  version: POLICY_VERSION,
  intro:
    'หน้านี้อธิบายข้อมูลที่เราเก็บเมื่อคุณใช้งาน วิธีที่เราใช้ข้อมูลนั้น และสิทธิ์ที่คุณมีเหนือข้อมูลของคุณเอง',
  sections: [
    {
      heading: '1. ข้อมูลที่เราเก็บ',
      blocks: [
        {
          kind: 'definitions',
          items: [
            {
              term: 'ข้อมูลบัญชี',
              description: 'อีเมล ชื่อที่แสดง และวิธีการเข้าสู่ระบบ (รหัสผ่านที่เข้ารหัส หรือการเข้าสู่ระบบด้วย Google)',
            },
            {
              term: 'ข้อมูลที่คุณสร้างเอง',
              description: 'พอร์ตการลงทุน รายการธุรกรรมที่คุณบันทึก รายการติดตาม การแจ้งเตือน และผลการจำลองที่คุณบันทึกไว้',
            },
            {
              term: 'ข้อมูลการใช้งานและอุปกรณ์',
              description: 'การตั้งค่าการแสดงผล เขตเวลา และการอนุญาตแจ้งเตือนบนอุปกรณ์ของคุณ',
            },
            {
              term: 'ข้อมูลการชำระเงิน',
              description:
                'สถานะการชำระ รอบบิล แพ็กเกจ และประเภทช่องทางชำระเงิน (บัตร หรือ PromptPay) '
                + 'เราไม่เก็บเลขบัตร วันหมดอายุ หรือรหัส CVC ไว้ในระบบของเราเลย ข้อมูลบัตรอยู่กับผู้ให้บริการชำระเงินเท่านั้น',
            },
            {
              term: 'ข้อมูลการติดต่อฝ่ายช่วยเหลือ',
              description: 'เรื่องที่คุณแจ้ง ข้อความที่ส่ง และไฟล์แนบที่คุณอัปโหลด',
            },
            {
              term: 'ข้อมูลแฮชเพื่อป้องกันการใช้สิทธิทดลองซ้ำ',
              description:
                'เมื่อคุณเริ่มใช้สิทธิทดลองฟรี เราจะบันทึก “ค่าแฮช” ที่คำนวณจากอีเมลของคุณ '
                + 'และจากบัญชีผู้ให้บริการที่คุณใช้เข้าสู่ระบบ (เช่น Google) ด้วยกุญแจลับที่เก็บไว้ในระบบของเราเท่านั้น '
                + 'เราไม่เก็บอีเมล ไม่เก็บรหัสผู้ใช้ของผู้ให้บริการ และไม่เก็บหมายเลขบัตรในรูปแบบที่อ่านได้ '
                + 'ค่าแฮชนี้เป็นข้อมูลนามแฝง (pseudonymous) ไม่ใช่ข้อมูลนิรนาม '
                + 'กล่าวคือไม่แสดงอีเมลของคุณโดยตรง แต่หากมีอีเมลมาเทียบก็ยังตรวจสอบได้ว่าตรงกันหรือไม่ '
                + 'เราใช้เพื่อวัตถุประสงค์เดียวคือให้สิทธิทดลองฟรีหนึ่งครั้งต่อหนึ่งคน '
                + 'และเป็นข้อมูลชุดเดียวที่ยังคงอยู่หลังจากคุณลบบัญชี',
            },
          ],
        },
      ],
    },
    {
      heading: '2. เราใช้ข้อมูลทำอะไร',
      blocks: [
        {
          kind: 'list',
          items: [
            'ให้บริการตามแพ็กเกจที่คุณใช้ และคำนวณสิทธิ์การใช้งาน',
            'ส่งการแจ้งเตือนที่คุณเปิดใช้ เช่น การแจ้งเตือนราคา สรุปพอร์ตรายวัน และการแจ้งเตือนเกี่ยวกับการชำระเงินของคุณ',
            'ดำเนินการชำระเงิน ออกใบแจ้งหนี้ และตรวจสอบความถูกต้องของสิทธิ์กับรายการชำระเงิน',
            'ตอบเรื่องที่คุณแจ้งเข้ามา และตรวจสอบคำขอคืนเงิน',
            'รักษาความปลอดภัยของระบบ ป้องกันการใช้งานที่ผิดปกติ และปฏิบัติตามกฎหมาย',
          ],
        },
        {
          kind: 'paragraph',
          text: 'เราไม่ขายข้อมูลส่วนบุคคลของคุณ และไม่ใช้ข้อมูลพอร์ตของคุณเพื่อโฆษณาของบุคคลที่สาม',
        },
      ],
    },
    {
      heading: '3. ผู้ให้บริการที่เกี่ยวข้อง',
      blocks: [
        {
          kind: 'paragraph',
          text:
            'เราใช้ผู้ให้บริการภายนอกเท่าที่จำเป็นในการให้บริการ ได้แก่ ผู้ให้บริการฐานข้อมูลและการยืนยันตัวตน '
            + 'ผู้ให้บริการโฮสติ้ง ผู้ให้บริการข้อมูลตลาด และผู้ให้บริการชำระเงิน '
            + 'ผู้ให้บริการเหล่านี้เข้าถึงข้อมูลได้เท่าที่จำเป็นต่อหน้าที่ของตนเท่านั้น',
        },
      ],
    },
    {
      heading: '4. การเก็บรักษาและความปลอดภัย',
      blocks: [
        {
          kind: 'list',
          items: [
            'ข้อมูลของคุณถูกจำกัดสิทธิ์ในระดับฐานข้อมูล ผู้ใช้แต่ละคนเข้าถึงได้เฉพาะข้อมูลของตนเอง',
            'ไฟล์แนบในเรื่องที่แจ้งจะถูกเก็บในพื้นที่แบบไม่เปิดสาธารณะ และเปิดดูได้ผ่านลิงก์ชั่วคราวที่ออกให้เฉพาะผู้ที่มีสิทธิ์เท่านั้น',
            'ข้อมูลการชำระเงินและบันทึกการตรวจสอบถูกเก็บไว้ตามระยะเวลาที่จำเป็นทางบัญชีและกฎหมาย',
            `ข้อมูลแฮชเพื่อป้องกันการใช้สิทธิทดลองซ้ำถูกเก็บไว้ไม่เกิน ${TRIAL_IDENTITY_RETENTION_YEARS} ปีนับจากวันที่ใช้สิทธิ `
            + 'โดยกำหนดวันครบกำหนดลบไว้ตั้งแต่วันที่บันทึก และจะถูกลบตามรอบการลบข้อมูลอัตโนมัติหลังครบกำหนด '
            + 'ข้อมูลชุดนี้เป็นค่าแฮชที่ไม่สามารถย้อนกลับเป็นอีเมลได้ ถูกจำกัดสิทธิ์ให้เข้าถึงได้เฉพาะระบบเบื้องหลังเท่านั้น '
            + 'ผู้ใช้และเบราว์เซอร์อ่านไม่ได้ และไม่ถูกใช้เพื่อวัตถุประสงค์อื่นนอกจากการให้สิทธิทดลองหนึ่งครั้งต่อหนึ่งคน',
            'หากข้อมูลแฮชดังกล่าวยังผูกกับบัญชีที่ใช้งานอยู่ ข้อมูลจะถูกลบไปพร้อมกับการลบบัญชีนั้น '
            + 'และในกรณีที่มีข้อพิพาท การขอคืนเงิน หรือการตรวจสอบตามกฎหมายที่ยังไม่สิ้นสุด '
            + 'เราอาจระงับการลบข้อมูลชุดนั้นไว้เท่าที่จำเป็นจนกระบวนการแล้วเสร็จ',
          ],
        },
      ],
    },
    {
      heading: '5. สิทธิ์ของคุณ',
      blocks: [
        {
          kind: 'list',
          items: [
            'ขอดู แก้ไข หรือแก้ไขข้อมูลบัญชีของคุณได้จากหน้าโปรไฟล์และหน้าการตั้งค่า',
            'ปิดหรือเปิดการแจ้งเตือนแต่ละประเภทได้จากหน้าการตั้งค่า',
            'ขอลบบัญชีได้จากหน้าโปรไฟล์ การลบบัญชีจะลบพอร์ต รายการติดตาม การแจ้งเตือน การตั้งค่า ไฟล์แนบ และข้อมูลส่วนตัวของคุณอย่างถาวร',
            'หลังลบบัญชี เรายังเก็บสองสิ่งเท่านั้น คือ บันทึกที่จำเป็นทางบัญชีและการตรวจสอบการชำระเงินตามที่กฎหมายกำหนด '
            + 'และข้อมูลแฮชเพื่อป้องกันการใช้สิทธิทดลองซ้ำ หากคุณสมัครใหม่ด้วยอีเมลหรือบัญชี Google เดิม จะไม่ได้รับสิทธิทดลองฟรีอีก แต่ยังเลือกซื้อแพ็กเกจได้ตามปกติ',
            'การลบบัญชีไม่ใช่การขอคืนเงินอัตโนมัติ หากต้องการขอคืนเงิน กรุณายื่นคำขอก่อนลบบัญชี',
            'ติดต่อเราเพื่อสอบถามเรื่องข้อมูลส่วนบุคคลได้ที่หน้าช่วยเหลือ',
          ],
        },
      ],
    },
  ],
};

const REFUND_POLICY: LegalDocument = {
  slug: 'refund-policy',
  href: '/refund-policy',
  title: 'นโยบายการคืนเงิน',
  subtitle: 'ขอคืนเงินอย่างไร ใช้เวลาเท่าไร และมีผลกับสิทธิ์ใช้งานอย่างไร',
  effectiveDate: EFFECTIVE_DATE,
  version: POLICY_VERSION,
  intro:
    `หน้านี้อธิบายระยะเวลา ${REFUND_WINDOW_DAYS} วันสำหรับการขอคืนเงิน ขั้นตอนการขอคืนเงิน `
    + 'สิ่งที่เกิดขึ้นกับสิทธิ์การใช้งานของคุณในแต่ละขั้น และสิ่งที่เราต้องใช้ในการพิจารณา',
  sections: [
    {
      heading: `1. ระยะเวลาขอคืนเงิน ${REFUND_WINDOW_DAYS} วัน`,
      blocks: [
        { kind: 'definitions', items: REFUND_WINDOW_RULES },
        {
          kind: 'paragraph',
          text:
            'ระบบจะแสดงวันและเวลาครบกำหนดของแต่ละรายการชำระเงินไว้ในหน้าประวัติการชำระเงินและหน้าคำขอคืนเงิน '
            + 'พร้อมเวลาที่เหลือ เพื่อให้คุณตรวจสอบได้เองก่อนส่งคำขอ',
        },
        { kind: 'callout', tone: 'info', text: REFUND_IS_REVIEWED },
      ],
    },
    {
      heading: '2. ขั้นตอนการขอคืนเงิน',
      blocks: [
        {
          kind: 'list',
          items: [
            'เข้าหน้า “แพ็กเกจของคุณ” แล้วเลือก “คำขอคืนเงิน”',
            'เลือกรายการชำระเงินที่ยังอยู่ในกำหนด ระบุเหตุผลและรายละเอียด และแนบภาพประกอบได้หากมี',
            'ทีมงานจะตรวจสอบและอัปเดตสถานะให้คุณทราบผ่านการแจ้งเตือนในระบบ',
          ],
        },
        {
          kind: 'callout',
          tone: 'warning',
          text:
            'การส่งคำขอคืนเงินและการอนุมัติคำขอ ยังไม่ใช่การคืนเงินและไม่ตัดสิทธิ์การใช้งานของคุณ '
            + 'สถานะจะเปลี่ยนเป็น “คืนเงินแล้ว” ก็ต่อเมื่อผู้ให้บริการชำระเงินยืนยันการคืนเงินจริง '
            + 'หรือทีมงานยืนยันว่าดำเนินการคืนเงินเสร็จสิ้นแล้วพร้อมหลักฐานอ้างอิง',
        },
      ],
    },
    {
      heading: '3. สถานะของคำขอ',
      blocks: [
        {
          kind: 'definitions',
          items: [
            { term: 'รอตรวจสอบ', description: 'เราได้รับคำขอแล้ว และยังไม่ได้เริ่มพิจารณา' },
            { term: 'กำลังตรวจสอบ', description: 'ทีมงานกำลังตรวจสอบรายการชำระเงินและรายละเอียดที่คุณให้มา' },
            { term: 'อนุมัติแล้ว', description: 'ทีมงานอนุมัติให้คืนเงิน และกำลังดำเนินการผ่านช่องทางที่คุณชำระมา' },
            { term: 'ไม่อนุมัติ', description: 'ไม่สามารถคืนเงินตามคำขอนี้ได้ คุณดูเหตุผลและตอบกลับได้ในหน้าคำขอ' },
            { term: 'คืนเงินแล้ว', description: 'ยืนยันการคืนเงินแล้ว ยอดเงินจะกลับเข้าช่องทางเดิมตามรอบของผู้ให้บริการชำระเงิน' },
            { term: 'ยกเลิกคำขอ', description: 'คุณถอนคำขอนี้เอง ก่อนที่จะมีการตัดสิน' },
          ],
        },
        {
          kind: 'paragraph',
          text: 'หนึ่งรายการชำระเงินมีคำขอที่ยังไม่ได้ข้อยุติได้ครั้งละหนึ่งคำขอเท่านั้น',
        },
      ],
    },
    {
      heading: '4. สิ่งที่เราพิจารณา',
      blocks: [
        {
          kind: 'list',
          items: [
            `คำขออยู่ภายในกำหนด ${REFUND_WINDOW_DAYS} วันของรายการชำระเงินนั้นหรือไม่`,
            'ระยะเวลาตั้งแต่ชำระเงิน และปริมาณการใช้งานฟีเจอร์แบบชำระเงินในรอบนั้น',
            'กรณีชำระซ้ำหรือถูกเรียกเก็บผิดพลาด ซึ่งเราจะแก้ไขให้เสมอเมื่อตรวจสอบพบ',
            'ปัญหาทางเทคนิคที่ทำให้ใช้งานฟีเจอร์ที่ชำระเงินไม่ได้จริง',
          ],
        },
        {
          kind: 'paragraph',
          text:
            'เราพิจารณาคำขอเป็นรายกรณีตามข้อเท็จจริงของแต่ละรายการ และไม่ได้กำหนดเป็นการรับประกันล่วงหน้าว่าคำขอทุกกรณีจะได้รับอนุมัติ '
            + 'หากไม่อนุมัติ เราจะแจ้งเหตุผลให้ทราบ',
        },
      ],
    },
    {
      heading: '5. ผลของการคืนเงินต่อสิทธิ์ใช้งาน',
      blocks: [
        {
          kind: 'definitions',
          items: [
            {
              term: 'คืนเงินเต็มจำนวน',
              description:
                'สิทธิ์แบบชำระเงินของรอบนั้นสิ้นสุดลงเมื่อผู้ให้บริการชำระเงินยืนยันการคืนเงิน และบัญชีกลับไปใช้ Basic',
            },
            {
              term: 'คืนเงินบางส่วน',
              description: 'ถือเป็นการปรับยอด ไม่มีผลกับสิทธิ์การใช้งาน แพ็กเกจของคุณยังใช้งานได้ตามรอบเดิม',
            },
            {
              term: 'การโต้แย้งการชำระเงินกับธนาคาร',
              description:
                'หากมีการแจ้งโต้แย้ง (chargeback) เราจะพักสิทธิ์แบบชำระเงินไว้ระหว่างการตรวจสอบของธนาคาร '
                + 'และจะคืนสิทธิ์ให้หากผลการตรวจสอบเป็นไปในทางที่ยืนยันการชำระเงินนั้น',
            },
          ],
        },
        { kind: 'paragraph', text: DATA_ON_DOWNGRADE },
      ],
    },
    {
      heading: '6. ระยะเวลาที่เงินกลับเข้าบัญชี',
      blocks: [
        {
          kind: 'paragraph',
          text:
            'หลังจากคืนเงินสำเร็จ ระยะเวลาที่เงินจะกลับเข้าบัญชีหรือวงเงินบัตรของคุณ ขึ้นอยู่กับธนาคารและผู้ให้บริการชำระเงิน '
            + 'ซึ่งอยู่นอกเหนือการควบคุมของเรา',
        },
      ],
    },
    {
      heading: '7. การเปลี่ยนแปลงนโยบายนี้',
      blocks: [
        {
          kind: 'paragraph',
          text:
            'หากมีการแก้ไขนโยบายนี้ เราจะปรับปรุงหน้านี้พร้อมระบุวันที่มีผล '
            + 'การแก้ไขจะมีผลกับการชำระเงินที่เกิดขึ้นหลังวันที่มีผลเท่านั้น '
            + 'รายการที่ชำระไปแล้วยังคงใช้เงื่อนไขและกำหนดเวลาตามฉบับที่คุณยอมรับไว้ตอนซื้อ',
        },
        {
          kind: 'paragraph',
          text:
            'นโยบายนี้ไม่ตัดสิทธิ์ที่คุณมีตามกฎหมายคุ้มครองผู้บริโภคหรือกฎหมายอื่นที่ใช้บังคับ '
            + 'หากกฎหมายกำหนดสิทธิ์ที่มากกว่าที่ระบุไว้ในหน้านี้ ให้เป็นไปตามกฎหมายนั้น',
        },
      ],
    },
  ],
};

const SUBSCRIPTION_POLICY: LegalDocument = {
  slug: 'subscription-policy',
  href: '/subscription-policy',
  title: 'นโยบายแพ็กเกจและการต่ออายุ',
  subtitle: 'ราคา รอบบิล การต่ออายุของแต่ละช่องทาง และการยกเลิก',
  effectiveDate: EFFECTIVE_DATE,
  version: POLICY_VERSION,
  intro:
    'หน้านี้รวมเรื่องราคา รอบบิล การต่ออายุ การยกเลิก '
    + `และระยะเวลาขอคืนเงิน ${REFUND_WINDOW_DAYS} วันของแต่ละรอบบิลไว้ในที่เดียว`,
  sections: [
    {
      heading: '1. ราคาและรอบบิล',
      blocks: [
        {
          kind: 'table',
          columns: ['แพ็กเกจ', 'รอบบิล', 'รอบแรก', 'รอบต่ออายุ'],
          rows: planRows(),
        },
        {
          kind: 'paragraph',
          text:
            'แพ็กเกจ Basic ใช้งานได้ฟรีโดยไม่มีค่าใช้จ่าย และบัญชีที่ยืนยันอีเมลแล้วเริ่มทดลอง Elite ได้โดยไม่ต้องผูกบัตร '
            + `— ${TRIAL_ELIGIBILITY_STATEMENT}`,
        },
        { kind: 'callout', tone: 'info', text: FOUNDER_RULE },
      ],
    },
    {
      heading: '2. การต่ออายุของแต่ละช่องทาง',
      blocks: [
        { kind: 'definitions', items: RENEWAL_RULES },
        {
          kind: 'paragraph',
          text:
            'สำหรับ PromptPay เราจะแจ้งเตือนล่วงหน้า 7 วัน 3 วัน และ 1 วันก่อนครบรอบ '
            + 'และจะหยุดแจ้งเตือนเมื่อชำระรอบถัดไปเรียบร้อยแล้ว',
        },
        {
          kind: 'callout',
          tone: 'info',
          text:
            'ก่อนเริ่มชำระเงินทุกครั้ง ระบบจะแสดงแพ็กเกจที่เลือก ราคา รอบบิล วิธีชำระเงิน '
            + 'ลักษณะการต่ออายุของช่องทางนั้น และเงื่อนไขการคืนเงิน แล้วให้คุณกดยอมรับก่อนหนึ่งครั้ง '
            + 'การยอมรับนี้จำเป็นเฉพาะตอนเริ่มซื้อใหม่เท่านั้น ไม่กระทบการต่ออายุของแพ็กเกจที่ใช้อยู่ '
            + 'และไม่กระทบการเข้าหน้าจัดการการชำระเงิน',
        },
      ],
    },
    {
      heading: `3. การขอคืนเงินภายใน ${REFUND_WINDOW_DAYS} วัน`,
      blocks: [
        { kind: 'definitions', items: REFUND_WINDOW_RULES },
        { kind: 'callout', tone: 'warning', text: REFUND_IS_REVIEWED },
        {
          kind: 'paragraph',
          text: 'ขั้นตอน สถานะของคำขอ และผลต่อสิทธิ์การใช้งาน อยู่ในหน้านโยบายการคืนเงิน',
        },
      ],
    },
    {
      heading: '4. การเปลี่ยนหรือยกเลิกแพ็กเกจ',
      blocks: [
        {
          kind: 'list',
          items: [
            'ยกเลิกการต่ออายุอัตโนมัติได้จากหน้า “แพ็กเกจของคุณ” เมื่อยกเลิกแล้ว คุณยังใช้งานได้จนถึงวันสิ้นสุดรอบที่ชำระไว้',
            'ระบบจะแจ้งวันสิ้นสุดสิทธิ์ที่แน่นอนให้คุณทราบในการแจ้งเตือนเมื่อยกเลิก',
            'สำหรับ PromptPay การไม่ชำระรอบถัดไปคือการสิ้นสุดแพ็กเกจโดยปริยาย ไม่ต้องทำอะไรเพิ่ม',
            'หนึ่งบัญชีมีแพ็กเกจที่ใช้งานอยู่ได้ครั้งละหนึ่งแพ็กเกจ หากต้องการเปลี่ยนแพ็กเกจระหว่างรอบ โปรดติดต่อทีมงานผ่านหน้าช่วยเหลือ',
          ],
        },
      ],
    },
    {
      heading: '5. เมื่อสิทธิ์สิ้นสุด',
      blocks: [
        { kind: 'paragraph', text: DATA_ON_DOWNGRADE },
        {
          kind: 'paragraph',
          text:
            'หากต้องการกลับมาใช้แพ็กเกจอีกครั้ง ข้อมูลเดิมของคุณจะยังอยู่และกลับมาใช้งานได้ทันทีเมื่อชำระเงินสำเร็จ '
            + `และการชำระเงินครั้งใหม่นั้นจะเริ่มนับระยะเวลาขอคืนเงิน ${REFUND_WINDOW_DAYS} วันของตัวเองใหม่`,
        },
      ],
    },
    {
      heading: '6. การเปลี่ยนแปลงราคาและเงื่อนไข',
      blocks: [
        {
          kind: 'paragraph',
          text:
            'หากมีการปรับราคา เราจะแจ้งล่วงหน้าและปรับปรุงหน้านี้พร้อมวันที่มีผล '
            + 'ราคาใหม่จะมีผลกับรอบบิลถัดไป ไม่ย้อนหลังกับรอบที่ชำระไปแล้ว',
        },
        {
          kind: 'paragraph',
          text:
            'การแก้ไขเงื่อนไขในหน้านี้มีผลกับการซื้อและการต่ออายุที่เกิดขึ้นหลังวันที่มีผลเท่านั้น '
            + 'การยอมรับเงื่อนไขที่คุณเคยให้ไว้ และกำหนดเวลาขอคืนเงินของรายการที่ชำระไปแล้ว ยังคงเป็นไปตามฉบับเดิม '
            + 'ทั้งนี้ไม่ตัดสิทธิ์ที่คุณมีตามกฎหมายที่ใช้บังคับ',
        },
      ],
    },
  ],
};

const INVESTMENT_DISCLAIMER: LegalDocument = {
  slug: 'investment-disclaimer',
  href: '/investment-disclaimer',
  title: 'คำเตือนเรื่องการลงทุน',
  subtitle: 'ขอบเขตของเครื่องมือนี้ และสิ่งที่เครื่องมือนี้ไม่ใช่',
  effectiveDate: EFFECTIVE_DATE,
  version: POLICY_VERSION,
  intro: 'โปรดอ่านหน้านี้ก่อนใช้ข้อมูลและผลการวิเคราะห์บนแพลตฟอร์มประกอบการตัดสินใจลงทุน',
  sections: [
    {
      heading: '1. เครื่องมือวิเคราะห์ ไม่ใช่คำแนะนำการลงทุน',
      blocks: [
        { kind: 'callout', tone: 'warning', text: NOT_ADVICE },
        {
          kind: 'paragraph',
          text:
            'ตัวเลข สัญญาณ ระดับแนวรับแนวต้าน มูลค่าที่เหมาะสม และผลการจำลองทั้งหมดบนแพลตฟอร์ม '
            + 'เป็นผลจากการคำนวณตามสูตรและสมมติฐานที่ระบุไว้ ไม่ใช่การชี้นำให้ซื้อหรือขายหลักทรัพย์ใด '
            + 'และไม่ได้พิจารณาสถานะทางการเงิน เป้าหมาย หรือระดับความเสี่ยงที่ยอมรับได้ของคุณเป็นรายบุคคล',
        },
      ],
    },
    {
      heading: '2. ความเสี่ยงที่ควรเข้าใจ',
      blocks: [
        {
          kind: 'list',
          items: [
            'การลงทุนมีความเสี่ยง ผู้ลงทุนอาจสูญเสียเงินลงทุนบางส่วนหรือทั้งหมด',
            'ตราสารอนุพันธ์และสัญญาออปชันมีความเสี่ยงสูงเป็นพิเศษ และอาจขาดทุนได้เกินกว่าเงินลงทุนเริ่มต้นในบางกรณี',
            'ผลการดำเนินงานในอดีตและผลการจำลองย้อนหลัง ไม่ได้เป็นเครื่องยืนยันผลตอบแทนในอนาคต',
            'การลงทุนในหลักทรัพย์ต่างประเทศมีความเสี่ยงจากอัตราแลกเปลี่ยนเพิ่มเติม',
          ],
        },
      ],
    },
    {
      heading: '3. ข้อจำกัดของข้อมูลและแบบจำลอง',
      blocks: [
        {
          kind: 'list',
          items: [
            'ข้อมูลราคาบางส่วนเป็นข้อมูลล่าช้า และอาจต่างจากราคาที่คุณซื้อขายได้จริง',
            'ข้อมูลปัจจัยพื้นฐานมาจากผู้ให้บริการภายนอก อาจมีการปรับปรุงย้อนหลังหรือไม่ครบทุกบริษัท',
            'แบบจำลองมูลค่าและการจำลองสถานการณ์ใช้สมมติฐานที่เราแสดงไว้ข้างผลลัพธ์ หากสมมติฐานเปลี่ยน ผลลัพธ์ย่อมเปลี่ยนตาม',
            'เมื่อข้อมูลไม่พอสำหรับคำนวณอย่างมีความหมาย เราจะแสดงว่า “ไม่มีข้อมูลเพียงพอ” แทนการเดาตัวเลขให้',
          ],
        },
      ],
    },
    {
      heading: '4. ความรับผิดชอบของผู้ใช้',
      blocks: [
        {
          kind: 'paragraph',
          text:
            'คุณควรศึกษาข้อมูลจากหลายแหล่ง และพิจารณาปรึกษาผู้แนะนำการลงทุนที่ได้รับใบอนุญาตก่อนตัดสินใจ '
            + 'การตัดสินใจซื้อขายและผลที่ตามมาเป็นความรับผิดชอบของคุณเอง',
        },
      ],
    },
  ],
};

export const legalDocuments: Readonly<Record<LegalDocumentSlug, LegalDocument>> = {
  terms: TERMS,
  privacy: PRIVACY,
  'refund-policy': REFUND_POLICY,
  'subscription-policy': SUBSCRIPTION_POLICY,
  'investment-disclaimer': INVESTMENT_DISCLAIMER,
};

/** The order the links appear in, everywhere they appear. */
export const legalLinkOrder: readonly LegalDocumentSlug[] = [
  'terms',
  'privacy',
  'subscription-policy',
  'refund-policy',
  'investment-disclaimer',
];

/**
 * The vintage of one document's wording.
 *
 * The purchase-consent path reads this on the server and refuses any acceptance
 * pinned to a different value, which is what makes a stale browser tab unable to
 * buy against wording that has since been replaced.
 */
export function legalDocumentVersion(slug: LegalDocumentSlug): string {
  return legalDocuments[slug].version;
}

export interface LegalLink {
  href: string;
  label: string;
}

/** The link list the footer, the auth shell and Settings all read. */
export function legalLinks(): readonly LegalLink[] {
  return legalLinkOrder.map((slug) => ({
    href: legalDocuments[slug].href,
    label: legalDocuments[slug].title,
  }));
}
