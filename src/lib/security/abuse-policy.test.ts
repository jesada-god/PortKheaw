import { describe, expect, it } from 'vitest';
import {
  ABUSE_CLASSES,
  abuseClassForPath,
  BURST_POLICIES,
  BurstLimiter,
  clientAddressFromHeaders,
  identityKeys,
  isExpensiveApiPath,
  tooManyRequestsHeaders,
} from './abuse-policy';

/**
 * The abuse model, exercised as abuse.
 *
 * Every case here is written from the attacker's side — burst, rotate the key,
 * forge the header, come back after the window — because a limiter that is only
 * tested by counting to its limit passes while every bypass around it works.
 * The last block is the one that matters most in practice: it asserts that
 * ordinary use is nowhere near any of these bounds, since a limiter that refuses
 * real readers is an outage that took work to build.
 */

/** A limiter driven by a clock the test owns, so nothing here sleeps. */
function limiterAt(clock: { now: number }) {
  return new BurstLimiter(20_000, () => clock.now);
}

describe('classifying a request by risk', () => {
  it('separates the console\'s reads from its writes', () => {
    expect(abuseClassForPath('/admin', 'GET')).toBe('admin-read');
    expect(abuseClassForPath('/admin/system', 'GET')).toBe('admin-read');
    // A server action posts to its own page URL, so a POST to a console path is
    // a mutation and has to be bounded as the strictest class.
    expect(abuseClassForPath('/admin/system', 'POST')).toBe('admin-mutation');
    expect(abuseClassForPath('/api/admin/users', 'DELETE')).toBe('admin-mutation');
  });

  it('bounds the credential-bearing auth forms and nothing else under /auth', () => {
    for (const path of ['/auth/sign-in', '/auth/sign-up', '/auth/forgot-password', '/auth/reset-password']) {
      expect(`${path} -> ${abuseClassForPath(path, 'POST')}`).toBe(`${path} -> auth`);
    }
    /*
     * `/auth/callback` completes an OAuth round trip and a recovery link.
     * Bounding it would break the sign-in it is finishing — the visitor did not
     * choose how many times the provider redirects them.
     */
    expect(abuseClassForPath('/auth/callback', 'GET')).toBeNull();
    expect(abuseClassForPath('/auth/configuration-required', 'GET')).toBeNull();
  });

  it('knows which API routes cost real work', () => {
    for (const path of [
      '/api/option-simulations/compute/monte-carlo',
      '/api/analytics/options-signal/AAPL',
      '/api/market/options/chain',
      '/api/translate/company-profile',
      '/api/news',
    ]) {
      expect(`${path} -> ${abuseClassForPath(path, 'POST')}`).toBe(`${path} -> expensive`);
      expect(isExpensiveApiPath(path)).toBe(true);
    }
    expect(abuseClassForPath('/api/market/quote/AAPL', 'GET')).toBe('api');
    expect(isExpensiveApiPath('/api/market/quote/AAPL')).toBe(false);
  });

  /*
   * The direction that matters: an unrecognised path is not a guarded surface,
   * and must never fall back to a class. Bounding every page render at an API
   * rate is how a limiter starts refusing readers who did nothing.
   */
  it('leaves every ordinary page untouched', () => {
    for (const path of ['/', '/portfolio', '/watchlist', '/stock/AAPL', '/settings', '/support']) {
      expect(`${path} -> ${abuseClassForPath(path, 'GET')}`).toBe(`${path} -> null`);
    }
  });

  it('does not mistake a path that merely starts with a guarded prefix', () => {
    expect(abuseClassForPath('/administrators', 'GET')).toBeNull();
    expect(abuseClassForPath('/authors', 'GET')).toBeNull();
  });
});

describe('the client address, through a proxy', () => {
  it('reads the hop the platform appended, never one the caller chose', () => {
    /*
     * `x-forwarded-for` is a list each hop appends to, so every entry but the
     * first is attacker-supplied. A limiter that reads the last entry can be
     * given a fresh identity on every request by sending the header.
     */
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1, 10.0.0.2' });
    expect(clientAddressFromHeaders(headers)).toBe('203.0.113.9');
  });

  it('falls back to x-real-ip, then to nothing', () => {
    expect(clientAddressFromHeaders(new Headers({ 'x-real-ip': '198.51.100.4' }))).toBe('198.51.100.4');
    expect(clientAddressFromHeaders(new Headers())).toBeNull();
  });
});

