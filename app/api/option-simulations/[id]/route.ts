import { NextResponse } from 'next/server';
import { z } from 'zod';
import { OptionSimulationsRepository } from '@/src/lib/options-simulator/repository';
import type { SimulationWorkspace } from '@/src/lib/options-simulator/types';
import { shapeSimulationForTier, simulationCapability } from '@/src/lib/options-simulator/entitlement-shaping';
import { simulationWorkspaceSchema } from '@/src/lib/options-simulator/validation';
import { createClient } from '@/src/lib/supabase/server';
import { denyEntitlement } from '@/src/lib/subscription/entitlement-guard';
import { withEntitledCacheHeaders } from '@/src/lib/subscription/entitled-response';
import { entitlementDenialResponse, guardRouteEntitlement } from '@/src/lib/subscription/server-entitlement';

const paramsSchema = z.object({ id: z.string().uuid() });
async function contextRepository() {
  const client = await createClient();
  if (!client) return null;
  const { data: { user } } = await client.auth.getUser();
  return user ? new OptionSimulationsRepository(client, user.id) : null;
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await guardRouteEntitlement('simulator.what_if');
  if (gate.denied) return gate.denied;
  const params = paramsSchema.safeParse(await context.params);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 500_000) return withEntitledCacheHeaders(NextResponse.json({ error: 'Payload too large' }, { status: 413 }), gate.entitlement.tier);
  let body: { workspace?: unknown; expectedUpdatedAt?: unknown } | null;
  try { body = JSON.parse(raw) as { workspace?: unknown; expectedUpdatedAt?: unknown }; } catch { body = null; }
  const workspace = simulationWorkspaceSchema.safeParse(body?.workspace);
  const timestamp = z.iso.datetime().safeParse(body?.expectedUpdatedAt);
  if (!params.success || !workspace.success || !timestamp.success) return withEntitledCacheHeaders(NextResponse.json({ error: 'Invalid update' }, { status: 400 }), gate.entitlement.tier);
  const parsedWorkspace = workspace.data as SimulationWorkspace;
  const denial = denyEntitlement(gate.entitlement, simulationCapability(parsedWorkspace));
  if (denial) return entitlementDenialResponse(denial);
  const repository = await contextRepository();
  if (!repository) return withEntitledCacheHeaders(NextResponse.json({ error: 'Authentication required' }, { status: 401 }), gate.entitlement.tier);
  try {
    const updated = await repository.update(params.data.id, parsedWorkspace, timestamp.data);
    return updated
      ? withEntitledCacheHeaders(NextResponse.json({ data: shapeSimulationForTier(updated, gate.entitlement.tier) }), gate.entitlement.tier)
      : withEntitledCacheHeaders(NextResponse.json({ error: 'Simulation changed on another device', code: 'conflict' }, { status: 409 }), gate.entitlement.tier);
  } catch { return withEntitledCacheHeaders(NextResponse.json({ error: 'Unable to update simulation' }, { status: 503 }), gate.entitlement.tier); }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await guardRouteEntitlement('simulator.what_if');
  if (gate.denied) return gate.denied;
  const repository = await contextRepository();
  if (!repository) return withEntitledCacheHeaders(NextResponse.json({ error: 'Authentication required' }, { status: 401 }), gate.entitlement.tier);
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return withEntitledCacheHeaders(NextResponse.json({ error: 'Invalid simulation id' }, { status: 400 }), gate.entitlement.tier);
  try {
    const response = await repository.remove(params.data.id) ? new NextResponse(null, { status: 204 }) : NextResponse.json({ error: 'Not found' }, { status: 404 });
    return withEntitledCacheHeaders(response, gate.entitlement.tier);
  } catch { return withEntitledCacheHeaders(NextResponse.json({ error: 'Unable to delete simulation' }, { status: 503 }), gate.entitlement.tier); }
}
