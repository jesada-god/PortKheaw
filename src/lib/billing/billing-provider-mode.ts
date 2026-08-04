/**
 * The payment provider environment is part of every billing identity.
 *
 * `legacy_unknown` is intentionally not a trusted runtime mode. It exists only
 * for records created before the environment was stored and must never be
 * guessed into either test or live.
 */
export const billingProviderModes = ['test', 'live', 'legacy_unknown'] as const;
export type BillingProviderMode = typeof billingProviderModes[number];

export const trustedBillingProviderModes = ['test', 'live'] as const;
export type TrustedBillingProviderMode = typeof trustedBillingProviderModes[number];

export function isTrustedBillingProviderMode(value: unknown): value is TrustedBillingProviderMode {
  return typeof value === 'string'
    && (trustedBillingProviderModes as readonly string[]).includes(value);
}

export function stripeLivemode(mode: TrustedBillingProviderMode): boolean {
  return mode === 'live';
}

export function stripeProviderMode(livemode: boolean): TrustedBillingProviderMode {
  return livemode ? 'live' : 'test';
}
