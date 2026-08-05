import 'server-only';

import { headers } from 'next/headers';

/**
 * A correlation id for one request.
 *
 * Every operator mutation records one, so an audit row and the structured log
 * line written beside it can be tied together after the fact — which is the
 * difference between "somebody changed the stage at 14:02" and "here is the
 * request that did it and everything else it touched".
 *
 * The platform's own id is preferred when present: correlating with Vercel's
 * logs is the point, and inventing a second identifier for the same request only
 * makes that harder. It identifies a request, never a person.
 */
export async function resolveRequestId(): Promise<string> {
  try {
    const store = await headers();
    const supplied = store.get('x-request-id') ?? store.get('x-vercel-id');
    const normalized = supplied?.trim().replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 64);
    if (normalized) return normalized;
  } catch {
    // Called outside a request scope — a scheduler tick, or a test. A generated
    // id is still useful for tying one run's rows together.
  }
  return `gen_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}
