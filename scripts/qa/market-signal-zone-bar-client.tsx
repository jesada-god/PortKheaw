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
 * `data-hydrated` on the root element is the handshake, AND IT IS COUNTED
 * RATHER THAN TIMED.
 *
 * It used to be two animation frames after the last `hydrateRoot` call
 * returned, which is not the same event: React 19 schedules hydration rather
 * than performing it inline, so the roots exist at that point and the committed
 * DOM does not. With a handful of cards on the page the two frames happened to
 * be enough; adding one more card pushed the last card's commit past them, and
 * the probe measured that card in the arrangement the bar falls back to having
 * measured nothing — two captions centred on marks 3% apart, i.e. on top of
 * each other, and two marks drawn 2px apart because the collapse rule had no
 * track to run on. A picture no reader ever sees, reported as the picture.
 *
 * That is the exact failure this whole file exists to prevent, arrived at from
 * the other end: not "the harness forgot to hydrate" but "the harness did not
 * wait for it". So each root now REPORTS its own commit, and the flag is set
 * two frames after the last of them. A timing assumption that was silently
 * load-bearing is now an accounting of events that actually happened.
 *
 * `useEffect` and not `useLayoutEffect`: the zone bar measures in a layout
 * effect and re-renders from what it read, and passive effects flush after
 * that work. A root that has reported here has therefore already been through
 * its measured render.
 */
import React, { useEffect } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { EntitlementProvider } from '@/src/components/subscription/EntitlementProvider';
import { MarketSignalSection } from '@/src/components/analytics/market-signal/MarketSignalSection';
import { CASES } from './market-signal-zone-bar-cases';

const byName = new Map(CASES.map((entry) => [entry.name, entry]));

function Committed({ onCommit, children }: { onCommit: () => void; children: React.ReactNode }) {
  useEffect(() => { onCommit(); }, [onCommit]);
  return <>{children}</>;
}

const hosts = [...document.querySelectorAll<HTMLElement>('[data-hydrate]')]
  .filter((host) => byName.has(host.dataset.hydrate ?? ''));

let pending = hosts.length;
const commit = () => {
  pending -= 1;
  if (pending > 0) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.documentElement.dataset.hydrated = 'true';
  }));
};

for (const host of hosts) {
  const entry = byName.get(host.dataset.hydrate ?? '')!;
  hydrateRoot(host, (
    <Committed onCommit={commit}>
      <EntitlementProvider tier="elite" authenticated trialOffer="used">
        <MarketSignalSection result={entry.result} livePrice={entry.livePrice} />
      </EntitlementProvider>
    </Committed>
  ));
}
