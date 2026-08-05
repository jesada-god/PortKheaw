import { describe, expect, it } from 'vitest';
import {
  ADMIN_DEFAULT_TIER,
  resolveAccountAccess,
  type AdminPreviewMode,
  type UserRole,
} from './admin-access';
import {
  capabilityValue,
  hasCapability,
  requiredTierFor,
  subscriptionCapabilities,
  type SubscriptionCapability,
} from './capabilities';
import { denyEntitlement } from './entitlement-guard';
import { resolveEffectiveTier } from './resolve-effective-tier';
import { portfolioWriteBlock } from './portfolio-write-access';
import { portfolioCreationEntitlement } from './subscription-limits';
import { shapeSimulationForTier } from '@/src/lib/options-simulator/entitlement-shaping';
import { optionsChainProjectionFor } from '@/src/lib/market-data/options/entitlement-shaping';
import { subscriptionTiers, type SubscriptionRecord, type SubscriptionTier } from './subscription-types';

/**
 * Phase 3.2: the whole entitlement decision, proved once against every reader
 * the product can have.
 *
 * The defect this suite exists to prevent was not a wrong rule — each layer's
 * rule was right on its own. It was two different values being called "the
 * tier": the plan an account had paid for, and the plan it may open. So every
 * case below starts from a stored subscription plus a role plus a preview, runs
 * the one resolver, and then asserts that *every* capability, limit and response
 * projection follows from the single tier it returns.
 */

const NOW = '2026-08-04T12:00:00.000Z';
const FUTURE = '2026-12-31T00:00:00.000Z';
const PAST = '2026-01-01T00:00:00.000Z';

const CAPABILITIES = Object.keys(subscriptionCapabilities.basic) as SubscriptionCapability[];
const BOOLEAN_CAPABILITIES = CAPABILITIES
  .filter((capability) => typeof subscriptionCapabilities.elite[capability] === 'boolean');
const COUNT_CAPABILITIES = CAPABILITIES
  .filter((capability) => typeof subscriptionCapabilities.elite[capability] === 'number');

type StoredSubscription = Pick<SubscriptionRecord, 'tier' | 'status' | 'trialEndsAt' | 'currentPeriodEnd'>;

const SUBSCRIPTIONS = {
  basic: { tier: 'basic', status: 'basic', trialEndsAt: null, currentPeriodEnd: null },
  pro: { tier: 'pro', status: 'active', trialEndsAt: null, currentPeriodEnd: FUTURE },
  elite: { tier: 'elite', status: 'active', trialEndsAt: null, currentPeriodEnd: FUTURE },
  activeTrial: { tier: 'elite', status: 'trialing', trialEndsAt: FUTURE, currentPeriodEnd: null },
  expiredTrial: { tier: 'elite', status: 'trialing', trialEndsAt: PAST, currentPeriodEnd: null },
} as const satisfies Record<string, StoredSubscription>;

interface Persona {
  label: string;
  role: UserRole;
  subscription: StoredSubscription | null;
  previewMode: AdminPreviewMode;
  previewExpiresAt: string | null;
  /** The plan actually held — what billing copy may say. */
  expectedSubscriptionTier: SubscriptionTier;
  /** The plan that opens features — what every gate must read. */
  expectedAccessTier: SubscriptionTier;
}

const persona = (
  label: string,
  subscription: StoredSubscription | null,
  expectedSubscriptionTier: SubscriptionTier,
  expectedAccessTier: SubscriptionTier,
  overrides: Partial<Persona> = {},
): Persona => ({
  label,
  role: 'user',
  subscription,
  previewMode: 'actual',
  previewExpiresAt: null,
  expectedSubscriptionTier,
  expectedAccessTier,
  ...overrides,
});

const admin = (
  label: string,
  previewMode: AdminPreviewMode,
  expectedAccessTier: SubscriptionTier,
  previewExpiresAt: string | null = FUTURE,
): Persona => persona(label, SUBSCRIPTIONS.basic, 'basic', expectedAccessTier, {
  role: 'admin',
  previewMode,
  previewExpiresAt,
});

/**
 * Every reader the product can have. The owner's stored plan is Basic in each
 * administrator case on purpose: it is the exact state that produced the bug,
 * and the state production is in.
 */
