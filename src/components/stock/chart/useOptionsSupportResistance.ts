'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { optionsUnavailable, type OptionsSrResult } from '@/src/lib/analytics/options-sr';
import type { OptionsChain } from '@/src/lib/market-data/options/contracts';
import type { OptionsChainStaleFallback } from '@/src/lib/stock-detail/options-source';
import {
  optionsChainCoordinator,
  optionsExpirationsCoordinator,
} from '@/src/lib/stock-detail/options-source';
import { useEntitlement } from '@/src/components/subscription/EntitlementProvider';

export interface UseOptionsSupportResistanceOptions {
  symbol: string;
  /** The single accepted underlying price shared with the header/chart. */
  acceptedPrice: number | null;
  /** The Options overlay toggle — the lazy-load gate. */
  enabled: boolean;
  /** True only while the Chart tab is active/mounted. */
  active: boolean;
}

export interface UseOptionsSupportResistanceResult {
  result: OptionsSrResult | null;
  chain: OptionsChain | null;
  /**
   * Last-good chain retained across a failed refresh. Consumers that can present
   * an explicitly STALE reading (the Options Signal factors) use this; the chart
   * overlay deliberately keeps using `result`/`chain` only.
   */
  staleFallback: OptionsChainStaleFallback | null;
  loading: boolean;
  expirations: string[];
  selectedExpiration: string | null;
  retryAt: number | null;
  setExpiration: (expiration: string) => void;
  refresh: () => void;
}

/**
 * Lazy Options loader backed by browser-wide coordinators. Closing/reopening the
 * layer, React Strict Mode, and rapid clicks join the same request instead of
 * creating new provider work. Each effect generation ignores stale responses;
 * the coordinators own AbortControllers, fresh caches, and negative cooldowns.
 */
