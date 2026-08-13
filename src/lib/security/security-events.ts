/**
 * The security event vocabulary, and the conditions worth waking somebody for.
 *
 * Two things live here, and they are separate on purpose:
 *
 *   * **The vocabulary** — a closed set of event keys, mirroring
 *     `public.security_event_keys()` in the database. A closed set is what stops
 *     an audit log from filling with attacker-chosen strings, and mirroring it in
 *     both places means the regression suite can assert the two agree rather than
 *     hoping they do.
 *   * **The detection** — pure functions over counters. Nothing here performs
 *     I/O, reads a session or knows what a database is, so the same thresholds
 *     are exercised by a test as by production.
 *
 * What this deliberately is **not**: a notification system. There is no pager,
 * no email fan-out, no webhook, no second delivery pipeline to keep alive. A
 * detected condition is written to the audit trail the incident will be read
 * from anyway, and reported through `captureServerError` — the monitoring path
 * this product already has, which writes a structured line the platform keeps
 * and searches, and ships a Sentry event when a DSN is configured. Building a
 * second alerting stack for eight conditions would be a lot of moving parts that
 * fail silently in exactly the situation they exist for.
 *
 * ## Where each signal comes from
 *
 * Six of the eight keys are emitted into the audit trail by this application:
 *
 *   `admin.access.granted`          `admin-guard.ts`, on every console render.
 *   `admin.authorization.denied`    middleware and `admin-guard.ts`.
 *   `admin.assurance.denied`        middleware, on a missing second factor.
 *   `admin.destructive.performed`   the lockdown toggle.
 *   `security.subscription.override` the access-preview action.
 *   `security.rate_limit.repeated`  `request-guard.ts`, on either layer refusing.
 *
 * Two are **deliberately not written to the database**, and saying so here is
 * more useful than a key that looks wired and is not:
 *
 *   `security.request.spike`   belongs to the edge abuse gate, which runs
 *                              *before* the session lookup — that ordering is
 *                              the entire reason it exists, because it is what
 *                              turns a flood into one map lookup instead of a
 *                              round trip we pay for. Recording it would put a
 *                              database write back in front of the gate and undo
 *                              the property. The signal lives in the platform's
 *                              edge logs and in the Vercel WAF rules described in
 *                              `docs/operations/edge-abuse-protection.md`, which
 *                              are the only layer that can see the whole fleet
 *                              anyway.
 *   `security.websocket.spike` belongs to the Gateway, a separate Node process on
 *                              a separate host with no Supabase write path. It
 *                              already logs every refused upgrade at `error`
 *                              with the reason and the open-connection count,
 *                              which Railway keeps and searches. Giving that
 *                              process a database credential so it could write
 *                              rows during a connection flood would be adding a
 *                              dependency at the exact moment it is least able to
 *                              carry one.
 *
 * Both keys stay in the vocabulary — the database accepts them and the rules
 * below are real — so that wiring either one later is a call site and not a
 * migration.
 */

export const SECURITY_EVENT_KEYS = [
  /** An operator opened the console with a valid identity and a second factor. */
  'admin.access.granted',
  /** Someone who is not an operator reached an operator surface. */
  'admin.authorization.denied',
  /** An operator reached an operator surface without a second factor. */
  'admin.assurance.denied',
  /** A privileged action the console classes as destructive completed. */
  'admin.destructive.performed',
  /** Repeated refusals from the shared limiter for one identity. */
  'security.rate_limit.repeated',
  /** Abnormally many requests from one identity inside one window. */
  'security.request.spike',
  /** Abnormally many socket connections from one identity. */
  'security.websocket.spike',
  /** A privileged override of what an account may open. */
  'security.subscription.override',
] as const;

export type SecurityEventKey = typeof SECURITY_EVENT_KEYS[number];

export type SecurityOutcome = 'allowed' | 'denied' | 'throttled' | 'observed';

export function isSecurityEventKey(value: unknown): value is SecurityEventKey {
  return typeof value === 'string'
    && (SECURITY_EVENT_KEYS as readonly string[]).includes(value);
}

/**
 * How severe a condition is, which is the only thing that decides whether it is
 * reported at `warning` or at `error`. Kept to two levels because a severity
 * scale with five rungs is one where nobody agrees what rung three means.
 */
export type SecuritySeverity = 'warning' | 'critical';

/**
 * The conditions, each with the count that trips it and the window it is counted
 * in.
 *
 * Every threshold below is set where a *person* doing the thing legitimately
 * cannot reach it, and a script trivially does. They are detection thresholds,
 * not limits — nothing is refused here. The refusing is done by the rate limiter
 * and the authorization gates, which run whether or not anybody is watching;
 * this only decides when the watching turns into a record.
 */
export interface SecurityAlertRule {
  event: SecurityEventKey;
  threshold: number;
  windowMs: number;
  severity: SecuritySeverity;
  /** Why this one matters, in a sentence, for whoever reads the alert at 03:00. */
  meaning: string;
}

