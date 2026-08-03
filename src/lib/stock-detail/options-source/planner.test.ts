import { describe, expect, it } from 'vitest';
import {
  classifyOptionsFailure,
  optionsRequestKey,
  planOptionsRequest,
  shouldApplyOptionsResponse,
  type OptionsRequestPlanInput,
} from './planner';

function planInput(partial: Partial<OptionsRequestPlanInput>): OptionsRequestPlanInput {
  return { enabled: true, entitlementBlocked: false, hasExpiration: true, cacheHas: false, inflightHas: false, force: false, ...partial };
}

describe('planOptionsRequest — lazy-load, single-flight, entitlement-stop', () => {
  it('skips entirely while the overlay toggle is disabled (lazy-load gate)', () => {
    expect(planOptionsRequest(planInput({ enabled: false }))).toBe('skip');
  });

  it('skips while entitlement-blocked so a 403 stops further requests', () => {
    expect(planOptionsRequest(planInput({ entitlementBlocked: true }))).toBe('skip');
  });

  it('skips when no expiration is selected yet', () => {
    expect(planOptionsRequest(planInput({ hasExpiration: false }))).toBe('skip');
  });

  it('serves the cache before hitting the network for a known symbol+expiration', () => {
    expect(planOptionsRequest(planInput({ cacheHas: true }))).toBe('serve-cache');
  });

  it('joins an in-flight request so exactly one request runs per symbol+expiration', () => {
    expect(planOptionsRequest(planInput({ inflightHas: true }))).toBe('join-inflight');
  });

  it('fetches only when enabled, unblocked, uncached and not in flight', () => {
    expect(planOptionsRequest(planInput({}))).toBe('fetch');
  });

  it('forces past the cache on an explicit refresh', () => {
    expect(planOptionsRequest(planInput({ cacheHas: true, force: true }))).toBe('fetch');
  });
});

describe('optionsRequestKey — viewport-independence', () => {
  it('keys on symbol + expiration + walls entitlement, never viewport state', () => {
    expect(optionsRequestKey('rklb', '2026-08-21')).toBe('RKLB::2026-08-21::walls-on');
    expect(optionsRequestKey('RKLB', '2026-08-21')).toBe(optionsRequestKey('rklb', '2026-08-21'));
    expect(optionsRequestKey('RKLB', '2026-08-21', false)).toBe('RKLB::2026-08-21::walls-off');
    expect(optionsRequestKey('RKLB', '2026-08-21', false))
      .not.toBe(optionsRequestKey('RKLB', '2026-08-21', true));
  });
});

describe('shouldApplyOptionsResponse — stale expiration guard', () => {
  it('applies only the newest, non-aborted generation', () => {
    expect(shouldApplyOptionsResponse(5, 5, false)).toBe(true);
    // A superseded expiration response (older generation) is dropped.
    expect(shouldApplyOptionsResponse(6, 5, false)).toBe(false);
    // An aborted request never applies.
    expect(shouldApplyOptionsResponse(5, 5, true)).toBe(false);
  });
});

describe('classifyOptionsFailure — typed reasons', () => {
  it('maps 403 / not-entitled to a non-retryable entitlement stop', () => {
    for (const c of [classifyOptionsFailure(403, null), classifyOptionsFailure(401, null), classifyOptionsFailure(502, 'forbidden')]) {
      expect(c.reason).toBe('entitlement-required');
      expect(c.retryable).toBe(false);
      expect(c.stopsPolling).toBe(true);
    }
  });

  it('maps provider-not-configured to a non-retryable stop', () => {
    const c = classifyOptionsFailure(503, 'provider-not-configured');
    expect(c.reason).toBe('entitlement-required');
    expect(c.stopsPolling).toBe(true);
  });

  it('maps 429 to a retryable rate-limit that does not stop polling', () => {
    const c = classifyOptionsFailure(429, 'rate-limited');
    expect(c.reason).toBe('rate-limited');
    expect(c.retryable).toBe(true);
    expect(c.stopsPolling).toBe(false);
  });

  it('maps 422 / insufficient-data to insufficient-coverage', () => {
    expect(classifyOptionsFailure(422, 'insufficient-data').reason).toBe('insufficient-coverage');
  });

  it('maps other failures to chain-unavailable, retryable only on transient 5xx', () => {
    expect(classifyOptionsFailure(404, 'not-found').reason).toBe('chain-unavailable');
    expect(classifyOptionsFailure(500, null)).toMatchObject({ reason: 'chain-unavailable', retryable: true });
    expect(classifyOptionsFailure(400, null)).toMatchObject({ reason: 'chain-unavailable', retryable: false });
  });
});