const PERSONAS: readonly Persona[] = [
  persona('Basic subscriber', SUBSCRIPTIONS.basic, 'basic', 'basic'),
  persona('Pro subscriber', SUBSCRIPTIONS.pro, 'pro', 'pro'),
  persona('Elite subscriber', SUBSCRIPTIONS.elite, 'elite', 'elite'),
  persona('active Elite trial', SUBSCRIPTIONS.activeTrial, 'elite', 'elite'),
  persona('expired trial', SUBSCRIPTIONS.expiredTrial, 'basic', 'basic'),
  persona('no subscription row', null, 'basic', 'basic'),
  // A stored preview belonging to an account that is not an administrator must
  // do nothing at all.
  persona('demoted account holding an Elite preview', SUBSCRIPTIONS.basic, 'basic', 'basic', {
    previewMode: 'elite',
    previewExpiresAt: FUTURE,
  }),
  admin('Admin actual', 'actual', ADMIN_DEFAULT_TIER, null),
  admin('Admin Basic preview', 'basic', 'basic'),
  admin('Admin Pro preview', 'pro', 'pro'),
  admin('Admin Elite preview', 'elite', 'elite'),
  admin('Admin Elite Trial preview', 'elite_trial', 'elite'),
  admin('Admin Expired Trial preview', 'expired_trial', 'basic'),
  admin('Admin lapsed Basic preview', 'basic', ADMIN_DEFAULT_TIER, PAST),
];

function accessFor(subject: Persona) {
  return resolveAccountAccess({
    role: subject.role,
    subscriptionEffectiveTier: resolveEffectiveTier(subject.subscription, NOW),
    previewMode: subject.previewMode,
    previewExpiresAt: subject.previewExpiresAt,
    now: NOW,
  });
}

describe('capability inheritance', () => {
  it('never lets a higher plan lose something a lower plan has', () => {
    for (let index = 1; index < subscriptionTiers.length; index += 1) {
      const lower = subscriptionTiers[index - 1];
      const higher = subscriptionTiers[index];
      for (const capability of BOOLEAN_CAPABILITIES) {
        if (hasCapability(lower, capability)) {
          expect(
            hasCapability(higher, capability),
            `${higher} must keep ${capability} from ${lower}`,
          ).toBe(true);
        }
      }
      for (const capability of COUNT_CAPABILITIES) {
        expect(
          capabilityValue(higher, capability) as number,
          `${higher} must not lower ${capability}`,
        ).toBeGreaterThanOrEqual(capabilityValue(lower, capability) as number);
      }
    }
  });

  it('gives Pro everything Basic has, and Elite everything Pro has', () => {
    const included = (tier: SubscriptionTier) =>
      BOOLEAN_CAPABILITIES.filter((capability) => hasCapability(tier, capability));

    expect(included('pro')).toEqual(expect.arrayContaining(included('basic')));
    expect(included('elite')).toEqual(expect.arrayContaining(included('pro')));
    // …and each rung is a strict superset, so the ladder is not three copies.
    expect(included('pro').length).toBeGreaterThan(included('basic').length);
    expect(included('elite').length).toBeGreaterThan(included('pro').length);
  });

  it('places every boolean capability on exactly one rung of the ladder', () => {
    for (const capability of BOOLEAN_CAPABILITIES) {
      const required = requiredTierFor(capability);
      expect(required, `${capability} belongs to no plan`).not.toBeNull();
      // Everything from the required tier upwards has it; nothing below does.
      const from = subscriptionTiers.indexOf(required as SubscriptionTier);
      subscriptionTiers.forEach((tier, index) => {
        expect(hasCapability(tier, capability), `${tier} · ${capability}`).toBe(index >= from);
      });
    }
  });

  it('enforces the published tier matrix', () => {
    const proOnly: SubscriptionCapability[] = [
      'portfolio.options.create', 'portfolio.multiple.create', 'chart.sr.context', 'chart.vpvr',
      'simulator.what_if', 'options.chain.basic', 'options.signal.summary',
    ];
    const eliteOnly: SubscriptionCapability[] = [
      'simulator.monte_carlo', 'options.analytics.walls', 'options.chain.advanced',
      'options.greeks.full', 'options.expected_move', 'options.signal.breakdown',
      'technical.outlook',
    ];

    for (const capability of proOnly) {
      expect(requiredTierFor(capability), capability).toBe('pro');
    }
    for (const capability of eliteOnly) {
      expect(requiredTierFor(capability), capability).toBe('elite');
    }
    expect(requiredTierFor('chart.sr.levels')).toBe('basic');
    expect(capabilityValue('basic', 'portfolio.stock.max_count')).toBe(1);
    expect(capabilityValue('basic', 'portfolio.options.max_count')).toBe(0);
    expect(capabilityValue('pro', 'portfolio.stock.max_count')).toBe(10);
    expect(capabilityValue('pro', 'portfolio.options.max_count')).toBe(10);
  });
});