export function useOptionsSupportResistance({ symbol, acceptedPrice, enabled: requested, active }: UseOptionsSupportResistanceOptions): UseOptionsSupportResistanceResult {
  const { can } = useEntitlement();
  /*
   * Reading the chain at all needs the Pro ledger, and the walls on top of it
   * need Elite. A reader without the ledger issues zero requests: the gate is on
   * the loader, not on the rendering, so a locked section costs the provider
   * nothing and puts nothing in memory to leak.
   */
  const chainEntitled = can('options.chain.basic');
  const wallsEntitled = can('options.analytics.walls');
  const enabled = requested && chainEntitled;
  const [expirations, setExpirations] = useState<string[]>([]);
  const [selectedExpiration, setSelectedExpiration] = useState<string | null>(null);
  const [result, setResult] = useState<OptionsSrResult | null>(null);
  const [chain, setChain] = useState<OptionsChain | null>(null);
  const [staleFallback, setStaleFallback] = useState<OptionsChainStaleFallback | null>(null);
  const [expirationsLoading, setExpirationsLoading] = useState(false);
  const [chainLoading, setChainLoading] = useState(false);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const expirationsGeneration = useRef(0);
  const chainGeneration = useRef(0);
  const acceptedPriceRef = useRef(acceptedPrice);

  useEffect(() => { acceptedPriceRef.current = acceptedPrice; }, [acceptedPrice]);

  const previousSymbol = useRef(symbol);
  useEffect(() => {
    if (previousSymbol.current === symbol) return;
    previousSymbol.current = symbol;
    expirationsGeneration.current += 1;
    chainGeneration.current += 1;
    const nextSymbol = symbol;
    queueMicrotask(() => {
      if (previousSymbol.current !== nextSymbol) return;
      setExpirations([]);
      setSelectedExpiration(null);
      setResult(null);
      setChain(null);
      // A previous symbol's stale chain must never survive into the next one.
      setStaleFallback(null);
      setRetryAt(null);
      setExpirationsLoading(false);
      setChainLoading(false);
    });
  }, [symbol]);

  useEffect(() => {
    if (enabled && active) return;
    expirationsGeneration.current += 1;
    chainGeneration.current += 1;
  }, [enabled, active]);

  useEffect(() => {
    if (!enabled || !active) return;
    const requestGeneration = ++expirationsGeneration.current;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || expirationsGeneration.current !== requestGeneration) return;
      setExpirationsLoading(true);
      void (async () => {
      try {
        const outcome = await optionsExpirationsCoordinator.load(symbol);
        if (cancelled || expirationsGeneration.current !== requestGeneration) return;
        if (!outcome.ok) {
          const reason = outcome.classification?.reason ?? 'chain-unavailable';
          setResult(optionsUnavailable(symbol, null, reason, outcome.message ?? 'Options expirations are unavailable.', outcome.provider));
          setChain(null);
          setRetryAt(outcome.classification?.reason === 'rate-limited'
            ? Date.now() + (outcome.retryAfterSeconds ?? 60) * 1_000
            : null);
          return;
        }
        setRetryAt(null);
        setExpirations(outcome.expirations);
        if (outcome.expirations.length === 0) {
          setResult(optionsUnavailable(symbol, null, 'no-expirations', 'No non-expired option expirations were returned.', outcome.provider));
          setChain(null);
          return;
        }
        // Default to the nearest non-expired expiration so opening the section
        // resolves to a real chain in exactly one further request, instead of
        // parking on a "pick an expiration" prompt. A user's own choice is kept
        // whenever it is still in the returned list.
        setSelectedExpiration((current) => (current && outcome.expirations.includes(current) ? current : outcome.expirations[0] ?? null));
      } finally {
        if (!cancelled && expirationsGeneration.current === requestGeneration) setExpirationsLoading(false);
      }
      })();
    });
    return () => { cancelled = true; };
  }, [symbol, enabled, active, refreshToken]);

  useEffect(() => {
    if (!enabled || !active || !selectedExpiration) return;
    const requestGeneration = ++chainGeneration.current;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || chainGeneration.current !== requestGeneration) return;
      setChainLoading(true);
      void (async () => {
      try {
        const outcome = await optionsChainCoordinator.load(symbol, selectedExpiration, acceptedPriceRef.current, { wallsEntitled });
        if (cancelled || chainGeneration.current !== requestGeneration) return;
        setResult(outcome.result);
        setChain(outcome.chain);
        setStaleFallback(outcome.staleFallback ?? null);
        const cooldownMs = optionsChainCoordinator.cooldownRemainingMs(symbol, selectedExpiration, wallsEntitled);
        setRetryAt(Number.isFinite(cooldownMs) && cooldownMs > 0 ? Date.now() + cooldownMs : null);
      } catch (cause) {
        if (cancelled || chainGeneration.current !== requestGeneration) return;
        setChain(null);
        setStaleFallback(null);
        setResult(optionsUnavailable(symbol, selectedExpiration, 'chain-unavailable', cause instanceof Error ? cause.message : 'Options chain request failed.'));
        setRetryAt(Date.now() + 30_000);
      } finally {
        if (!cancelled && chainGeneration.current === requestGeneration) setChainLoading(false);
      }
      })();
    });
    return () => { cancelled = true; };
  }, [symbol, selectedExpiration, enabled, active, refreshToken, wallsEntitled]);

  const setExpiration = useCallback((expiration: string) => {
    if (!expiration) return;
    setSelectedExpiration((current) => current === expiration ? current : expiration);
  }, []);

  const refresh = useCallback(() => {
    if (retryAt && Date.now() < retryAt) return;
    const ready = selectedExpiration
      ? optionsChainCoordinator.reset(symbol, selectedExpiration, wallsEntitled)
      : optionsExpirationsCoordinator.reset(symbol);
    if (!ready) return;
    setRetryAt(null);
    setRefreshToken((token) => token + 1);
  }, [retryAt, selectedExpiration, symbol, wallsEntitled]);

  return { result, chain, staleFallback, loading: enabled && active && (expirationsLoading || chainLoading), expirations, selectedExpiration, retryAt, setExpiration, refresh };
}
