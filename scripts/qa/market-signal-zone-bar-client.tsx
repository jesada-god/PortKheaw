/**
 * The browser half of the zone-bar QA.
 *
 * The bar decides whether two captions can stand apart by measuring the boxes
 * it drew, which means the arrangement a reader sees is the one React arrives
 * at AFTER hydration — a page of static markup is the arrangement the card
 * falls back to when nothing has been measured, and measuring that would be
 * measuring the fallback. So the same cards the server rendered are hydrated
 * here, the layout effect runs, and only then does the probe get to look.
 *
 * `data-hydrated` on the root element is the handshake. It is set after two
 * animation frames rather than at the end of this file because React 19
 * schedules hydration rather than performing it inline: the roots exist when
 * `hydrateRoot` returns, the committed DOM does not.
 */
import React from 'react';
import { hydrateRoot } from 'react-dom/client';
import { EntitlementProvider } from '@/src/components/subscription/EntitlementProvider';
import { MarketSignalSection } from '@/src/components/analytics/market-signal/MarketSignalSection';
import { CASES } from './market-signal-zone-bar-cases';

const byName = new Map(CASES.map((entry) => [entry.name, entry]));

for (const host of document.querySelectorAll<HTMLElement>('[data-hydrate]')) {
  const entry = byName.get(host.dataset.hydrate ?? '');
  if (!entry) continue;
  hydrateRoot(host, (
    <EntitlementProvider tier="elite" authenticated trialOffer="used">
      <MarketSignalSection result={entry.result} livePrice={entry.livePrice} />
    </EntitlementProvider>
  ));
}

requestAnimationFrame(() => requestAnimationFrame(() => {
  document.documentElement.dataset.hydrated = 'true';
}));
