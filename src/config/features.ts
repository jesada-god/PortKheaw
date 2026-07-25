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

export function keyStatisticsEnabled() { return featureFlagEnabled(process.env.FEATURE_KEY_STATISTICS); }
export function optionsStatisticsEnabled() { return featureFlagEnabled(process.env.FEATURE_OPTIONS_STATISTICS); }
export function analystConsensusEnabled() {
  return featureFlagEnabled(process.env.FEATURE_ANALYST_CONSENSUS, true);
}
