export function featureFlagEnabled(value: string | undefined, defaultValue = false) {
  if (value === undefined) return defaultValue;
  return value.trim().toLowerCase() === 'true';
}

export function technicalIndicatorsEnabled() {
  return featureFlagEnabled(process.env.FEATURE_TECHNICAL_INDICATORS);
}

export function advancedChartTypesEnabled() {
  return featureFlagEnabled(process.env.FEATURE_ADVANCED_CHART_TYPES);
}

export function extendedIndicatorsEnabled() {
  return featureFlagEnabled(process.env.FEATURE_EXTENDED_INDICATORS);
}

export function supportResistanceEnabled() {
  return featureFlagEnabled(process.env.FEATURE_SUPPORT_RESISTANCE);
}

/**
 * The Market Status card on the overview.
 *
 * DEFAULT OFF, and `featureFlagEnabled` is called without a default on purpose:
 * an unset variable is OFF. The card can be merged and deployed at any point and
 * a reader sees the overview exactly as it was, because nothing new is reachable
 * until an owner sets the variable — releasing stays a separate, human act from
 * shipping. Never default it to true, and never delete it once released: the
 * flag IS the rollback.
 */
export function marketStatusCardEnabled() {
  return featureFlagEnabled(process.env.MARKET_STATUS_CARD);
}

/**
 * The rebuilt watchlist — the trend column, the expandable row, and the
 * Overview preview that reads from a chosen list.
 *
 * DEFAULT OFF, and `featureFlagEnabled` is called without a default for the
 * same reason `marketStatusCardEnabled` is: an unset variable is OFF, so this
 * can be merged and deployed at any point and a reader sees the watchlist
 * exactly as it was. Releasing stays a separate, human act from shipping.
 *
 * The flag covers the READING surfaces only. The multiple-watchlist tables and
 * the RPCs behind them are NOT gated — a schema that exists conditionally is a
 * schema nobody can reason about, and the migration backfills every existing
 * reader a list either way. What the flag decides is whether anybody is shown
 * a way to make a second one.
 */
export function watchlistV2Enabled() {
  return featureFlagEnabled(process.env.WATCHLIST_V2);
}

export function keyStatisticsEnabled() { return featureFlagEnabled(process.env.FEATURE_KEY_STATISTICS); }
export function optionsStatisticsEnabled() { return featureFlagEnabled(process.env.FEATURE_OPTIONS_STATISTICS); }
export function analystConsensusEnabled() {
  return featureFlagEnabled(process.env.FEATURE_ANALYST_CONSENSUS, true);
}