export const SECURITY_ALERT_RULES: Readonly<Record<string, SecurityAlertRule>> = {
  /*
   * One non-operator reaching an operator surface is a stale bookmark or a
   * scanner, and is recorded but not alerted. Five inside a minute from one
   * identity is somebody working through the console's URL space, which is the
   * first thing anybody does with a session they should not have.
   */
  adminProbing: {
    event: 'admin.authorization.denied',
    threshold: 5,
    windowMs: 60_000,
    severity: 'critical',
    meaning: 'A non-operator is walking the operator console URL space.',
  },
  /*
   * A real operator fails the second factor once or twice — a mistyped code, a
   * clock drift on the authenticator. Five inside five minutes means either the
   * factor is broken, which is an availability incident, or somebody holds the
   * session but not the device, which is the exact scenario `aal2` exists for.
   */
  assuranceFailures: {
    event: 'admin.assurance.denied',
    threshold: 5,
    windowMs: 300_000,
    severity: 'critical',
    meaning: 'Repeated operator second-factor failures: a held session without the device.',
  },
  /*
   * The limiter refuses one caller constantly. Each individual refusal is
   * ordinary and is not recorded; the pattern is what is worth a row.
   */
  rateLimitStorm: {
    event: 'security.rate_limit.repeated',
    threshold: 20,
    windowMs: 60_000,
    severity: 'warning',
    meaning: 'One identity is being throttled continuously.',
  },
  /*
   * Volume from a single identity that no browser produces. Distinct from the
   * limiter's own bound, which is per class — this is the aggregate.
   */
  requestSpike: {
    event: 'security.request.spike',
    threshold: 300,
    windowMs: 60_000,
    severity: 'warning',
    meaning: 'Request volume from one identity that no browser produces.',
  },
  /*
   * Sockets are the expensive resource in this product: each one is a live
   * subscription in a process that holds them open. The Gateway already caps
   * concurrency per account and per address; this fires on the *attempt* rate,
   * which is what a reconnect loop and a deliberate exhaustion attempt share.
   */
  socketSpike: {
    event: 'security.websocket.spike',
    threshold: 40,
    windowMs: 60_000,
    severity: 'warning',
    meaning: 'Socket connection attempts from one identity far above a reconnect loop.',
  },
  /*
   * Destructive operator actions are legitimate and expected — that is why the
   * threshold is a rate rather than a count of one. Three inside five minutes is
   * faster than anybody works through a console deliberately.
   */
  destructiveBurst: {
    event: 'admin.destructive.performed',
    threshold: 3,
    windowMs: 300_000,
    severity: 'critical',
    meaning: 'Destructive operator actions faster than a person performs them deliberately.',
  },
};

export interface SecurityObservation {
  event: SecurityEventKey;
  /** How many times this identity has produced the event inside the window. */
  count: number;
}

export interface SecurityAlert {
  event: SecurityEventKey;
  severity: SecuritySeverity;
  threshold: number;
  count: number;
  meaning: string;
}

/**
 * Whether an observation has crossed its rule.
 *
 * An event with no rule returns `null` — recorded, never alerted. That is the
 * common case and it is the right default: `admin.access.granted` is written for
 * every console page an operator opens, and a product that alerts on its own
 * operators working is a product whose alerts get muted in week one.
 */
export function detectSecurityAlert(observation: SecurityObservation): SecurityAlert | null {
  for (const rule of Object.values(SECURITY_ALERT_RULES)) {
    if (rule.event !== observation.event) continue;
    if (observation.count < rule.threshold) return null;
    return {
      event: rule.event,
      severity: rule.severity,
      threshold: rule.threshold,
      count: observation.count,
      meaning: rule.meaning,
    };
  }
  return null;
}

/**
 * A bounded counter for "how many times has this identity done this lately".
 *
 * Deliberately the same shape as `BurstLimiter` in `abuse-policy.ts` and
 * deliberately not the same object: that one *refuses* traffic and its windows
 * are tuned for that; this one only counts, and a detection threshold that
 * shared state with an enforcement bound would mean tuning one silently
 * retunes the other.
 *
 * Both bounds matter. The time bound is the window a rule is written against;
 * the space bound is what stops a counter keyed by identity, in a long-lived
 * process, from being a memory leak whose size an attacker chooses.
 */
export class SecurityEventCounter {
  private readonly windows = new Map<string, number[]>();

  constructor(
    private readonly maxKeys = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record one occurrence and return how many are live in the rule's window. */
  observe(key: string, windowMs: number): number {
    const t = this.now();
    const cutoff = t - windowMs;

    const hits = this.windows.get(key);
    if (!hits) {
      if (this.windows.size >= this.maxKeys) this.sweep(cutoff);
      this.windows.set(key, [t]);
      return 1;
    }

    let live = 0;
    for (const hit of hits) if (hit > cutoff) hits[live++] = hit;
    hits.length = live;
    hits.push(t);
    return hits.length;
  }

  private sweep(cutoff: number): void {
    for (const [key, hits] of this.windows) {
      const live = hits.filter((hit) => hit > cutoff);
      if (live.length === 0) this.windows.delete(key);
      else this.windows.set(key, live);
    }
    // Still full of live windows: a real flood from many sources. Holding
    // unbounded state through it is worse than losing the oldest counts.
    if (this.windows.size >= this.maxKeys) this.windows.clear();
  }

  /** Test seam. */
  reset(): void {
    this.windows.clear();
  }

  get size(): number {
    return this.windows.size;
  }
}
