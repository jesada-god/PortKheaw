import 'server-only';

import { revalidatePath } from 'next/cache';

/**
 * Invalidate every surface whose render depends on what the reader may open.
 *
 * Everything under the root layout, because access changes what the layout
 * itself renders — the admin preview banner — and what every page beneath it is
 * allowed to show. Path-by-path invalidation would leave dynamic segments such
 * as `/stock/[symbol]` holding a cached premium render from the previous tier.
 *
 * This lives in its own module because two very different things must perform
 * exactly the same invalidation and must not drift apart: the administrator
 * preview action, and the billing webhook that activates or ends a paid plan.
 */
export function revalidateEveryEntitlementSurface(): void {
  revalidatePath('/', 'layout');
}
