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

export function keyStatisticsEnabled() { return featureFlagEnabled(process.env.FEATURE_KEY_STATISTICS); }
export function optionsStatisticsEnabled() { return featureFlagEnabled(process.env.FEATURE_OPTIONS_STATISTICS); }
export function analystConsensusEnabled() {
  return featureFlagEnabled(process.env.FEATURE_ANALYST_CONSENSUS, true);
}
