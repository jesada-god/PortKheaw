import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { OptionSimulationsRepository } from '@/src/lib/options-simulator/repository';
import type { SimulationWorkspace } from '@/src/lib/options-simulator/types';
import { shapeSimulationForTier, simulationCapability } from '@/src/lib/options-simulator/entitlement-shaping';
import { simulationWorkspaceSchema } from '@/src/lib/options-simulator/validation';
import { createClient } from '@/src/lib/supabase/server';
import { denyEntitlement } from '@/src/lib/subscription/entitlement-guard';
import { withEntitledCacheHeaders } from '@/src/lib/subscription/entitled-response';
import { entitlementDenialResponse, guardRouteEntitlement } from '@/src/lib/subscription/server-entitlement';

async function authenticatedRepository() {
  const client = await createClient();
  if (!client) return null;
  const { data: { user } } = await client.auth.getUser();
  return user ? new OptionSimulationsRepository(client, user.id) : null;
}

export async function GET(request: NextRequest) {
  const gate = await guardRouteEntitlement('simulator.what_if');
  if (gate.denied) return gate.denied;
  const repository = await authenticatedRepository();
  if (!repository) return withEntitledCacheHeaders(NextResponse.json({ error: 'Authentication required' }, { status: 401 }), gate.entitlement.tier);
  const query = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(50).default(20) })
    .safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) return withEntitledCacheHeaders(NextResponse.json({ error: 'Invalid pagination' }, { status: 400 }), gate.entitlement.tier);
  try {
    const data = await repository.list(query.data.page, query.data.pageSize);
    return withEntitledCacheHeaders(NextResponse.json({ data: { ...data, items: data.items.map((item) => shapeSimulationForTier(item, gate.entitlement.tier)) } }), gate.entitlement.tier);
  } catch { return withEntitledCacheHeaders(NextResponse.json({ error: 'Unable to load simulations' }, { status: 503 }), gate.entitlement.tier); }
}

export async function POST(request: Request) {
  const gate = await guardRouteEntitlement('simulator.what_if');
  if (gate.denied) return gate.denied;
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 500_000) return withEntitledCacheHeaders(NextResponse.json({ error: 'Payload too large' }, { status: 413 }), gate.entitlement.tier);
  let body: unknown = null;
  try { body = JSON.parse(raw); } catch { /* schema response below */ }
  const parsed = simulationWorkspaceSchema.safeParse(body);
  if (!parsed.success) return withEntitledCacheHeaders(NextResponse.json({ error: 'Invalid simulation', issues: parsed.error.issues }, { status: 400 }), gate.entitlement.tier);
  const workspace = parsed.data as SimulationWorkspace;
  const denial = denyEntitlement(gate.entitlement, simulationCapability(workspace));
  if (denial) return entitlementDenialResponse(denial);
  const repository = await authenticatedRepository();
  if (!repository) return withEntitledCacheHeaders(NextResponse.json({ error: 'Authentication required' }, { status: 401 }), gate.entitlement.tier);
  try {
    const data = await repository.create(workspace);
    return withEntitledCacheHeaders(NextResponse.json({ data: shapeSimulationForTier(data, gate.entitlement.tier) }, { status: 201 }), gate.entitlement.tier);
  } catch { return withEntitledCacheHeaders(NextResponse.json({ error: 'Unable to save simulation' }, { status: 503 }), gate.entitlement.tier); }
}
