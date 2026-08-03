import { NextResponse } from 'next/server';
import { z } from 'zod';
import { computeMonteCarlo } from '@/src/lib/options-simulator/server-compute';
import type { MonteCarloSettings, SimulationWorkspace } from '@/src/lib/options-simulator/types';
import { monteCarloSettingsSchema, simulationWorkspaceSchema } from '@/src/lib/options-simulator/validation';
import { withEntitledCacheHeaders } from '@/src/lib/subscription/entitled-response';
import { guardRouteEntitlement } from '@/src/lib/subscription/server-entitlement';

export const maxDuration = 60;

const MAX_BODY_BYTES = 500_000;
const requestSchema = z.object({
  workspace: simulationWorkspaceSchema,
  comparisonWorkspace: simulationWorkspaceSchema,
  settings: monteCarloSettingsSchema,
  targetPrice: z.number().finite().positive().max(1_000_000_000),
}).strict();

export async function POST(request: Request) {
  const gate = await guardRouteEntitlement('simulator.monte_carlo');
  if (gate.denied) return gate.denied;

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return withEntitledCacheHeaders(NextResponse.json({ data: null, error: { code: 'payload-too-large', message: 'Payload too large' } }, { status: 413 }), gate.entitlement.tier);
  }
  let body: unknown = null;
  try { body = JSON.parse(raw); } catch { /* schema response below */ }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return withEntitledCacheHeaders(NextResponse.json({ data: null, error: { code: 'invalid-simulation', message: 'Invalid simulation', issues: parsed.error.issues } }, { status: 400 }), gate.entitlement.tier);
  }

  try {
    const data = computeMonteCarlo(
      parsed.data.workspace as SimulationWorkspace,
      parsed.data.comparisonWorkspace as SimulationWorkspace,
      parsed.data.settings as MonteCarloSettings,
      parsed.data.targetPrice,
    );
    return withEntitledCacheHeaders(NextResponse.json({ data }), gate.entitlement.tier);
  } catch {
    return withEntitledCacheHeaders(NextResponse.json({ data: null, error: { code: 'calculation-failed', message: 'Unable to calculate simulation' } }, { status: 422 }), gate.entitlement.tier);
  }
}
