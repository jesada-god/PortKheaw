'use client';

import { useEffect, useState } from 'react';
import { useStore } from '@/src/store/useStore';
import { DEVICE_PREFERENCES_SYNC_EVENT } from '@/src/lib/privacy';

/**
 * The device preference remains enabled while the eye button reveals values for
 * this mounted page only. Navigating away or refreshing remounts the page and
 * therefore hides the values again.
 */
export function usePortfolioPrivacy() {
  const privacyMode = useStore((state) => state.privacyMode);
  const setPrivacyMode = useStore((state) => state.setPrivacyMode);
  const [temporarilyRevealed, setTemporarilyRevealed] = useState(false);
  const visible = !privacyMode || temporarilyRevealed;

  useEffect(() => {
    const resetTemporaryReveal = () => setTemporarilyRevealed(false);
    window.addEventListener(DEVICE_PREFERENCES_SYNC_EVENT, resetTemporaryReveal);
    return () => window.removeEventListener(DEVICE_PREFERENCES_SYNC_EVENT, resetTemporaryReveal);
  }, []);

  function toggleVisibility() {
    if (!privacyMode) {
      setTemporarilyRevealed(false);
      setPrivacyMode(true);
      return;
    }
    setTemporarilyRevealed((current) => !current);
  }

  return { privacyMode, visible, toggleVisibility };
}
