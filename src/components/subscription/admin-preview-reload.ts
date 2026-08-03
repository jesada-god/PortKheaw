/**
 * How a page finishes an access change.
 *
 * `router.refresh()` re-renders the server tree, which is enough for markup —
 * but not for a downgrade. Premium surfaces hold state a re-render does not
 * touch: fetched option chains, chart overlays, and browser caches keyed by URL
 * rather than by plan. An operator stepping from Elite down to Basic must not
 * keep looking at Elite data in a Basic shell.
 *
 * A full document load is the only step that provably clears all of it, so it is
 * what an access change does. It is deliberate, not a fallback.
 */
export function reloadAfterAccessChange() {
  if (typeof window === 'undefined') return;
  window.location.reload();
}
