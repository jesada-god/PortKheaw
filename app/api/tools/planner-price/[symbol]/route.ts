import { NextResponse } from 'next/server';
import { loadPlannerPrice } from '@/src/lib/tools/planner-market';
import { symbolSchema } from '@/src/lib/market-data/validation';
import { withEntitledCacheHeaders } from '@/src/lib/subscription/entitled-response';
import { guardRouteEntitlement } from '@/src/lib/subscription/server-entitlement';

/**
 * The Planner's read-only "ราคาปัจจุบัน", and the scope decision that comes with it.
 *
 * This route exists so the baseline the Planner shows is provably the Stock
 * Detail header's own number: it runs the same loader and the same canonical
 * resolver rather than a second interpretation of a quote. See
 * `src/lib/tools/planner-market.ts` — nothing here reaches a provider, opens a
 * socket or polls.
 *
 * It is entitlement-gated like the rest of the tool. The price itself is not a
 * secret — the same symbol's quote is public elsewhere in the app — but this is a
 * Planner surface, and a locked reader has no business exercising the Planner's
 * server work.
 *
 * A refused instrument (crypto, an index, an unclassified symbol) answers 200
 * with `unsupported` set and no price. That is the fail-safe the spec asks for: a
 * plain sentence the UI can print, rather than an error the form has to guess the
 * meaning of — and never a baseline for something the planner will not plan.
 */

export async function GET(_request: Request, context: { params: Promise<{ symbol: string }> }) {
  const gate = await guardRouteEntitlement('planner.stock');
  if (gate.denied) return gate.denied;
  const tier = gate.entitlement.tier;

  const parsed = symbolSchema.safeParse((await context.params).symbol);
  if (!parsed.success) {
    return withEntitledCacheHeaders(
      NextResponse.json({ error: 'สัญลักษณ์หุ้นไม่ถูกต้อง' }, { status: 400 }),
      tier,
    );
  }

  try {
    const price = await loadPlannerPrice(parsed.data);
    const response = withEntitledCacheHeaders(NextResponse.json({ data: price }), tier);
    // A baseline is read at the instant the reader opens the plan; it is never
    // stored by a shared cache and never reused for another session.
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch {
    return withEntitledCacheHeaders(
      NextResponse.json({ error: 'ยังดึงราคาล่าสุดของหุ้นตัวนี้ไม่ได้' }, { status: 503 }),
      tier,
    );
  }
}
