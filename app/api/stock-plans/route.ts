import { NextResponse } from 'next/server';
import { StockPlansRepository } from '@/src/lib/tools/stock-plan-repository';
import { horizonIsFuture, stockPlanCreateSchema } from '@/src/lib/tools/stock-plan-schema';
import { planToday } from '@/src/lib/tools/stock-plan-outlook';
import { createClient } from '@/src/lib/supabase/server';
import { withEntitledCacheHeaders } from '@/src/lib/subscription/entitled-response';
import { guardRouteEntitlement } from '@/src/lib/subscription/server-entitlement';

/**
 * Saved plans — list and create.
 *
 * `guardRouteEntitlement('planner.stock')` runs FIRST on every method, before the
 * body is read and before a session is looked up. The Stock Planner page already
 * refuses to render for a locked reader, but a page is not a gate: these routes
 * are reachable with `curl` and a Basic session, and this is the thing that
 * refuses them. The same capability decides the page, the card, the upgrade
 * prompt and this guard, so they cannot disagree about who is entitled.
 *
 * The entitlement gate governs *writing* plans, not owning them. A reader whose
 * Pro lapses is refused here and keeps every row they already saved — nothing in
 * this file or its table deletes on downgrade.
 */

const CAPABILITY = 'planner.stock' as const;

async function authenticatedRepository() {
  const client = await createClient();
  if (!client) return null;
  const { data: { user } } = await client.auth.getUser();
  return user ? new StockPlansRepository(client, user.id) : null;
}

export async function GET() {
  const gate = await guardRouteEntitlement(CAPABILITY);
  if (gate.denied) return gate.denied;
  const repository = await authenticatedRepository();
  if (!repository) {
    return withEntitledCacheHeaders(
      NextResponse.json({ error: 'Authentication required' }, { status: 401 }),
      gate.entitlement.tier,
    );
  }
  try {
    return withEntitledCacheHeaders(
      NextResponse.json({ data: await repository.list() }),
      gate.entitlement.tier,
    );
  } catch {
    return withEntitledCacheHeaders(
      NextResponse.json({ error: 'ยังโหลดแผนที่บันทึกไว้ไม่ได้' }, { status: 503 }),
      gate.entitlement.tier,
    );
  }
}

export async function POST(request: Request) {
  const gate = await guardRouteEntitlement(CAPABILITY);
  if (gate.denied) return gate.denied;

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > 10_000) {
    return withEntitledCacheHeaders(
      NextResponse.json({ error: 'Payload too large' }, { status: 413 }),
      gate.entitlement.tier,
    );
  }
  let body: unknown = null;
  try { body = JSON.parse(raw); } catch { /* the schema answers below */ }

  const parsed = stockPlanCreateSchema.safeParse(body);
  if (!parsed.success) {
    return withEntitledCacheHeaders(
      NextResponse.json({ error: 'แผนไม่ถูกต้อง', issues: parsed.error.issues }, { status: 400 }),
      gate.entitlement.tier,
    );
  }
  /*
    The horizon is judged against the server's own exchange-local today, never a
    date the caller sent. A client clock is a caller-supplied value like any
    other, and a plan that has already expired is not a plan.
  */
  if (!horizonIsFuture(parsed.data.horizonDate, planToday())) {
    return withEntitledCacheHeaders(
      NextResponse.json({ error: 'ระยะเวลาของแผนต้องเป็นวันในอนาคต' }, { status: 400 }),
      gate.entitlement.tier,
    );
  }

  const repository = await authenticatedRepository();
  if (!repository) {
    return withEntitledCacheHeaders(
      NextResponse.json({ error: 'Authentication required' }, { status: 401 }),
      gate.entitlement.tier,
    );
  }
  try {
    return withEntitledCacheHeaders(
      NextResponse.json({ data: await repository.create(parsed.data) }, { status: 201 }),
      gate.entitlement.tier,
    );
  } catch {
    return withEntitledCacheHeaders(
      NextResponse.json({ error: 'ยังบันทึกแผนไม่ได้' }, { status: 503 }),
      gate.entitlement.tier,
    );
  }
}
