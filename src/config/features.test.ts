import { afterEach, describe, expect, it, vi } from 'vitest';
import { analystConsensusEnabled, featureFlagEnabled } from './features';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('server feature flags', () => {
  it('is off unless explicitly set to true', () => {
    expect(featureFlagEnabled(undefined)).toBe(false);
    expect(featureFlagEnabled('false')).toBe(false);
    expect(featureFlagEnabled('1')).toBe(false);
    expect(featureFlagEnabled(' TRUE ')).toBe(true);
  });

  it('enables Analyst Consensus by default but honors an explicit disable', () => {
    delete process.env.FEATURE_ANALYST_CONSENSUS;
    expect(analystConsensusEnabled()).toBe(true);

    vi.stubEnv('FEATURE_ANALYST_CONSENSUS', 'false');
    expect(analystConsensusEnabled()).toBe(false);

    vi.stubEnv('FEATURE_ANALYST_CONSENSUS', 'true');
    expect(analystConsensusEnabled()).toBe(true);
  });
});

