import type { SubscriptionCapability } from '@/src/lib/subscription/capabilities';
import type { SubscriptionTier } from '@/src/lib/subscription/subscription-types';
import type { SimulationWorkspace } from './types';

export function simulationCapability(workspace: SimulationWorkspace): SubscriptionCapability {
  return workspace.simulationType === 'monte-carlo' || workspace.resultSnapshot?.monteCarlo !== undefined
    ? 'simulator.monte_carlo'
    : 'simulator.what_if';
}

/** Remove persisted premium outputs after a downgrade before they reach JSON. */
export function shapeSimulationForTier<T extends SimulationWorkspace>(workspace: T, tier: SubscriptionTier): T {
  if (tier === 'elite') return workspace;
  if (tier === 'basic') return { ...workspace, resultSnapshot: null };

  const whatIf = workspace.resultSnapshot?.whatIf;
  return {
    ...workspace,
    resultSnapshot: whatIf === undefined ? null : { whatIf },
  };
}
