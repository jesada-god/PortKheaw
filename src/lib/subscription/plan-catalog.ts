import { subscriptionCapabilities, type SubscriptionCapability } from './capabilities';
import { subscriptionTiers, type SubscriptionTier } from './subscription-types';

/**
 * The one description of what each plan is and what it includes. The plan
 * cards, the comparison table and the FAQ all read from here, so a feature is
 * written down once and cannot drift between the page's three sections.
 *
 * A row is one of two kinds:
 *
 *   `capability` — the value is read straight out of the Phase 1 entitlement
 *   matrix, which is the same matrix the server and the database enforce. These
 *   rows cannot disagree with what a subscription actually unlocks.
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
  /** Present when the row's value comes from the enforced entitlement matrix. */
  capability?: SubscriptionCapability;
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
      fromCatalog('signal-breakdown', 'Signal Breakdown แยกรายปัจจัย', {
        basic: excluded,
        pro: excluded,
        elite: included,
      }),
    ],
  },
  {
    id: 'options',
    label: 'Options',
    rows: [
      fromCatalog('options-chain', 'Options Chain', {
        basic: excluded,
        pro: { kind: 'text', value: 'พื้นฐาน' },
        elite: { kind: 'text', value: 'เต็มรูปแบบ' },
      }),
      fromCapability('options-walls', 'Options Walls (Call/Put Wall, Max Pain)', 'options.analytics.walls'),
      fromCatalog('full-greeks', 'Full Greeks ครบทุกค่า', {
        basic: excluded,
        pro: excluded,
        elite: included,
      }),
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
  /** First-year Founder's Club price, honoured once real billing opens. */
  founderFirstYearBaht: number;
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
    pricing: { monthlyBaht: 349, yearlyBaht: 3_490, founderFirstYearBaht: 1_990 },
    badge: 'แนะนำ',
    highlights: ['stock-portfolios', 'option-portfolios', 'vpvr', 'sr-context', 'what-if', 'options-chain'],
  },
  {
    tier: 'elite',
    name: 'Elite',
    tagline: 'ทุกอย่างใน Pro พร้อมเครื่องมือวิเคราะห์ Options เต็มชุด',
    pricing: { monthlyBaht: 799, yearlyBaht: 7_990, founderFirstYearBaht: 4_490 },
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
