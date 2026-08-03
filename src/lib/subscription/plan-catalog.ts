import { billingPlans, type PaidTier } from '@/src/lib/billing/billing-plans';
import { hasCapability, subscriptionCapabilities, type SubscriptionCapability } from './capabilities';
import { subscriptionTiers, type SubscriptionTier } from './subscription-types';

/**
 * The one description of what each plan is and what it includes. The plan
 * cards, the comparison table and the FAQ all read from here, so a feature is
 * written down once and cannot drift between the page's three sections.
 *
 * A row is one of two kinds:
 *
 *   **enforced** — the value is read straight out of the entitlement matrix,
 *   which is the same matrix the server enforces on every premium path. These
 *   rows cannot disagree with what a subscription actually unlocks. A row that
 *   grows in stages (a basic ledger, then an advanced one) names each stage's
 *   capability in `capabilities` and still derives its value from the matrix.
 *
 *   `catalog` — part of the product's plan description that has no entitlement
 *   key behind it yet. Kept explicit so nobody mistakes it for an enforced gate.
 */

export type PlanFeatureValue =
  | { kind: 'included' }
  | { kind: 'excluded' }
  | { kind: 'count'; value: number }
  | { kind: 'text'; value: string };

export interface PlanFeatureRow {
  id: string;
  label: string;
  /** Present when the row's value comes from one enforced entitlement key. */
  capability?: SubscriptionCapability;
  /**
   * Present when the row is a ladder: every stage's enforced key, cheapest
   * first. `capability` carries the first stage, so one predicate — "does this
   * row name a capability?" — still separates enforced rows from catalog copy.
   */
  capabilities?: readonly SubscriptionCapability[];
  values: Readonly<Record<SubscriptionTier, PlanFeatureValue>>;
}

export interface PlanFeatureGroup {
  id: string;
  label: string;
  rows: readonly PlanFeatureRow[];
}

type CatalogValues = Record<SubscriptionTier, PlanFeatureValue>;

const included: PlanFeatureValue = { kind: 'included' };
const excluded: PlanFeatureValue = { kind: 'excluded' };

/** Turns one entitlement key into its three per-tier display values. */
function fromCapability(id: string, label: string, capability: SubscriptionCapability): PlanFeatureRow {
  const values = Object.fromEntries(subscriptionTiers.map((tier) => {
    const value = subscriptionCapabilities[tier][capability];
    if (typeof value === 'number') return [tier, { kind: 'count', value } as PlanFeatureValue];
    return [tier, value ? included : excluded];
  })) as CatalogValues;
  return { id, label, capability, values };
}

/**
 * A feature that arrives in stages. Each tier shows the label of the richest
 * stage it is actually entitled to, so "พื้นฐาน" and "เต็มรูปแบบ" are decided by
 * the matrix rather than typed in beside it.
 */
function fromCapabilityLadder(
  id: string,
  label: string,
  stages: readonly { capability: SubscriptionCapability; text: string }[],
): PlanFeatureRow {
  const values = Object.fromEntries(subscriptionTiers.map((tier) => {
    const reached = [...stages].reverse().find((stage) => hasCapability(tier, stage.capability));
    return [tier, reached ? { kind: 'text', value: reached.text } as PlanFeatureValue : excluded];
  })) as CatalogValues;
  return { id, label, capabilities: stages.map((stage) => stage.capability), values };
}

/** One predicate for "this row is a promise the server enforces", used by tests and UI alike. */
export function isEnforcedRow(row: PlanFeatureRow): boolean {
  return Boolean(row.capability) || Boolean(row.capabilities?.length);
}

function fromCatalog(id: string, label: string, values: CatalogValues): PlanFeatureRow {
  return { id, label, values };
}

