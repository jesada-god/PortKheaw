import { describe, expect, it } from 'vitest';
import {
  BILLING_WEBHOOK_MAX_ATTEMPTS,
  billingRetryBackoffSeconds,
  webhookFailureDisposition,
} from './webhook-retry';

describe('backoff', () => {
  it('starts at a minute and doubles', () => {
    expect(billingRetryBackoffSeconds(1)).toBe(60);
    expect(billingRetryBackoffSeconds(2)).toBe(120);
    expect(billingRetryBackoffSeconds(3)).toBe(240);
    expect(billingRetryBackoffSeconds(4)).toBe(480);
  });

  it('is capped at an hour', () => {
    expect(billingRetryBackoffSeconds(20)).toBe(3_600);
    // An absurd attempt count must not overflow the shift into a nonsense delay.
    expect(billingRetryBackoffSeconds(1_000)).toBe(3_600);
  });

  it('clamps a nonsensical attempt number instead of returning a negative delay', () => {
    expect(billingRetryBackoffSeconds(0)).toBe(60);
    expect(billingRetryBackoffSeconds(-5)).toBe(60);
    expect(billingRetryBackoffSeconds(Number.NaN)).toBe(60);
  });
});

describe('what the endpoint answers after a failure', () => {
  it('asks the provider to retry while attempts remain', () => {
    expect(webhookFailureDisposition({ attemptCount: 1, status: 'retrying' })).toBe('retry');
    expect(webhookFailureDisposition({
      attemptCount: BILLING_WEBHOOK_MAX_ATTEMPTS - 1,
      status: 'retrying',
    })).toBe('retry');
  });

  it('stops asking once the bound is reached', () => {
    // Past this point a 500 keeps a provider hammering an endpoint that cannot
    // succeed, and providers disable endpoints that behave that way.
    expect(webhookFailureDisposition({
      attemptCount: BILLING_WEBHOOK_MAX_ATTEMPTS,
      status: 'retrying',
    })).toBe('dead_letter');
  });

  it('stays dead-lettered on a later redelivery', () => {
    expect(webhookFailureDisposition({ attemptCount: 1, status: 'dead_letter' })).toBe('dead_letter');
  });
});
