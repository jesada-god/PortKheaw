import { describe, expect, it } from 'vitest';
import { subscriptionCapabilities } from './capabilities';
import {
  featureSummary,
  formatBaht,
  planDescriptor,
  planDescriptors,
  planFeatureGroups,
  planFeatureRow,
} from './plan-catalog';
import { subscriptionTiers } from './subscription-types';

describe('plan catalog', () => {
  it('covers the five product categories in reading order', () => {
    expect(planFeatureGroups.map((group) => group.id))
      .toEqual(['portfolio', 'chart', 'analysis', 'options', 'simulation']);
  });

  it('derives every enforced row from the entitlement matrix rather than restating it', () => {
    const enforced = planFeatureGroups.flatMap((group) => group.rows).filter((row) => row.capability);
    expect(enforced.length).toBeGreaterThanOrEqual(7);

    for (const row of enforced) {
      for (const tier of subscriptionTiers) {
        const source = subscriptionCapabilities[tier][row.capability!];
        const value = row.values[tier];
        if (typeof source === 'number') {
          expect(value).toEqual({ kind: 'count', value: source });
        } else {
          expect(value.kind).toBe(source ? 'included' : 'excluded');
        }
      }
    }
  });

  it('names every feature exactly once across the whole catalog', () => {
    const ids = planFeatureGroups.flatMap((group) => group.rows.map((row) => row.id));
    expect(new Set(ids).size).toBe(ids.length);
    const labels = planFeatureGroups.flatMap((group) => group.rows.map((row) => row.label));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('gives every row a value for all three tiers', () => {
    for (const group of planFeatureGroups) {
      for (const row of group.rows) {
        for (const tier of subscriptionTiers) {
          expect(row.values[tier], `${row.id}/${tier}`).toBeDefined();
        }
      }
    }
  });

  it('matches the published Basic, Pro and Elite pricing', () => {
    expect(planDescriptor('basic').pricing).toBeNull();
    expect(planDescriptor('basic').freeLabel).toBe('ฟรีตลอดชีพ');
    expect(planDescriptor('pro').pricing).toEqual({
      monthlyBaht: 349,
      yearlyBaht: 3_490,
      founderFirstYearBaht: 1_990,
    });
    expect(planDescriptor('elite').pricing).toEqual({
      monthlyBaht: 799,
      yearlyBaht: 7_990,
      founderFirstYearBaht: 4_490,
    });
    expect(planDescriptor('pro').badge).toBe('แนะนำ');
    expect(planDescriptor('basic').badge).toBeUndefined();
    expect(planDescriptor('elite').badge).toBeUndefined();
  });

  it('lists the three plans cheapest first and every highlight resolves to a real row', () => {
    expect(planDescriptors.map((plan) => plan.tier)).toEqual(['basic', 'pro', 'elite']);
    for (const plan of planDescriptors) {
      expect(plan.highlights.length).toBeGreaterThan(0);
      for (const id of plan.highlights) {
        expect(() => planFeatureRow(id)).not.toThrow();
      }
    }
    expect(() => planFeatureRow('not-a-feature')).toThrow(/Unknown plan feature row/);
  });

  it('surfaces the Basic single-portfolio limit and the paid ten on the cards', () => {
    const stock = planFeatureRow('stock-portfolios');
    expect(featureSummary(stock, 'basic')).toBe('พอร์ตหุ้นและ ETF 1 พอร์ต');
    expect(featureSummary(stock, 'pro')).toBe('พอร์ตหุ้นและ ETF 10 พอร์ต');
    expect(featureSummary(planFeatureRow('options-chain'), 'pro')).toBe('Options Chain (พื้นฐาน)');
    expect(featureSummary(planFeatureRow('vpvr'), 'pro')).toBe('VPVR (โปรไฟล์ปริมาณซื้อขาย)');
  });

  it('groups thousands identically everywhere so a price cannot mismatch on hydration', () => {
    expect(formatBaht(349)).toBe('349');
    expect(formatBaht(3_490)).toBe('3,490');
    expect(formatBaht(7_990)).toBe('7,990');
    expect(formatBaht(1_000_000)).toBe('1,000,000');
    expect(formatBaht(1)).toBe('1');
  });
});
