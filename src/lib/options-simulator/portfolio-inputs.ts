import type { OptionLeg, SimulationWorkspace } from './types';

export interface ProfitLossBasis {
  amount: number | null;
  policy: 'absolute-net-debit' | 'gross-premium-at-risk' | 'unavailable';
}

/** Input-only display policy. It performs no option pricing. */
export function portfolioProfitLossBasis(workspace: Pick<SimulationWorkspace, 'legs'>): ProfitLossBasis {
  const netDebitCredit = workspace.legs.reduce((sum, leg) => (
    sum + (leg.side === 'buy' ? 1 : -1) * leg.entryPremium * leg.quantity * leg.multiplier + leg.fees
  ), 0);
  if (Number.isFinite(netDebitCredit) && netDebitCredit > 0) {
    return { amount: Math.abs(netDebitCredit), policy: 'absolute-net-debit' };
  }

  const grossPremiumAtRisk = workspace.legs.reduce((sum, leg) => (
    sum + Math.abs(leg.entryPremium * leg.quantity * leg.multiplier) + leg.fees
  ), 0);
  if (Number.isFinite(grossPremiumAtRisk) && grossPremiumAtRisk > 0) {
    return { amount: grossPremiumAtRisk, policy: 'gross-premium-at-risk' };
  }
  return { amount: null, policy: 'unavailable' };
}

/** Strategy naming from entered legs only; no model values are produced. */
export function detectStrategy(legs: OptionLeg[], stockQuantity = 0): string {
  const calls = legs.filter((leg) => leg.kind === 'call');
  const puts = legs.filter((leg) => leg.kind === 'put');
  if (legs.length === 1 && stockQuantity > 0 && calls[0]?.side === 'sell') return 'Covered Call';
  if (legs.length === 1 && stockQuantity > 0 && puts[0]?.side === 'buy') return 'Protective Put';
  if (legs.length === 1) return `${legs[0].side === 'buy' ? 'Long' : 'Short'} ${legs[0].kind === 'call' ? 'Call' : 'Put'}`;
  if (legs.length === 2 && calls.length === 1 && puts.length === 1 && legs.every((leg) => leg.side === 'buy')) {
    return calls[0].strike === puts[0].strike ? 'Straddle' : 'Strangle';
  }
  if (legs.length === 2 && (calls.length === 2 || puts.length === 2) && new Set(legs.map((leg) => leg.side)).size === 2) return 'Vertical Spread';
  if (legs.length === 4 && calls.length === 2 && puts.length === 2) return 'Iron Condor';
  if (legs.length === 3 && (calls.length === 3 || puts.length === 3)) return 'Butterfly';
  return 'Custom Multi-Leg';
}
