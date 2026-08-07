# Known issues

Open defects that are observed and reproducible enough to record, but not yet
root-caused. Each entry states what was ruled out, so the next person starts
from the end of the last investigation rather than the beginning.

Remove an entry when it is fixed — this file is for live issues only.

---

## Intermittent React #418 on `/tools/what-if`

**Status:** open · **Severity:** low (recoverable; React re-renders the subtree
on the client) · **Observed:** 2026-08-07, local production build

### Symptom

`Error: Minified React error #418` — a hydration mismatch — thrown as a page
error on `/tools/what-if`. Roughly **1 in 3** full runs of
`npm run qa:tools-simulator-mobile`, always on the first viewport pass
(430×932), which is the pass immediately following sign-in. No visible breakage
follows it: React discards the server markup for that subtree and re-renders.

### Not reproducible on demand

About 54 targeted loads across three hypotheses failed to trigger it even once:

| Hypothesis | Setup | Result |
|---|---|---|
| Slow first paint widens the hydration window | 24 loads, fresh context each (cold cache), CPU throttle 8×, network throttled | no #418 |
| Warm cache / repeat navigation | 18 loads, shared context, CPU throttle 6× | no #418 |
| The `localStorage` draft restore replaces the tree mid-hydration | 12 reloads with a real draft present, CPU throttle 6× | no #418 |

### What is known

- All three `/tools*` routes are **dynamic** (`ƒ`) in the build, so this is not
  the "static route freezes build-time HTML" trap recorded for the earlier
  `/tools` #418 pair (58e7631).
- `SimulatorWorkspace` applies the reader's calendar day and any restored draft
  from a `setTimeout(0)` inside a mount effect (see the comment above that
  effect). A state update landing before hydration commits is the mechanism that
  would produce this error, and that effect is the only candidate on the page —
  but it has not been caught doing so.
- The `today` state added alongside the Target Date work is `''` on both the
  server render and the first client render, and is updated inside that same
  pre-existing effect, so it does not add a new mismatch window. **This does not
  amount to proof that the issue predates that change** — establishing that
  needs several full QA runs against the prior build to compare rates.

### Next step

Reproduce with a development build (unminified React names the mismatching
element and prints a diff) rather than guessing at the minified code. Do not
change the mount effect speculatively: it is covered by
`SimulatorWorkspace.hydration.test.tsx`, which encodes the prerender contract it
exists to satisfy.