describe('the burst limiter', () => {
  it('allows exactly the policy and refuses the next one', () => {
    const clock = { now: 1_000 };
    const limiter = limiterAt(clock);
    const policy = { limit: 5, windowMs: 10_000 };

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(`#${attempt}: ${limiter.consume('k', policy).allowed}`).toBe(`#${attempt}: true`);
    }
    const refused = limiter.consume('k', policy);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('answers with a wait long enough for the oldest hit to age out', () => {
    const clock = { now: 0 };
    const limiter = limiterAt(clock);
    const policy = { limit: 2, windowMs: 10_000 };

    limiter.consume('k', policy);       // t=0
    clock.now = 4_000;
    limiter.consume('k', policy);       // t=4000
    clock.now = 5_000;

    // The oldest hit (t=0) leaves the window at t=10000, which is 5s away.
    expect(limiter.consume('k', policy).retryAfterSeconds).toBe(5);
  });

  it('lets the window slide rather than resetting on a fixed boundary', () => {
    const clock = { now: 0 };
    const limiter = limiterAt(clock);
    const policy = { limit: 2, windowMs: 10_000 };

    limiter.consume('k', policy);
    limiter.consume('k', policy);
    expect(limiter.consume('k', policy).allowed).toBe(false);

    // One window later the earliest hits have aged out and the budget is back.
    clock.now = 10_001;
    expect(limiter.consume('k', policy).allowed).toBe(true);
  });

  it('keeps one budget per key, so one abusive caller cannot spend everyone else\'s', () => {
    const clock = { now: 0 };
    const limiter = limiterAt(clock);
    const policy = { limit: 1, windowMs: 10_000 };

    expect(limiter.consume('attacker', policy).allowed).toBe(true);
    expect(limiter.consume('attacker', policy).allowed).toBe(false);
    expect(limiter.consume('bystander', policy).allowed).toBe(true);
  });

  /*
   * The bypass a layered limiter with an early return actually has.
   *
   * A caller who is over their *account* budget must not get a free ride on
   * their address budget. If the first refusal short-circuited, rotating to
   * whichever key is cheapest would walk straight around the limit.
   */
  it('charges every identity layer even after one has already refused', () => {
    const clock = { now: 0 };
    const limiter = limiterAt(clock);
    const policy = { limit: 1, windowMs: 10_000 };
    const identity = { userId: 'u1', clientAddress: '203.0.113.9' };

    expect(limiter.consumeIdentity('api', identity, policy).allowed).toBe(true);
    expect(limiter.consumeIdentity('api', identity, policy).allowed).toBe(false);

    // The address bucket was charged both times, so a *different* account from
    // the same address is already out of address budget.
    const sameAddress = { userId: 'u2', clientAddress: '203.0.113.9' };
    expect(limiter.consumeIdentity('api', sameAddress, policy).allowed).toBe(false);
  });

  it('pools callers it cannot identify rather than exempting them', () => {
    expect(identityKeys({})).toEqual(['anonymous']);
    expect(identityKeys({ userId: null, clientAddress: null })).toEqual(['anonymous']);
  });

  it('orders identity keys from most to least specific', () => {
    expect(identityKeys({ userId: 'u1', subject: 'A@Example.com', clientAddress: '1.2.3.4' }))
      .toEqual(['user:u1', 'subject:a@example.com', 'addr:1.2.3.4']);
  });

  it('separates scopes, so a burst of one operation does not spend another\'s budget', () => {
    const clock = { now: 0 };
    const limiter = limiterAt(clock);
    const policy = { limit: 1, windowMs: 10_000 };
    const identity = { clientAddress: '203.0.113.9' };

    expect(limiter.consumeIdentity('expensive:monte-carlo', identity, policy).allowed).toBe(true);
    expect(limiter.consumeIdentity('expensive:monte-carlo', identity, policy).allowed).toBe(false);
    expect(limiter.consumeIdentity('expensive:what-if', identity, policy).allowed).toBe(true);
  });

  /*
   * A limiter keyed by client address, in a process that runs for weeks, with no
   * eviction, is a memory leak whose size an attacker chooses. This asserts the
   * ceiling holds under exactly that: a flood from addresses that are never
   * seen twice.
   */
  it('stays bounded under a flood from endlessly rotating addresses', () => {
    const clock = { now: 0 };
    const limiter = new BurstLimiter(100, () => clock.now);
    const policy = { limit: 5, windowMs: 1_000 };

    for (let index = 0; index < 5_000; index += 1) {
      clock.now += 1;
      limiter.consume(`addr:${index}`, policy);
    }
    expect(limiter.size).toBeLessThanOrEqual(100);
  });

  it('never refuses when a policy is disabled', () => {
    const limiter = limiterAt({ now: 0 });
    expect(limiter.consume('k', BURST_POLICIES.realtime).allowed).toBe(true);
  });
});

describe('what a refusal tells the caller', () => {
  it('always names a retry delay, and never caches the refusal', () => {
    const headers = tooManyRequestsHeaders(7);
    expect(headers['Retry-After']).toBe('7');
    expect(headers['Cache-Control']).toContain('no-store');
    expect(headers['Cache-Control']).toContain('private');
  });

  it('never answers with a zero or negative delay, which would invite a poll', () => {
    expect(tooManyRequestsHeaders(0)['Retry-After']).toBe('1');
    expect(tooManyRequestsHeaders(-5)['Retry-After']).toBe('1');
  });
});

describe('the bounds leave ordinary use alone', () => {
  /*
   * The failure mode nobody notices in review: bounds tight enough to refuse a
   * person. Each case below is a real interaction pattern, replayed against the
   * real policy, and must pass every request.
   */
  it('admits a reader loading a page that fans out to many API calls', () => {
    const clock = { now: 0 };
    const limiter = limiterAt(clock);
    const identity = { userId: 'reader', clientAddress: '203.0.113.9' };

    // A stock page opens ~30 requests in a second, then polls.
    for (let index = 0; index < 30; index += 1) {
      clock.now += 30;
      expect(`open #${index}: ${limiter.consumeIdentity('api:x', identity, BURST_POLICIES.api).allowed}`)
        .toBe(`open #${index}: true`);
    }
    for (let index = 0; index < 60; index += 1) {
      clock.now += 1_000;
      expect(`poll #${index}: ${limiter.consumeIdentity('api:x', identity, BURST_POLICIES.api).allowed}`)
        .toBe(`poll #${index}: true`);
    }
  });

  it('admits an operator working briskly through the console', () => {
    const clock = { now: 0 };
    const limiter = limiterAt(clock);
    const identity = { userId: 'operator', clientAddress: '203.0.113.9' };

    // One console action every two seconds for two minutes.
    for (let index = 0; index < 60; index += 1) {
      clock.now += 2_000;
      expect(`action #${index}: ${limiter.consumeIdentity('admin-mutation:x', identity, BURST_POLICIES['admin-mutation']).allowed}`)
        .toBe(`action #${index}: true`);
    }
  });

  it('admits somebody mistyping their password a few times', () => {
    const clock = { now: 0 };
    const limiter = limiterAt(clock);
    const identity = { subject: 'reader@example.com', clientAddress: '203.0.113.9' };

    for (let index = 0; index < 5; index += 1) {
      clock.now += 3_000;
      expect(`attempt #${index}: ${limiter.consumeIdentity('auth:sign-in', identity, BURST_POLICIES.auth).allowed}`)
        .toBe(`attempt #${index}: true`);
    }
  });

  it('refuses a scripted credential-stuffing burst on the same forms', () => {
    const clock = { now: 0 };
    const limiter = limiterAt(clock);
    let refused = 0;

    // 100 attempts in one second from one address, rotating the account —
    // the shape an address-only limiter is blind to only when it is the key.
    for (let index = 0; index < 100; index += 1) {
      clock.now += 10;
      const identity = { subject: `victim${index}@example.com`, clientAddress: '198.51.100.7' };
      if (!limiter.consumeIdentity('auth:sign-in', identity, BURST_POLICIES.auth).allowed) refused += 1;
    }
    expect(refused).toBeGreaterThan(70);
  });
});

describe('the class inventory', () => {
  it('has a burst policy for every class the model defines', () => {
    for (const abuseClass of ABUSE_CLASSES) {
      expect(`${abuseClass}: ${typeof BURST_POLICIES[abuseClass]?.limit}`).toBe(`${abuseClass}: number`);
    }
  });
});
