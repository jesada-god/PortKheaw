import { featureFlagEnabled } from './features';

/**
 * Market Signal v2 rollout switches.
 *
 * Every phase of the v2 build ships behind one of these, and every one of them
 * defaults to OFF. That is the whole contract: the code can be merged and
 * deployed at any point and a reader still sees the v1 card, pixel for pixel,
 * because nothing new is reachable until an owner sets the variable. Releasing
 * is a separate, human act from shipping.
 *
 * Two rules that are easy to get wrong:
 *   * Never default one of these to `true`. `featureFlagEnabled` is called
 *     without a default here on purpose — an unset variable is OFF.
 *   * Never delete a flag once its phase lands. The flag IS the rollback: if a
 *     phase misbehaves in production the owner unsets the variable, and that
 *     path has to still exist for that to work.
 *
 * They are kept out of `features.ts` because the snapshot gate needs to read
 * them as a SET — `signalFlagState()` is what lets `snapshot-signal --check`
 * refuse to run a baseline comparison while any of them is on.
 */
export const SIGNAL_FLAG_KEYS = [
  'SIGNAL_GATE',
  'SIGNAL_ZONES',
  'SIGNAL_ACTIONABLE',
  'SIGNAL_CONTEXT',
  'SIGNAL_HISTORY',
] as const;

export type SignalFlagKey = typeof SIGNAL_FLAG_KEYS[number];

/** P1 — consistency layer: conflict gate, bands, agreement, multiplicative confidence. */
export const signalGateEnabled = () => featureFlagEnabled(process.env.SIGNAL_GATE);
/** P2 — trend zones: zone-driven label, hysteresis, confirmation. */
export const signalZonesEnabled = () => featureFlagEnabled(process.env.SIGNAL_ZONES);
/** P3 — invalidation level, risk:reward, higher-timeframe filter. */
export const signalActionableEnabled = () => featureFlagEnabled(process.env.SIGNAL_ACTIONABLE);
/** P5 — earnings/relative-strength/VPVR/options/volatility-regime context. */
export const signalContextEnabled = () => featureFlagEnabled(process.env.SIGNAL_CONTEXT);
/** P6 — daily signal history strip. */
export const signalHistoryEnabled = () => featureFlagEnabled(process.env.SIGNAL_HISTORY);

const READERS: Record<SignalFlagKey, () => boolean> = {
  SIGNAL_GATE: signalGateEnabled,
  SIGNAL_ZONES: signalZonesEnabled,
  SIGNAL_ACTIONABLE: signalActionableEnabled,
  SIGNAL_CONTEXT: signalContextEnabled,
  SIGNAL_HISTORY: signalHistoryEnabled,
};

/** Every switch read at once, for the snapshot gate and for diagnostics. */
export function signalFlagState(): Record<SignalFlagKey, boolean> {
  return Object.fromEntries(SIGNAL_FLAG_KEYS.map((key) => [key, READERS[key]()])) as Record<SignalFlagKey, boolean>;
}
