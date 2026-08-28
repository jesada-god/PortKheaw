'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useStore } from '@/src/store/useStore';
import { DEVICE_PREFERENCES_SYNC_EVENT } from '@/src/lib/privacy';

const REFRESH_AFTER_MS = 2 * 60_000;

export function AppRuntime() {
  const pathname = usePathname();
  const router = useRouter();
  const motionPreference = useStore((state) => state.motionPreference);
  const inactiveAt = useRef<number | null>(null);

  useEffect(() => {
    const rehydrateDevicePreferences = async () => {
      await useStore.persist.rehydrate();
      window.dispatchEvent(new Event(DEVICE_PREFERENCES_SYNC_EVENT));
    };
    void rehydrateDevicePreferences();
    const syncDevicePreferences = (event: StorageEvent) => {
      if (event.key === 'nexora-ai-storage') void rehydrateDevicePreferences();
    };
    window.addEventListener('storage', syncDevicePreferences);
    return () => window.removeEventListener('storage', syncDevicePreferences);
  }, []);

  /*
   * THE APP SHELL WORKER IS A PRODUCTION FEATURE, AND ONLY THERE.
   *
   * What it buys is an offline shell and push delivery for an installed PWA.
   * Neither is worth anything while developing, and the cost turned out to be
   * severe: a worker sitting between `next dev` and the browser serves
   * `/_next/static/` from a URL that does not change when the file does, so it
   * can pin a component's JavaScript to the first copy it ever saw. The page
   * keeps rendering live server data beside stale code, and nothing a developer
   * would reach for — deleting `.next`, restarting the server, hard-refreshing —
   * touches Cache Storage or stops a worker intercepting subresources.
   *
   * That cost a full day on a card that had already been fixed and proved green
   * in tests. The worker is fixed too (`public/sw.js` no longer caches build
   * output on a dev host), but the durable answer is not to run it here at all.
   *
   * Existing registrations are actively REMOVED rather than merely skipped: a
   * developer whose browser already carries one would otherwise keep it, and
   * keep the failure, until they found the button by hand.
   */
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    if (process.env.NODE_ENV !== 'production') {
      void navigator.serviceWorker.getRegistrations()
        .then((registrations) => Promise.all(
          registrations.map((registration) => registration.unregister()),
        ))
        .catch(() => undefined);
      return;
    }

    const register = () => {
      void navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .catch(() => undefined);
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
    return () => window.removeEventListener('load', register);
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => {
      const reduced = motionPreference === 'reduce'
        || (motionPreference === 'system' && media.matches);
      document.documentElement.dataset.motionPreference = motionPreference;
      document.documentElement.toggleAttribute('data-reduce-motion', reduced);
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [motionPreference]);

  useEffect(() => {
    if ('scrollRestoration' in history) history.scrollRestoration = 'auto';
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        inactiveAt.current = Date.now();
        window.dispatchEvent(new Event('app-inactive'));
        return;
      }
      const awayFor = inactiveAt.current == null ? 0 : Date.now() - inactiveAt.current;
      inactiveAt.current = null;
      window.dispatchEvent(new CustomEvent('app-active', { detail: { awayFor } }));
      if (navigator.onLine && awayFor >= REFRESH_AFTER_MS && !pathname.startsWith('/auth/')) router.refresh();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [pathname, router]);

  return null;
}
