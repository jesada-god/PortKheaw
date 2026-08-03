import { hasCapability, type SubscriptionCapability } from '@/src/lib/subscription/capabilities';
import type { SubscriptionTier } from '@/src/lib/subscription/subscription-types';
import type { SimulationWorkspace } from './types';

export function simulationCapability(workspace: SimulationWorkspace): SubscriptionCapability {
  return workspace.simulationType === 'monte-carlo' || workspace.resultSnapshot?.monteCarlo !== undefined
    ? 'simulator.monte_carlo'
    : 'simulator.what_if';
}

/**
 * Remove persisted premium outputs after a downgrade before they reach JSON.
 *
 * The two questions are asked of the capability matrix rather than of the tier
 * name, so this stays correct by construction if the ladder ever moves: a tier
 * that may run Monte Carlo keeps the whole snapshot, a tier that may run What-If
 * keeps only that half, and a tier that may run neither keeps nothing.
 */
export function shapeSimulationForTier<T extends SimulationWorkspace>(workspace: T, tier: SubscriptionTier): T {
  if (hasCapability(tier, 'simulator.monte_carlo')) return workspace;
  if (!hasCapability(tier, 'simulator.what_if')) return { ...workspace, resultSnapshot: null };

  const whatIf = workspace.resultSnapshot?.whatIf;
  return {
    ...workspace,
    resultSnapshot: whatIf === undefined ? null : { whatIf },
  };
}