describe('effective access tier across every reader', () => {
  it.each(PERSONAS.map((subject) => [subject.label, subject] as const))(
    '%s resolves to one access tier and one subscription tier',
    (_label, subject) => {
      const access = accessFor(subject);
      expect(access.effectiveAccessTier).toBe(subject.expectedAccessTier);
      expect(access.subscriptionEffectiveTier).toBe(subject.expectedSubscriptionTier);
      expect(access.isAdmin).toBe(subject.role === 'admin');
    },
  );

  it.each(PERSONAS.map((subject) => [subject.label, subject] as const))(
    '%s opens exactly the capabilities of its access tier',
    (_label, subject) => {
      const { effectiveAccessTier } = accessFor(subject);
      for (const capability of CAPABILITIES) {
        expect(
          capabilityValue(effectiveAccessTier, capability),
          `${subject.label} · ${capability}`,
        ).toEqual(subscriptionCapabilities[subject.expectedAccessTier][capability]);
      }
    },
  );

  it.each(PERSONAS.map((subject) => [subject.label, subject] as const))(
    '%s is refused by the request guard on exactly what it lacks',
    (_label, subject) => {
      const tier = accessFor(subject).effectiveAccessTier;
      for (const capability of BOOLEAN_CAPABILITIES) {
        const denial = denyEntitlement({ authenticated: true, tier }, capability);
        if (hasCapability(subject.expectedAccessTier, capability)) {
          expect(denial, `${subject.label} · ${capability}`).toBeNull();
        } else {
          expect(denial?.code, `${subject.label} · ${capability}`).toBe('UPGRADE_REQUIRED');
          expect(denial?.status).toBe(403);
          expect(denial?.requiredTier).toBe(requiredTierFor(capability));
        }
      }
    },
  );

  it('never lets a preview alter the plan the account holds', () => {
    const stored = SUBSCRIPTIONS.basic;
    for (const mode of ['basic', 'pro', 'elite', 'elite_trial', 'expired_trial'] as const) {
      const access = accessFor(admin(`preview ${mode}`, mode, 'basic'));
      expect(access.subscriptionEffectiveTier).toBe('basic');
      expect(access.role).toBe('admin');
      // The input record is the stored row; nothing above may have touched it.
      expect(stored).toEqual({ tier: 'basic', status: 'basic', trialEndsAt: null, currentPeriodEnd: null });
    }
  });
});

describe('the specific escalations this phase had to close', () => {
  it('gives an administrator whose stored plan is Basic full Elite access', () => {
    const access = accessFor(admin('Admin actual', 'actual', 'elite', null));
    expect(access.subscriptionEffectiveTier).toBe('basic');
    expect(access.effectiveAccessTier).toBe('elite');
    expect(hasCapability(access.effectiveAccessTier, 'portfolio.options.create')).toBe(true);
    expect(hasCapability(access.effectiveAccessTier, 'simulator.monte_carlo')).toBe(true);
  });

  it('holds an administrator previewing Pro to Basic + Pro and no further', () => {
    const tier = accessFor(admin('Admin Pro preview', 'pro', 'pro')).effectiveAccessTier;
    expect(hasCapability(tier, 'portfolio.options.create')).toBe(true);
    expect(hasCapability(tier, 'chart.vpvr')).toBe(true);
    expect(hasCapability(tier, 'chart.sr.context')).toBe(true);
    expect(hasCapability(tier, 'options.signal.summary')).toBe(true);
    expect(hasCapability(tier, 'options.chain.basic')).toBe(true);
    expect(hasCapability(tier, 'simulator.what_if')).toBe(true);
    expect(hasCapability(tier, 'chart.sr.levels')).toBe(true);

    expect(hasCapability(tier, 'simulator.monte_carlo')).toBe(false);
    expect(hasCapability(tier, 'options.analytics.walls')).toBe(false);
    expect(hasCapability(tier, 'options.signal.breakdown')).toBe(false);
    expect(hasCapability(tier, 'options.greeks.full')).toBe(false);
    expect(hasCapability(tier, 'options.expected_move')).toBe(false);
    expect(hasCapability(tier, 'technical.outlook')).toBe(false);
    expect(hasCapability(tier, 'options.chain.advanced')).toBe(false);
  });

  it('holds an administrator previewing Basic to Basic alone', () => {
    for (const mode of ['basic', 'expired_trial'] as const) {
      const tier = accessFor(admin(`preview ${mode}`, mode, 'basic')).effectiveAccessTier;
      expect(tier).toBe('basic');
      for (const capability of BOOLEAN_CAPABILITIES) {
        expect(hasCapability(tier, capability), `${mode} · ${capability}`)
          .toBe(requiredTierFor(capability) === 'basic');
      }
    }
  });

  it('gives an ordinary reader no route to administrator access', () => {
    for (const mode of ['actual', 'elite', 'elite_trial', 'pro'] as const) {
      const access = accessFor(persona('forged preview', SUBSCRIPTIONS.basic, 'basic', 'basic', {
        previewMode: mode,
        previewExpiresAt: FUTURE,
      }));
      expect(access.isAdmin).toBe(false);
      expect(access.adminPreviewMode).toBe('actual');
      expect(access.effectiveAccessTier).toBe('basic');
    }
  });
});

