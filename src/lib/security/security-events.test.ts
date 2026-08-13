import { describe, expect, it } from 'vitest';
import {
  detectSecurityAlert,
  isSecurityEventKey,
  SECURITY_ALERT_RULES,
  SECURITY_EVENT_KEYS,
  SecurityEventCounter,
} from './security-events';

/**
 * The detection layer: counting, and the thresholds counted against.
 *
 * Two failures this file exists to prevent, and they pull in opposite
 * directions. A detector that fires too eagerly gets muted in week one and is
 * then worth nothing during the incident it was built for. A detector that never
 * fires is the same thing with better paperwork. So the assertions are about the
 * *boundary* — one below the threshold is silence, exactly the threshold is a
 * signal — and about the counter forgetting on schedule, because a window that
 * never expires turns a slow trickle into an alert eventually.
 */

describe('the event vocabulary', () => {
  it('recognises exactly the approved keys', () => {
    for (const key of SECURITY_EVENT_KEYS) {
      expect(`${key}: ${isSecurityEventKey(key)}`).toBe(`${key}: true`);
    }
    for (const value of [
      '', 'admin', 'admin.access', 'ADMIN.ACCESS.GRANTED', 'security.*',
      null, undefined, 42, {}, ['admin.access.granted'],
    ]) {
      expect(`${String(value)}: ${isSecurityEventKey(value)}`).toBe(`${String(value)}: false`);
    }
  });

  it('points every rule at a key that exists', () => {
    // A rule for an event nobody records is a threshold that can never trip.
    for (const [name, rule] of Object.entries(SECURITY_ALERT_RULES)) {
      expect(`${name}: ${(SECURITY_EVENT_KEYS as readonly string[]).includes(rule.event)}`)
        .toBe(`${name}: true`);
      expect(rule.threshold).toBeGreaterThan(1);
      expect(rule.windowMs).toBeGreaterThan(0);
      // Whoever reads this at 03:00 needs a sentence, not a slug.
      expect(rule.meaning.length).toBeGreaterThan(20);
    }
  });
});

describe('detection fires at the threshold and not before', () => {
  it('stays silent one occurrence below every rule', () => {
    for (const rule of Object.values(SECURITY_ALERT_RULES)) {
      const quiet = detectSecurityAlert({ event: rule.event, count: rule.threshold - 1 });
      expect(`${rule.event}: ${quiet === null}`).toBe(`${rule.event}: true`);
    }
  });

  it('fires exactly at the threshold, and keeps firing above it', () => {
    for (const rule of Object.values(SECURITY_ALERT_RULES)) {
      const at = detectSecurityAlert({ event: rule.event, count: rule.threshold });
      expect(at?.severity).toBe(rule.severity);
      expect(at?.count).toBe(rule.threshold);

      const above = detectSecurityAlert({ event: rule.event, count: rule.threshold + 100 });
      expect(`${rule.event}: ${above !== null}`).toBe(`${rule.event}: true`);
    }
  });

  it('never alerts on an operator simply working', () => {
    /*
     * `admin.access.granted` is written every time the console is opened. A
     * product that alerts on its own operators is a product whose alerts are
     * muted by Friday, so this event deliberately has no rule — it is recorded,
     * never escalated.
     */
    for (const count of [1, 10, 1_000, 100_000]) {
      expect(detectSecurityAlert({ event: 'admin.access.granted', count })).toBeNull();
    }
  });

  it('treats the probing of the console as critical, and throttling as a warning', () => {
    // Someone walking the console URL space holds a session they should not.
    // Someone being throttled is, most days, a retry loop.
    expect(detectSecurityAlert({ event: 'admin.authorization.denied', count: 5 })?.severity)
      .toBe('critical');
    expect(detectSecurityAlert({ event: 'security.rate_limit.repeated', count: 20 })?.severity)
      .toBe('warning');
  });
});

describe('the counter', () => {
  /** A clock the test moves by hand, so nothing here waits on real time. */
  function counterAt(start = 1_000): { counter: SecurityEventCounter; advance: (ms: number) => void } {
    let now = start;
    const counter = new SecurityEventCounter(50, () => now);
    return { counter, advance: (ms: number) => { now += ms; } };
  }

  it('counts occurrences inside the window', () => {
    const { counter } = counterAt();
    expect(counter.observe('a', 60_000)).toBe(1);
    expect(counter.observe('a', 60_000)).toBe(2);
    expect(counter.observe('a', 60_000)).toBe(3);
  });

  it('keeps identities apart, so one caller cannot spend another´s budget', () => {
    const { counter } = counterAt();
    counter.observe('user:one', 60_000);
    counter.observe('user:one', 60_000);
    expect(counter.observe('user:two', 60_000)).toBe(1);
  });

  it('forgets on schedule, so a slow trickle never accumulates into an alert', () => {
    const { counter, advance } = counterAt();
    counter.observe('a', 60_000);
    counter.observe('a', 60_000);
    advance(60_001);
    // Both earlier hits have aged out; this is the first of a new window.
    expect(counter.observe('a', 60_000)).toBe(1);
  });

  it('ages out only what is actually old', () => {
    const { counter, advance } = counterAt();
    counter.observe('a', 60_000);
    advance(30_000);
    counter.observe('a', 60_000);
    advance(31_000);
    // The first hit is 61s old and gone; the second is 31s old and stays.
    expect(counter.observe('a', 60_000)).toBe(2);
  });

  it('stays bounded under a flood of distinct keys', () => {
    // A counter keyed by identity, in a long-lived process, with no eviction is
    // a memory leak whose size an attacker chooses.
    const { counter } = counterAt();
    for (let index = 0; index < 500; index += 1) {
      counter.observe(`addr:198.51.100.${index}`, 60_000);
    }
    expect(counter.size).toBeLessThanOrEqual(50);
  });

  it('drops everything rather than growing when a sweep frees nothing', () => {
    const { counter } = counterAt();
    // Fill past the ceiling with keys that are all live, so a sweep cannot
    // reclaim any of them. Losing the oldest counts beats unbounded state.
    for (let index = 0; index < 200; index += 1) {
      counter.observe(`live:${index}`, 3_600_000);
    }
    expect(counter.size).toBeLessThanOrEqual(50);
  });

  it('clears on reset, so one test case cannot see another´s counts', () => {
    const { counter } = counterAt();
    counter.observe('a', 60_000);
    counter.reset();
    expect(counter.size).toBe(0);
    expect(counter.observe('a', 60_000)).toBe(1);
  });
});
