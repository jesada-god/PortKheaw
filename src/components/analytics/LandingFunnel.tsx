'use client';

import { useEffect, useRef } from 'react';
import { recordClientFunnelEventAction } from '@/app/settings/subscription/funnel-actions';

/**
 * "Somebody who is not signed in looked at the product."
 *
 * The one event no server render can attribute, because there is no account to
 * attribute it to — so it is reported by the browser, which is also the only
 * place that can tell one anonymous visit from another.
 *
 * The reference it sends is minted per TAB and kept in `sessionStorage`, so it
 * dies with the tab. That is deliberate: a value that survived the session would
 * be a durable identifier for somebody who never signed up, which is exactly
 * what this product does not want to hold. What it buys is that a landing count
 * is a count of visits rather than a count of days.
 *
 * The ref is sanitized again server-side before it can reach a dedupe key, and
 * the action it calls can do nothing but insert one telemetry row.
 */
const SESSION_KEY = 'portkheaw-visit-ref';

function visitRef(): string | null {
  try {
    const existing = window.sessionStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const minted = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    window.sessionStorage.setItem(SESSION_KEY, minted);
    return minted;
  } catch {
    // Storage refused (private mode, blocked cookies). No event rather than a
    // reference that would collapse every visitor into one row.
    return null;
  }
}

export function LandingFunnel() {
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    const ref = visitRef();
    if (!ref) return;
    void recordClientFunnelEventAction('landing_viewed', null, null, ref);
  }, []);
  return null;
}
