'use client';

import { useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { recordClientFunnelEventAction } from '@/app/settings/subscription/funnel-actions';

/**
 * Records that a reader came back from the provider's hosted checkout.
 *
 * This is the only place in the product that reads the checkout return
 * parameter, and it renders nothing. The subscription page must not read it —
 * a page anybody can type into their address bar must not be able to grant
 * anything, and the billing security contract asserts that the page does not
 * consult it. So the fact is observed here, where the only thing that can be
 * done with it is insert a telemetry row.
 *
 * What this component cannot do, by construction: it holds no entitlement state,
 * imports nothing from the subscription or billing libraries, and calls one
 * server action whose key allowlist refuses every money event. A visitor typing
 * `?checkout=success` produces one funnel row and no change to anything.
 *
 * The ref makes it once per mount; the database makes it once per account per
 * day. Both are needed — React may run an effect twice in development, and a
 * reader may reload the return URL all afternoon.
 */
export function CheckoutReturnFunnel() {
  const params = useSearchParams();
  const outcome = params.get('checkout');
  const recorded = useRef<string | null>(null);

  useEffect(() => {
    if (outcome !== 'success' && outcome !== 'cancelled') return;
    if (recorded.current === outcome) return;
    recorded.current = outcome;

    void recordClientFunnelEventAction(
      outcome === 'success' ? 'checkout_returned' : 'checkout_canceled',
    );
  }, [outcome]);

  return null;
}