export const planFeatureGroups: readonly PlanFeatureGroup[] = [
  {
    id: 'portfolio',
    label: 'พอร์ตโฟลิโอ',
    rows: [
      fromCapability('stock-portfolios', 'พอร์ตหุ้นและ ETF', 'portfolio.stock.max_count'),
      fromCapability('option-portfolios', 'พอร์ต Options', 'portfolio.options.max_count'),
      fromCatalog('watchlist', 'Watchlist และข้อมูลตลาด', {
        basic: included,
        pro: included,
        elite: included,
      }),
    ],
  },
  {
    id: 'chart',
    label: 'กราฟ',
    rows: [
      fromCatalog('chart-basics', 'กราฟราคาและตัวชี้วัดพื้นฐาน', {
        basic: included,
        pro: included,
        elite: included,
      }),
      fromCapability('sr-levels', 'แนวรับ–แนวต้าน S1–S3 และ R1–R3', 'chart.sr.levels'),
      fromCapability('vpvr', 'VPVR (โปรไฟล์ปริมาณซื้อขาย)', 'chart.vpvr'),
    ],
  },
  {
    id: 'analysis',
    label: 'การวิเคราะห์',
    rows: [
      fromCapability('sr-context', 'S/R Context อธิบายที่มาของแต่ละแนว', 'chart.sr.context'),
      fromCapability('signal-summary', 'Options Signal สรุปทิศทางและคะแนนความมั่นใจ', 'options.signal.summary'),
      fromCapability('signal-breakdown', 'Signal Breakdown แยกรายปัจจัย', 'options.signal.breakdown'),
      fromCapability('technical-outlook', 'Technical Outlook · Market Signal', 'technical.outlook'),
    ],
  },
  {
    id: 'options',
    label: 'Options',
    rows: [
      fromCapabilityLadder('options-chain', 'Options Chain', [
        { capability: 'options.chain.basic', text: 'พื้นฐาน' },
        { capability: 'options.chain.advanced', text: 'เต็มรูปแบบ' },
      ]),
      fromCapability('options-walls', 'Options Walls (Call/Put Wall, Max Pain)', 'options.analytics.walls'),
      fromCapability('full-greeks', 'Full Greeks ครบทุกค่า', 'options.greeks.full'),
      fromCapability('expected-move', 'Expected Move กรอบความผันผวนที่ตลาดคาด', 'options.expected_move'),
    ],
  },
  {
    id: 'simulation',
    label: 'การจำลอง',
    rows: [
      fromCapability('what-if', 'What-If จำลองสถานการณ์', 'simulator.what_if'),
      fromCapability('monte-carlo', 'Monte Carlo จำลองหลายเส้นทาง', 'simulator.monte_carlo'),
    ],
  },
] as const;

export interface PlanPricing {
  monthlyBaht: number;
  yearlyBaht: number;
  /** First-year Founder's Club price, charged on the first invoice only. */
  founderFirstYearBaht: number;
}

/**
 * Prices are not written here.
 *
 * They are read from the billing catalogue, which is the same set of rows the
 * checkout looks a plan key up in. Before Phase 4 these were three literals on
 * this page, and a price shown on a card could quietly disagree with the price
 * actually charged. Deriving them removes that possibility rather than
 * documenting it away.
 */
function pricingFor(tier: PaidTier): PlanPricing {
  return {
    monthlyBaht: billingPlans[`${tier}_monthly`].renewalBaht,
    yearlyBaht: billingPlans[`${tier}_annual`].renewalBaht,
    founderFirstYearBaht: billingPlans[`${tier}_annual_founder`].firstPeriodBaht,
  };
}

export interface PlanDescriptor {
  tier: SubscriptionTier;
  name: string;
  tagline: string;
  pricing: PlanPricing | null;
  /** Rendered instead of a price when the plan costs nothing. */
  freeLabel?: string;
  badge?: string;
  /** Feature-row ids surfaced on the plan card, in card order. */
  highlights: readonly string[];
}

export const planDescriptors: readonly PlanDescriptor[] = [
  {
    tier: 'basic',
    name: 'Basic',
    tagline: 'เริ่มเข้าใจพอร์ตของคุณ โดยไม่มีค่าใช้จ่าย',
    pricing: null,
    freeLabel: 'ฟรีตลอดชีพ',
    highlights: ['watchlist', 'stock-portfolios', 'chart-basics', 'sr-levels'],
  },
  {
    tier: 'pro',
    name: 'Pro',
    tagline: 'สำหรับคนที่จัดพอร์ตหลายใบและอ่านกราฟลึกขึ้น',
    pricing: pricingFor('pro'),
    badge: 'แนะนำ',
    highlights: ['stock-portfolios', 'option-portfolios', 'vpvr', 'sr-context', 'what-if', 'options-chain'],
  },
  {
    tier: 'elite',
    name: 'Elite',
    tagline: 'ทุกอย่างใน Pro พร้อมเครื่องมือวิเคราะห์ Options เต็มชุด',
    pricing: pricingFor('elite'),
    highlights: ['options-walls', 'monte-carlo', 'full-greeks', 'signal-breakdown'],
  },
] as const;

const featureRowsById = new Map(
  planFeatureGroups.flatMap((group) => group.rows.map((row) => [row.id, row] as const)),
);

export function planFeatureRow(id: string): PlanFeatureRow {
  const row = featureRowsById.get(id);
  if (!row) throw new Error(`Unknown plan feature row: ${id}`);
  return row;
}

export function planDescriptor(tier: SubscriptionTier): PlanDescriptor {
  const descriptor = planDescriptors.find((item) => item.tier === tier);
  if (!descriptor) throw new Error(`Unknown plan tier: ${tier}`);
  return descriptor;
}

/**
 * Thai baht with thousands separators, formatted without `Intl` so the server
 * and the browser cannot disagree about grouping and produce a hydration
 * mismatch on a price.
 */
export function formatBaht(amount: number): string {
  const whole = Math.round(amount).toString();
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** The short line a card shows for a feature: "10 พอร์ต", "พื้นฐาน", the label. */
export function featureSummary(row: PlanFeatureRow, tier: SubscriptionTier): string {
  const value = row.values[tier];
  if (value.kind === 'count') return `${row.label} ${formatBaht(value.value)} พอร์ต`;
  if (value.kind === 'text') return `${row.label} (${value.value})`;
  return row.label;
}
