/**
 * Paywall telemetry.
 *
 * There is no analytics client in this app and Phase 3 does not add one, so the
 * two events are emitted in the same structured-log shape the subscription
 * server action already uses: an event name and typed fields, nothing that
 * identifies a reader.
 *
 * `paywall_viewed` fires once per capability+source per prompt, not once per
 * render — a modal that re-renders while open is still one view.
 */

import type { SubscriptionCapability } from './capabilities';
import type { SubscriptionTier } from './subscription-types';

export type PaywallEventName = 'paywall_viewed' | 'upgrade_clicked';

export interface PaywallEvent {
  event: PaywallEventName;
  capability: SubscriptionCapability;
  /** Where in the product the prompt came from, e.g. `chart.vpvr-toggle`. */
  source: string;
  requiredTier: SubscriptionTier;
  currentTier: SubscriptionTier;
}

export function formatPaywallEvent(event: PaywallEvent): string {
  return JSON.stringify(event);
}

/** Test seam: the sink the events are written to. */
export type PaywallEventSink = (line: string) => void;

let sink: PaywallEventSink = (line) => console.info(line);

export function setPaywallEventSink(next: PaywallEventSink | null): void {
  sink = next ?? ((line) => console.info(line));
}

export function recordPaywallEvent(event: PaywallEvent): void {
  sink(formatPaywallEvent(event));
}
