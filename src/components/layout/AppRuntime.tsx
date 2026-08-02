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

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
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
