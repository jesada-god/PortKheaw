import { afterEach, describe, expect, it } from 'vitest';

import { SIGNAL_FLAG_KEYS, signalFlagState } from './signal-flags';

/**
 * The rollout contract, enforced rather than trusted.
 *
 * Every Market Signal v2 phase is reachable only through one of these switches,
 * so a switch that defaulted to ON — or one that a later phase quietly deleted —
 * would release unreviewed behaviour to readers the moment it deployed. Both
 * mistakes are silent in review and loud in production, which is exactly the
 * kind of thing a test should hold.
 */

const originals = new Map(SIGNAL_FLAG_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  originals.forEach((value, key) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
});

describe('market signal rollout flags', () => {
  it('names every phase of the build', () => {
    expect([...SIGNAL_FLAG_KEYS]).toEqual([
      'SIGNAL_GATE',
      'SIGNAL_ZONES',
      'SIGNAL_ACTIONABLE',
      'SIGNAL_CONTEXT',
      'SIGNAL_HISTORY',
    ]);
  });

  it('is OFF for every flag when the environment says nothing', () => {
    SIGNAL_FLAG_KEYS.forEach((key) => { delete process.env[key]; });
    expect(signalFlagState()).toEqual({
      SIGNAL_GATE: false,
      SIGNAL_ZONES: false,
      SIGNAL_ACTIONABLE: false,
      SIGNAL_CONTEXT: false,
      SIGNAL_HISTORY: false,
    });
  });

  it('is OFF for anything short of an explicit true', () => {
    SIGNAL_FLAG_KEYS.forEach((key) => { process.env[key] = 'false'; });
    expect(Object.values(signalFlagState())).not.toContain(true);
    SIGNAL_FLAG_KEYS.forEach((key) => { process.env[key] = '1'; });
    expect(Object.values(signalFlagState())).not.toContain(true);
    SIGNAL_FLAG_KEYS.forEach((key) => { process.env[key] = 'yes'; });
    expect(Object.values(signalFlagState())).not.toContain(true);
  });

  it('turns on exactly the phase that was asked for', () => {
    SIGNAL_FLAG_KEYS.forEach((key) => { delete process.env[key]; });
    process.env.SIGNAL_ZONES = 'TRUE';
    expect(signalFlagState()).toMatchObject({ SIGNAL_ZONES: true, SIGNAL_GATE: false, SIGNAL_HISTORY: false });
  });
});
