/**
 * The rollout funnel: ten approved events, and a rule for how often each may land.
 *
 * What this module is *for* is as much what it refuses as what it records. The
 * key list is closed, the payload has no free-text field, and the dedupe scope is
 * composed here rather than supplied by a caller — so a page that re-renders, an
 * action that retries and a reader who double-clicks all produce one row.
 *
 * Never stored, anywhere below: page content, message bodies, amounts, provider
 * customer/subscription/invoice/event identifiers, mailboxes, names, addresses,
 * user agents. The account id the database stamps is the only identifier, and it
 * is cleared if the account is deleted.
 */

export const betaFunnelEventKeys = [
  'signup_completed',
  'subscription_viewed',
  'checkout_started',
  'checkout_returned',
  'checkout_canceled',
  'payment_succeeded',
  'paywall_blocked',
  'promptpay_renewal_help_viewed',
  'promptpay_renewal_paid',
  'feature_used_before_purchase',
  /*
   * Product usage, added to the same funnel rather than beside it. The rollout
   * funnel answered "did they pay?"; these answer "which parts of the product
   * does anybody actually use?". Sharing the table means sharing its rules —
   * closed key list, no free text, deduped by construction, cleared with the
   * account — so there is no second telemetry system to keep honest.
   */
  'landing_viewed',
  'trial_started',
  'portfolio_created',
  'stock_detail_viewed',
  'tool_opened',
  'feature_used',
  'onboarding_path_chosen',
] as const;
export type BetaFunnelEventKey = typeof betaFunnelEventKeys[number];

export function isBetaFunnelEventKey(value: unknown): value is BetaFunnelEventKey {
  return betaFunnelEventKeys.includes(value as BetaFunnelEventKey);
}

/**
 * The keys a *browser* may ask the server to record.
 *
 * The line is intent versus money. A browser may report where somebody went and
 * what they were shown; it may never report that a payment happened, because the
 * report would believe it. `checkout_started`, `payment_succeeded`,
 * `promptpay_renewal_paid` and `signup_completed` are therefore emitted only from
 * server code that has already observed the fact — a session created at the
 * provider, a live paid subscription in the ledger, a freshly created account.
 *
 * `checkout_returned` and `checkout_canceled` are on this list because the fact
 * they describe exists *only* in the provider's return URL, and the subscription
 * page is contractually forbidden from reading a query parameter. Claiming either
 * one grants nothing: the routine behind them can only insert a telemetry row.
 */
export const clientRecordableEventKeys: readonly BetaFunnelEventKey[] = [
  'subscription_viewed',
  'checkout_returned',
  'checkout_canceled',
  'paywall_blocked',
  'promptpay_renewal_help_viewed',
  'feature_used_before_purchase',
  /*
   * A landing view happens in a browser and nowhere else — nobody is signed in
   * when it happens, so no server render can attribute it. It grants nothing:
   * the routine behind it can only insert one telemetry row.
   */
  'landing_viewed',
];

export function isClientRecordableEventKey(value: unknown): value is BetaFunnelEventKey {
  return clientRecordableEventKeys.includes(value as BetaFunnelEventKey);
}

/**
 * How often each event may land.
 *
 * `account` — once per account, forever. Facts that can only happen once.
 * `account_day` — once per account per Bangkok day. Repeatable intent, counted
 *   as "did they do this today?" rather than "how many times did they click?".
 * `account_subject_day` — the same, but separately per plan or per feature, so
 *   "blocked by two different paywalls today" is two data points and "blocked by
 *   the same one four times" is one.
 */
export type BetaFunnelDedupeScope = 'account' | 'account_day' | 'account_subject_day';

export const BETA_FUNNEL_DEDUPE: Readonly<Record<BetaFunnelEventKey, BetaFunnelDedupeScope>> = {
  signup_completed: 'account',
  subscription_viewed: 'account_day',
  checkout_started: 'account_subject_day',
  checkout_returned: 'account_day',
  checkout_canceled: 'account_day',
  payment_succeeded: 'account_subject_day',
  paywall_blocked: 'account_subject_day',
  promptpay_renewal_help_viewed: 'account_day',
  promptpay_renewal_paid: 'account_day',
  feature_used_before_purchase: 'account_subject_day',
  landing_viewed: 'account_day',
  trial_started: 'account',
  portfolio_created: 'account_day',
  /*
   * Per day, not per symbol. "Did they read about a stock today?" is the whole
   * question; recording which one would put a reader's interests in a telemetry
   * table to answer a question nobody asked.
   */
  stock_detail_viewed: 'account_day',
  tool_opened: 'account_subject_day',
  feature_used: 'account_subject_day',
  onboarding_path_chosen: 'account',
};

export type BetaPaymentRail = 'card' | 'promptpay';

export interface BetaFunnelEventInput {
  event: BetaFunnelEventKey;
  /** A billing plan key. Product configuration, never personal data. */
  planKey?: string | null;
  paymentRail?: BetaPaymentRail | null;
  /** A capability or surface identifier, e.g. `chart.vpvr`. Also configuration. */
  featureKey?: string | null;
  /**
   * The Bangkok calendar date, for the daily scopes. Supplied rather than read
   * from a clock so the composition stays pure and testable; the row's own
   * timestamp and date are still stamped by the database.
   */
  localDate: string;
  /**
   * Distinguishes one anonymous reader's event from another's, since there is no
   * account to key on. Ignored for authenticated events, whose key already
   * carries the account id.
   */
  anonymousRef?: string | null;
}

/** Only these characters survive into a dedupe key, so it can carry no payload. */
function safeSegment(value: string | null | undefined, max: number): string {
  if (!value) return '';
  return value.replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, max);
}

/**
 * Compose the dedupe scope the database keys on.
 *
 * The account id is *not* part of this string — the routine prepends it, from
 * the session, so a caller cannot compose a scope that collides with somebody
 * else's row and suppress their event.
 */
export function betaFunnelDedupeScope(input: BetaFunnelEventInput): string {
  const scope = BETA_FUNNEL_DEDUPE[input.event];
  const anonymous = safeSegment(input.anonymousRef, 24);

  switch (scope) {
    case 'account':
      return anonymous ? `once:${anonymous}` : 'once';
    case 'account_day':
      return `${input.localDate}${anonymous ? `:${anonymous}` : ''}`;
    case 'account_subject_day': {
      const subject = safeSegment(input.featureKey ?? input.planKey, 60) || 'none';
      return `${input.localDate}:${subject}${anonymous ? `:${anonymous}` : ''}`;
    }
  }
}

/**
 * Normalize a payload to exactly what the schema accepts, dropping anything else.
 *
 * Returns `null` for an unapproved key rather than throwing: a funnel event is
 * never important enough to fail the request it rode in on.
 */
export interface NormalizedFunnelEvent {
  event: BetaFunnelEventKey;
  planKey: string | null;
  paymentRail: BetaPaymentRail | null;
  featureKey: string | null;
  dedupeScope: string;
}

export function normalizeBetaFunnelEvent(input: BetaFunnelEventInput): NormalizedFunnelEvent | null {
  if (!isBetaFunnelEventKey(input.event)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.localDate)) return null;

  const rail = input.paymentRail === 'card' || input.paymentRail === 'promptpay'
    ? input.paymentRail
    : null;

  return {
    event: input.event,
    planKey: safeSegment(input.planKey, 40) || null,
    paymentRail: rail,
    featureKey: safeSegment(input.featureKey, 60) || null,
    dedupeScope: betaFunnelDedupeScope(input),
  };
}

/** The Bangkok calendar date an event belongs to. */
export function bangkokLocalDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
