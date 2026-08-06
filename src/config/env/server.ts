import 'server-only';
import { z } from 'zod';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';

const optionalUrl = z.preprocess(
  (value) => value === '' ? undefined : value,
  z.url().optional(),
);

const optionalSecret = z.preprocess(
  (value) => value === '' ? undefined : value,
  z.string().min(1).optional(),
);

const optionalSubject = z.preprocess(
  (value) => value === '' ? undefined : value,
  z.string().min(1).optional(),
);

const geminiModel = z.preprocess(
  (value) => typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_GEMINI_MODEL,
  z.string().min(1),
);

export function parseServerEnv(input: Record<string, unknown>) {
  const issues: Array<{ path: string; message: string }> = [];

  function read<T>(
    path: string,
    schema: z.ZodType<T>,
    fallback: T,
  ): T {
    const result = schema.safeParse(input[path]);

    if (result.success) {
      return result.data;
    }

    issues.push(
      ...result.error.issues.map((issue) => ({
        path,
        message: issue.message,
      })),
    );

    return fallback;
  }

  return {
    data: {
      APP_URL: read('APP_URL', optionalUrl, undefined),
      GEMINI_API_KEY: read('GEMINI_API_KEY', optionalSecret, undefined),
      GEMINI_MODEL: read('GEMINI_MODEL', geminiModel, DEFAULT_GEMINI_MODEL),
      ALPHA_VANTAGE_API_KEY: read('ALPHA_VANTAGE_API_KEY', optionalSecret, undefined),
      FMP_API_KEY: read('FMP_API_KEY', optionalSecret, undefined),
      FINNHUB_API_KEY: read('FINNHUB_API_KEY', optionalSecret, undefined),
      SEC_USER_AGENT: read('SEC_USER_AGENT', optionalSecret, undefined),
      POLYGON_API_KEY: read('POLYGON_API_KEY', optionalSecret, undefined),
      ALPACA_API_KEY_ID: read('ALPACA_API_KEY_ID', optionalSecret, undefined),
      ALPACA_API_SECRET_KEY: read('ALPACA_API_SECRET_KEY', optionalSecret, undefined),
      // Alpaca serves the options contracts catalogue from the Trading API. Paper
      // and live hosts expose the same catalogue, so this defaults to paper and is
      // only overridden when the deployment holds live trading credentials.
      ALPACA_TRADING_BASE_URL: read('ALPACA_TRADING_BASE_URL', optionalUrl, undefined),
      // Options market-data feed. Left unset the adapter uses `indicative`, the
      // only feed this account is entitled to: a live probe returned HTTP 403
      // "OPRA agreement is not signed" for `opra`. Override once OPRA is signed.
      ALPACA_OPTIONS_FEED: read('ALPACA_OPTIONS_FEED', optionalSecret, undefined),
      MARKET_DATA_PROVIDER: read('MARKET_DATA_PROVIDER', optionalSecret, undefined),
      NEWS_API_KEY: read('NEWS_API_KEY', optionalSecret, undefined),
      SUPABASE_SERVICE_ROLE_KEY: read('SUPABASE_SERVICE_ROLE_KEY', optionalSecret, undefined),
      CRON_SECRET: read('CRON_SECRET', optionalSecret, undefined),
      /*
       * The key the persistent trial ledger is written with.
       *
       * It is what stops that ledger from being a list of email addresses: the
       * rows hold a keyed digest, and without this value a copy of the table
       * cannot be turned back into a mailbox. Optional here like every other
       * integration — but unlike the others, its absence closes a feature rather
       * than degrading one: with no key the trial cannot be recorded, and a
       * trial that cannot be recorded is not granted.
       *
       * Rotating it means bumping `TRIAL_IDENTITY_HASH_VERSION`; the old rows
       * stay valid under their own version and keep blocking.
       */
      TRIAL_IDENTITY_HMAC_SECRET: read('TRIAL_IDENTITY_HMAC_SECRET', optionalSecret, undefined),
      NEXT_PUBLIC_VAPID_PUBLIC_KEY: read('NEXT_PUBLIC_VAPID_PUBLIC_KEY', optionalSecret, undefined),
      VAPID_PRIVATE_KEY: read('VAPID_PRIVATE_KEY', optionalSecret, undefined),
      VAPID_SUBJECT: read('VAPID_SUBJECT', optionalSubject, undefined),
      /*
       * Billing.
       *
       * Every one of these is optional, and that is the point: with none of them
       * set the product runs exactly as it did before paid plans existed, and
       * the subscription page says so rather than offering a checkout that
       * cannot complete. `BILLING_ENABLED` is a separate explicit switch on top
       * of the credentials, so a half-populated environment — a key present but
       * no webhook secret yet — cannot start taking money by accident.
       *
       * None of these values ever leave the server. The browser is told only
       * which plan keys are purchasable, never why.
       */
      BILLING_ENABLED: read('BILLING_ENABLED', optionalSecret, undefined),
      BILLING_PROVIDER_MODE: read('BILLING_PROVIDER_MODE', optionalSecret, undefined),
      BILLING_CHECKOUT_MODE: read('BILLING_CHECKOUT_MODE', optionalSecret, undefined),
      BILLING_INTERNAL_USER_IDS: read('BILLING_INTERNAL_USER_IDS', optionalSecret, undefined),
      BILLING_RETURN_ORIGIN: read('BILLING_RETURN_ORIGIN', optionalUrl, undefined),
      /*
       * The PromptPay rail's off switch, and the one billing variable that is on
       * by default. It guards a provider *capability* rather than a credential:
       * with everything else configured, the rail works, and this exists so it
       * can be withdrawn without a redeploy if the provider account's Thai
       * activation is ever removed. Set it to `false` to sell by card only.
       */
      BILLING_PROMPTPAY_ENABLED: read('BILLING_PROMPTPAY_ENABLED', optionalSecret, undefined),
      STRIPE_SECRET_KEY: read('STRIPE_SECRET_KEY', optionalSecret, undefined),
      STRIPE_WEBHOOK_SECRET: read('STRIPE_WEBHOOK_SECRET', optionalSecret, undefined),
      STRIPE_PRICE_PRO_MONTHLY: read('STRIPE_PRICE_PRO_MONTHLY', optionalSecret, undefined),
      STRIPE_PRICE_PRO_ANNUAL: read('STRIPE_PRICE_PRO_ANNUAL', optionalSecret, undefined),
      STRIPE_PRICE_ELITE_MONTHLY: read('STRIPE_PRICE_ELITE_MONTHLY', optionalSecret, undefined),
      STRIPE_PRICE_ELITE_ANNUAL: read('STRIPE_PRICE_ELITE_ANNUAL', optionalSecret, undefined),
      /*
       * Founder's Club is a one-invoice coupon applied on top of the ordinary
       * annual price — never a second, cheaper price. That is what guarantees
       * the second year bills at the full rate: the subscription is on the full
       * price from the first day, and the discount simply stops applying.
       */
      STRIPE_COUPON_FOUNDER_PRO: read('STRIPE_COUPON_FOUNDER_PRO', optionalSecret, undefined),
      STRIPE_COUPON_FOUNDER_ELITE: read('STRIPE_COUPON_FOUNDER_ELITE', optionalSecret, undefined),
      /*
       * Error monitoring. Optional, like every integration above, and for the
       * same reason: the product must run without it. With no DSN configured the
       * reporter still runs and still sanitizes — it writes a structured line to
       * the platform's own logs instead of shipping an event — so the capture
       * points, the redaction and its tests are all exercised whether or not a
       * provider is ever connected.
       *
       * `SENTRY_DSN` is a *public* DSN: it authorizes writing events and nothing
       * else. It is still read server-side only, because there is no reason for a
       * browser to hold it and a public ingest endpoint invites noise.
       */
      SENTRY_DSN: read('SENTRY_DSN', optionalUrl, undefined),
      SENTRY_ENVIRONMENT: read('SENTRY_ENVIRONMENT', optionalSecret, undefined),
    },
    issues,
  };
}

const parsedServerEnv = parseServerEnv(process.env);

// Invalid optional integrations are isolated so one bad value cannot disable
// unrelated valid provider credentials.
export const serverEnv = parsedServerEnv.data;
export const serverEnvIssues = parsedServerEnv.issues;
