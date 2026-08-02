import { z } from 'zod';

const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NEXT_PUBLIC_SUPABASE_URL: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.url().optional(),
  ),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(1).optional(),
  ),
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: z.preprocess(
    (value) => value === '' ? undefined : value,
    z.string().min(1).optional(),
  ),
});

const parsedClientEnv = clientEnvSchema.safeParse({
  NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
});

export const clientEnv = parsedClientEnv.success
  ? parsedClientEnv.data
  : clientEnvSchema.parse({ NEXT_PUBLIC_APP_ENV: 'development' });

export const clientEnvIssues = parsedClientEnv.success
  ? []
  : parsedClientEnv.error.issues.map((issue) => issue.message);

export const isSupabaseConfigured = Boolean(
  clientEnv.NEXT_PUBLIC_SUPABASE_URL && clientEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
);