describe('portfolio limits follow the access tier', () => {
  const portfolio = (id: string, type: 'STOCK' | 'OPTION' | 'LEGACY') =>
    ({ id, type, archivedAt: null });

  it.each([
    ['Basic subscriber', 'basic', 1, false, 0],
    ['Admin Basic preview', 'basic', 1, false, 0],
    ['Pro subscriber', 'pro', 10, true, 10],
    ['Admin Pro preview', 'pro', 10, true, 10],
    ['Elite subscriber', 'elite', 10, true, 10],
    ['Admin actual', 'elite', 10, true, 10],
  ] as const)('%s gets %s limits', (_label, tier, stockMax, optionsCreate, optionsMax) => {
    expect(portfolioCreationEntitlement(tier, 'STOCK')).toEqual({ canCreate: true, maxCount: stockMax });
    expect(portfolioCreationEntitlement(tier, 'OPTION'))
      .toEqual({ canCreate: optionsCreate, maxCount: optionsMax });
  });

  it('locks Options and the second stock portfolio for every Basic-access reader', () => {
    const first = portfolio('first', 'STOCK');
    const second = portfolio('second', 'STOCK');
    const options = portfolio('options', 'OPTION');
    const legacy = portfolio('legacy', 'LEGACY');

    expect(portfolioWriteBlock('basic', first, 'first')).toBeNull();
    expect(portfolioWriteBlock('basic', legacy, 'first')).toBeNull();
    expect(portfolioWriteBlock('basic', second, 'first')).toBe('read-only');
    expect(portfolioWriteBlock('basic', options, 'first')).toBe('upgrade');

    for (const tier of ['pro', 'elite'] as const) {
      for (const item of [first, second, options, legacy]) {
        expect(portfolioWriteBlock(tier, item, 'first'), `${tier} · ${item.id}`).toBeNull();
      }
    }
  });
});

describe('response shaping follows the access tier', () => {
  const workspace = {
    simulationType: 'monte-carlo' as const,
    resultSnapshot: {
      whatIf: { value: 1 },
      monteCarlo: { paths: 1000 },
    },
  };

  it.each([
    ['basic', null],
    ['pro', { whatIf: { value: 1 } }],
    ['elite', { whatIf: { value: 1 }, monteCarlo: { paths: 1000 } }],
  ] as const)('strips a saved %s simulation to what the tier may hold', (tier, expected) => {
    const shaped = shapeSimulationForTier(workspace as never, tier);
    expect((shaped as typeof workspace).resultSnapshot).toEqual(expected);
  });

  it('drops the Elite snapshot the moment access falls back to Pro or Basic', () => {
    for (const subject of PERSONAS) {
      const tier = accessFor(subject).effectiveAccessTier;
      const shaped = shapeSimulationForTier(workspace as never, tier) as typeof workspace;
      const carriesMonteCarlo = shaped.resultSnapshot?.monteCarlo !== undefined;
      expect(carriesMonteCarlo, `${subject.label} carried a Monte Carlo snapshot`)
        .toBe(hasCapability(tier, 'simulator.monte_carlo'));
      expect(optionsChainProjectionFor(tier).fullGreeks)
        .toBe(hasCapability(tier, 'options.greeks.full'));
    }
  });
});
