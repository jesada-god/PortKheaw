import { recordBetaFunnelEvent } from '@/src/lib/beta/beta-server';
import SimulatorWorkspace from '@/src/components/options-simulator/SimulatorWorkspace';

/*
 * One telemetry row per account per day, naming the tool and nothing else. It
 * sits in the page rather than the workspace so it counts an opening rather than
 * a re-render, and it is fire-and-forget: a tool must never fail to open because
 * a counter did.
 */
export default function MonteCarloPage() {
  void recordBetaFunnelEvent({ event: 'tool_opened', featureKey: 'monte-carlo' }).catch(() => {});
  return <SimulatorWorkspace initialType="monte-carlo" />;
}
