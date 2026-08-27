/**
 * The browser half of the Options Signal card QA.
 *
 * WHY THIS IS HYDRATED AND NOT JUST RENDERED. The card is a client component
 * that fetches its own payload: what the server can produce is the loading
 * state, and the reader never sees that for longer than a request. Measuring
 * server markup here would be measuring the skeleton and reporting it as the
 * card — the same class of mistake the zone-bar harness documents, where a
 * probe measured the arrangement React falls back to before it has committed.
 *
 * So `window.fetch` is stubbed BEFORE `hydrateRoot`, the card's own request
 * resolves against the fixture, and the flag goes up only once React has
 * committed the card that request produced.
 *
 * `data-hydrated` IS OBSERVED, NOT TIMED — and not counted from a wrapper
 * effect either, which is the mistake this file was written with first.
 *
 * A `<Committed>` wrapper around the card reports its own commits, and the card
 * keeps its payload in its OWN state, so React re-renders that subtree and
 * never re-renders the wrapper. The wrapper's effect fired once, against the
 * loading state, and the flag never went up.
 *
 * So the handshake watches the DOM instead. `[data-signal]` is rendered only on
 * the success branch and is absent from the server markup entirely — checked,
 * not assumed: `renderToString` of this card is 942 bytes of loading state with
 * no `data-signal` in it. Its appearance inside a host is therefore proof that
 * this browser hydrated, ran the card's own fetch, and committed the result.
 * That is an event that actually happened, which is the property the frame
 * counting in the zone-bar client was reaching for.
 */
import React from 'react';
import { hydrateRoot } from 'react-dom/client';
import { EntitlementProvider } from '@/src/components/subscription/EntitlementProvider';
import { OptionsSignalSection } from '@/src/components/analytics/options-signal/OptionsSignalSection';
import { CASES } from './options-signal-header-cases';

const byName = new Map(CASES.map((entry) => [entry.name, entry]));

/*
 * One fixture per host, keyed by the symbol the host asks for.
 *
 * The card calls `/api/analytics/options-signal/<symbol>`, so the case name is
 * passed AS the symbol and the stub reads it back out of the URL. That keeps
 * several cards on one page without a shared mutable "current case".
 */
const originalFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const match = /\/api\/analytics\/options-signal\/([^/?]+)/.exec(url);
  if (!match) return originalFetch(input as RequestInfo, init);
  const entry = byName.get(decodeURIComponent(match[1]));
  if (!entry) return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify({ data: entry.signal }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof window.fetch;

const hosts = [...document.querySelectorAll<HTMLElement>('[data-hydrate]')]
  .filter((host) => byName.has(host.dataset.hydrate ?? ''));

for (const host of hosts) {
  const entry = byName.get(host.dataset.hydrate ?? '')!;
  hydrateRoot(host, (
    <EntitlementProvider
      tier={entry.breakdownEntitled ? 'elite' : 'pro'}
      authenticated
      trialOffer="used"
    >
      <OptionsSignalSection symbol={entry.name} active />
    </EntitlementProvider>
  ));
}

/*
 * Every host has committed its card. Two frames after that, so the layout that
 * follows the commit has been through the browser as well.
 */
const settled = () => hosts.every((host) => host.querySelector('[data-signal]'));
const raise = () => requestAnimationFrame(() => requestAnimationFrame(() => {
  document.documentElement.dataset.hydrated = 'true';
}));

if (hosts.length && settled()) {
  raise();
} else if (hosts.length) {
  const observer = new MutationObserver(() => {
    if (!settled()) return;
    observer.disconnect();
    raise();
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
}
