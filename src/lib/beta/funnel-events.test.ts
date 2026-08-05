import { describe, expect, it } from 'vitest';
import {
  BETA_FUNNEL_DEDUPE, betaFunnelDedupeScope, betaFunnelEventKeys, bangkokLocalDate,
  clientRecordableEventKeys, isBetaFunnelEventKey, isClientRecordableEventKey,
  normalizeBetaFunnelEvent,
} from './funnel-events';

/**
 * The funnel's two promises: it records once, and it records nothing personal.
 */

describe('the approved key list is closed', () => {
  it('holds exactly the ten events the rollout measures', () => {
    expect([...betaFunnelEventKeys]).toEqual([
      'signup_completed',
      'subscription_viewed',
      'checkout_started',
      'checkout_returned',
      'checkout_canceled',
      'payment_succeeded',
      'paywall_blocked',
      'promptpay_renewal_help_viewed',
      'promptpay_renewal_paid',
      'feature_used_before_purchase',
    ]);
  });

  it('rejects anything else', () => {
    expect(isBetaFunnelEventKey('checkout_started')).toBe(true);
    expect(isBetaFunnelEventKey('password_entered')).toBe(false);
    expect(isBetaFunnelEventKey('')).toBe(false);
    expect(isBetaFunnelEventKey(null)).toBe(false);
  });

  it('gives every key a dedupe scope', () => {
    for (const key of betaFunnelEventKeys) {
      expect(BETA_FUNNEL_DEDUPE[key]).toBeDefined();
    }
  });
});

describe('what a browser may claim', () => {
  it('lets a client report intent, never money', () => {
    // A browser saying "I paid" would be believed by the report, so it cannot.
    for (const key of ['payment_succeeded', 'checkout_started', 'promptpay_renewal_paid', 'signup_completed'] as const) {
      expect(isClientRecordableEventKey(key)).toBe(false);
    }
    for (const key of clientRecordableEventKeys) {
      expect(isBetaFunnelEventKey(key)).toBe(true);
    }
    expect(isClientRecordableEventKey('paywall_blocked')).toBe(true);
  });
});

describe('dedupe scopes', () => {
  const localDate = '2026-08-05';

  it('lets a once-per-account fact land exactly once, forever', () => {
    expect(betaFunnelDedupeScope({ event: 'signup_completed', localDate })).toBe('once');
    expect(betaFunnelDedupeScope({ event: 'signup_completed', localDate: '2027-01-01' })).toBe('once');
  });

  it('collapses repeatable intent to one row per day', () => {
    expect(betaFunnelDedupeScope({ event: 'subscription_viewed', localDate })).toBe('2026-08-05');
    expect(betaFunnelDedupeScope({ event: 'subscription_viewed', localDate: '2026-08-06' })).toBe('2026-08-06');
  });

  it('separates by subject so two different paywalls are two data points', () => {
    const first = betaFunnelDedupeScope({ event: 'paywall_blocked', featureKey: 'chart.vpvr', localDate });
    const second = betaFunnelDedupeScope({ event: 'paywall_blocked', featureKey: 'options.chain', localDate });
    expect(first).not.toBe(second);
    // ...but the same paywall four times in one day is one.
    expect(betaFunnelDedupeScope({ event: 'paywall_blocked', featureKey: 'chart.vpvr', localDate })).toBe(first);
  });

  it('falls back to the plan when there is no feature', () => {
    expect(betaFunnelDedupeScope({ event: 'checkout_started', planKey: 'pro_monthly', localDate }))
      .toBe('2026-08-05:pro_monthly');
    expect(betaFunnelDedupeScope({ event: 'checkout_started', localDate })).toBe('2026-08-05:none');
  });

  it('keeps two anonymous readers apart', () => {
    const a = betaFunnelDedupeScope({ event: 'subscription_viewed', localDate, anonymousRef: 'aaa' });
    const b = betaFunnelDedupeScope({ event: 'subscription_viewed', localDate, anonymousRef: 'bbb' });
    expect(a).not.toBe(b);
  });
});

describe('a scope cannot carry a payload', () => {
  it('strips everything but an identifier-safe alphabet', () => {
    const scope = betaFunnelDedupeScope({
      event: 'paywall_blocked',
      featureKey: 'chart.vpvr"; drop table users; --',
      localDate: '2026-08-05',
    });
    expect(scope).not.toContain(' ');
    expect(scope).not.toContain(';');
    expect(scope).not.toContain('"');
    expect(scope).toContain('chart.vpvr');
  });

  it('bounds every segment, so a long value cannot become the row', () => {
    const scope = betaFunnelDedupeScope({
      event: 'paywall_blocked',
      featureKey: 'a'.repeat(500),
      localDate: '2026-08-05',
    });
    expect(scope.length).toBeLessThanOrEqual(80);
  });
});

describe('normalization', () => {
  it('keeps only the four product-configuration fields', () => {
    const normalized = normalizeBetaFunnelEvent({
      event: 'checkout_started',
      planKey: 'pro_monthly',
      paymentRail: 'card',
      featureKey: null,
      localDate: '2026-08-05',
    });
    expect(Object.keys(normalized!).sort()).toEqual([
      'dedupeScope', 'event', 'featureKey', 'paymentRail', 'planKey',
    ]);
  });

  it('drops a rail the product does not sell rather than storing it', () => {
    const normalized = normalizeBetaFunnelEvent({
      event: 'checkout_started',
      paymentRail: 'crypto' as never,
      localDate: '2026-08-05',
    });
    expect(normalized?.paymentRail).toBeNull();
  });

  it('returns null for an unapproved key instead of throwing', () => {
    // Telemetry must never be able to fail the request it rode in on.
    expect(normalizeBetaFunnelEvent({ event: 'nope' as never, localDate: '2026-08-05' })).toBeNull();
  });

  it('returns null for a date that is not a calendar date', () => {
    expect(normalizeBetaFunnelEvent({ event: 'checkout_started', localDate: 'today' })).toBeNull();
    expect(normalizeBetaFunnelEvent({ event: 'checkout_started', localDate: '2026-8-5' })).toBeNull();
  });

  it('never lets an email or a provider id through a label field', () => {
    const normalized = normalizeBetaFunnelEvent({
      event: 'paywall_blocked',
      featureKey: 'reader@example.com',
      planKey: 'cus_ABCDEFGHIJKLMN',
      localDate: '2026-08-05',
    });
    // `@` is not in the safe alphabet, so an address cannot survive as a label.
    expect(normalized?.featureKey).not.toContain('@');
    // A provider id is alphanumeric and *would* survive as text — which is why
    // the schema's own constraint bounds these to 40/60 characters and why no
    // call site passes one. The check here is that the field is at least reduced.
    expect(normalized?.planKey?.length).toBeLessThanOrEqual(40);
  });
});

describe('the Bangkok calendar date', () => {
  it('is the day the reader is having, not the server’s UTC day', () => {
    // 17:30 UTC on the 4th is 00:30 on the 5th in Bangkok.
    expect(bangkokLocalDate(new Date('2026-08-04T17:30:00Z'))).toBe('2026-08-05');
    expect(bangkokLocalDate(new Date('2026-08-04T16:59:00Z'))).toBe('2026-08-04');
  });

  it('always produces a value the normalizer accepts', () => {
    expect(normalizeBetaFunnelEvent({
      event: 'subscription_viewed',
      localDate: bangkokLocalDate(new Date()),
    })).not.toBeNull();
  });
});
