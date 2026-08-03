/**
 * Response shaping for the options chain.
 *
 * The premium columns are removed on the SERVER, before the payload is
 * serialized. A tier without `options.greeks.full` never receives an implied
 * volatility or a Greek at all — not hidden, not blurred, not present. That also
 * removes the two analytics those numbers are the only input to (ATM IV and
 * Expected Move), so there is nothing left in the payload to derive them from.
 *
 * Everything the basic ledger is made of — strike, expiration, bid, ask, last,
 * mark, volume, open interest, moneyness and provenance — is untouched, because
 * that is exactly what the Pro plan sells.
 */

import type { SubscriptionTier } from '@/src/lib/subscription/subscription-types';
import { hasCapability } from '@/src/lib/subscription/capabilities';
import type {
  GatedOptionsChain,
  OptionContract,
  OptionLedgerContract,
  OptionsChain,
} from './contracts';

/** The fields withheld from a tier without full Greeks. */
export const GREEK_FIELDS = ['impliedVolatility', 'delta', 'gamma', 'theta', 'vega', 'rho'] as const;

export interface OptionsChainProjection {
  /** When false, IV and every Greek is omitted before serialization. */
  fullGreeks: boolean;
}

export function optionsChainProjectionFor(tier: SubscriptionTier): OptionsChainProjection {
  return { fullGreeks: hasCapability(tier, 'options.greeks.full') };
}

function stripContract(contract: OptionContract): OptionLedgerContract {
  const {
    impliedVolatility,
    delta,
    gamma,
    theta,
    vega,
    rho,
    valuationSource,
    ...ledger
  } = contract;
  void [impliedVolatility, delta, gamma, theta, vega, rho, valuationSource];
  return ledger;
}

/**
 * Project a chain onto what the tier may see. Returns the input unchanged when
 * nothing needs withholding, so the entitled path costs no copy.
 */
export function shapeOptionsChain(chain: OptionsChain, projection: OptionsChainProjection): GatedOptionsChain {
  if (projection.fullGreeks) return chain;
  return {
    ...chain,
    calls: chain.calls.map(stripContract),
    puts: chain.puts.map(stripContract),
  };
}

/** True when a contract still carries any withheld field — the leak assertion. */
export function carriesGreekFields(contract: OptionContract | OptionLedgerContract): boolean {
  return GREEK_FIELDS.some((field) => Object.hasOwn(contract, field))
    || Object.hasOwn(contract, 'valuationSource');
}

export function chainCarriesGreekFields(chain: GatedOptionsChain): boolean {
  return [...chain.calls, ...chain.puts].some(carriesGreekFields);
}
