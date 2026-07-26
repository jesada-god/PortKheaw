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
      MARKET_DATA_PROVIDER: read('MARKET_DATA_PROVIDER', optionalSecret, undefined),
      NEWS_API_KEY: read('NEWS_API_KEY', optionalSecret, undefined),
      SUPABASE_SERVICE_ROLE_KEY: read('SUPABASE_SERVICE_ROLE_KEY', optionalSecret, undefined),
      CRON_SECRET: read('CRON_SECRET', optionalSecret, undefined),
      WEB_PUSH_VAPID_PUBLIC_KEY: read('WEB_PUSH_VAPID_PUBLIC_KEY', optionalSecret, undefined),
      WEB_PUSH_VAPID_PRIVATE_KEY: read('WEB_PUSH_VAPID_PRIVATE_KEY', optionalSecret, undefined),
      WEB_PUSH_SUBJECT: read('WEB_PUSH_SUBJECT', optionalSubject, undefined),
    },
    issues,
  };
}

const parsedServerEnv = parseServerEnv(process.env);

// Invalid optional integrations are isolated so one bad value cannot disable
// unrelated valid provider credentials.
export const serverEnv = parsedServerEnv.data;
export const serverEnvIssues = parsedServerEnv.issues;
