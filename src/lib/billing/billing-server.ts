import 'server-only';

import { serverEnv } from '@/src/config/env/server';
import {
  billingAvailability,
  resolveBillingConfig,
  type BillingAvailability,
  type BillingConfig,
  type BillingConfigResult,
} from './billing-config';

/**
 * The one place the running process asks "is billing configured?".
 *
 * Memoized because the environment cannot change while the process lives, and
 * because a page, a server action and an API route may all ask within one
 * request. `resolveBillingConfig` itself stays pure and takes its environment as
 * an argument, so tests exercise every branch without touching `process.env`.
 */
let cached: BillingConfigResult | null = null;

export function billingConfigResult(): BillingConfigResult {
  cached ??= resolveBillingConfig(serverEnv);
  return cached;
}

/** The browser-safe projection: which plans can be bought, and nothing else. */
export function getBillingAvailability(): BillingAvailability {
  return billingAvailability(billingConfigResult());
}

/**
 * The configuration, or `null`. Callers must handle `null` — there is no throwing
 * accessor on purpose, because "billing is not configured" is an ordinary,
 * expected state of this product and not an exception.
 */
export function getBillingConfig(): BillingConfig | null {
  const result = billingConfigResult();
  return result.enabled ? result.config : null;
}

/**
 * A one-line, secret-free description of why billing is off, for server logs.
 * It names missing *variables*, never values, and is never returned to a browser.
 */
export function billingDisabledSummary(): string | null {
  const result = billingConfigResult();
  if (result.enabled) return null;
  return `billing disabled (${result.reason}): missing ${result.missing.join(', ') || 'none'}`;
}
