import { NextResponse } from 'next/server';
import { z } from 'zod';
import { StockPlansRepository } from '@/src/lib/tools/stock-plan-repository';
import {
  horizonIsFuture,
  stockPlanUpdateSchema,
  updateKeepsOrdering,
} from '@/src/lib/tools/stock-plan-schema';
import { planToday } from '@/src/lib/tools/stock-plan-outlook';
import { createClient } from '@/src/lib/supabase/server';
import { withEntitledCacheHeaders } from '@/src/lib/subscription/entitled-response';
import { guardRouteEntitlement } from '@/src/lib/subscription/server-entitlement';

/**
 * One saved plan — edit and archive.
 *
 * Two things this file is careful about.
 *
 * **The baseline never moves.** There are three independent reasons an edit
 * cannot change it, and they were not written as belt-and-braces for their own
 * sake — each one fails differently. The request schema has no field for it, so a
 * caller cannot express it. The repository's `Update` type omits the column, so
 * code cannot set it. The table has a trigger that raises
 * `STOCK_PLAN_BASELINE_IMMUTABLE`, so nothing reaching the database by any route
 * can either. The edited levels are then checked against the *stored* baseline,
 * which is the only number they have to make sense against.
 *
 * **Ownership is never taken from the URL.** The id in the path selects a row; it
 * never identifies a person. The repository scopes every statement to the
 * session's own `user_id`, and row level security scopes it again, so another
 * account's plan id returns "not found" rather than somebody else's plan.
 */

const CAPABILITY = 'planner.stock' as const;
const paramsSchema = z.object({ id: z.string().uuid() });

async function authenticatedRepository() {
  const client = await createClient();
  if (!client) return null;
  const { data: { user } } = await client.auth.getUser();
  return user ? new StockPlansRepository(client, user.id) : null;
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await guardRouteEntitlement(CAPABILITY);
  if (gate.denied) return gate.denied;
  const tier = gate.entitlement.tier;

  const params = paramsSchema.safeParse(await context.params);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 10_000) {
    return withEntitledCacheHeaders(NextResponse.json({ error: 'Payload too large' }, { status: 413 }), tier);
  }
  let body: unknown = null;
  try { body = JSON.parse(raw); } catch { /* the schema answers below */ }
  const parsed = stockPlanUpdateSchema.safeParse(body);
  if (!params.success || !parsed.success) {
    return withEntitledCacheHeaders(
      NextResponse.json({ error: 'แผนไม่ถูกต้อง', issues: parsed.success ? [] : parsed.error.issues }, { status: 400 }),
      tier,
    );
  }
  if (!horizonIsFuture(parsed.data.horizonDate, planToday())) {
    return withEntitledCacheHeaders(
      NextResponse.json({ error: 'ระยะเวลาของแผนต้องเป็นวันในอนาคต' }, { status: 400 }),
      tier,
    );
  }

  const repository = await authenticatedRepository();
  if (!repository) {
    return withEntitledCacheHeaders(NextResponse.json({ error: 'Authentication required' }, { status: 401 }), tier);
  }

  try {
    // Read the stored baseline first: the edited levels are judged against the
    // price the plan was actually made at, not against anything the caller sent.
    const baseline = await repository.baselineOf(params.data.id);
    if (baseline === null) {
      return withEntitledCacheHeaders(NextResponse.json({ error: 'ไม่พบแผนนี้' }, { status: 404 }), tier);
    }
    const ordering = updateKeepsOrdering(parsed.data, baseline);
    if (!ordering.ok) {
      return withEntitledCacheHeaders(NextResponse.json({ error: ordering.message }, { status: 400 }), tier);
    }
    const updated = await repository.update(params.data.id, parsed.data);
    return updated
      ? withEntitledCacheHeaders(NextResponse.json({ data: updated }), tier)
      : withEntitledCacheHeaders(NextResponse.json({ error: 'ไม่พบแผนนี้' }, { status: 404 }), tier);
  } catch {
    return withEntitledCacheHeaders(NextResponse.json({ error: 'ยังแก้ไขแผนไม่ได้' }, { status: 503 }), tier);
  }
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await guardRouteEntitlement(CAPABILITY);
  if (gate.denied) return gate.denied;
  const tier = gate.entitlement.tier;

  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) {
    return withEntitledCacheHeaders(NextResponse.json({ error: 'รหัสแผนไม่ถูกต้อง' }, { status: 400 }), tier);
  }
  const repository = await authenticatedRepository();
  if (!repository) {
    return withEntitledCacheHeaders(NextResponse.json({ error: 'Authentication required' }, { status: 401 }), tier);
  }
  try {
    const archived = await repository.archive(params.data.id);
    return withEntitledCacheHeaders(
      archived ? new NextResponse(null, { status: 204 }) : NextResponse.json({ error: 'ไม่พบแผนนี้' }, { status: 404 }),
      tier,
    );
  } catch {
    return withEntitledCacheHeaders(NextResponse.json({ error: 'ยังลบแผนไม่ได้' }, { status: 503 }), tier);
  }
}
