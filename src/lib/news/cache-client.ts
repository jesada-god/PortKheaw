import 'server-only';
import { Redis } from '@upstash/redis';
import { serverEnv } from '@/src/config/env/server';

/**
 * The four Redis operations this feature needs, and nothing else.
 *
 * Narrow on purpose: the summary store's whole correctness argument rests on
 * `SET NX EX` returning "you took it" versus "someone else holds it", and a
 * store written against the full Upstash surface could not be exercised by an
 * in-memory double without reimplementing that surface. Everything below is one
 * Redis command, so the double is a Map with expiry and nothing is faked away.
 */
export interface NewsCacheClient {
  /** `GET key`, JSON-decoded. `null` when absent or expired. */
  get<TValue>(key: string): Promise<TValue | null>;
  /** `SET key value EX ttl`, unconditional. */
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  /** `SET key value NX EX ttl` — `true` only for the caller that took the key. */
  setIfAbsent(key: string, value: unknown, ttlSeconds: number): Promise<boolean>;
  /** `DEL key`. */
  del(key: string): Promise<void>;
}

function toClient(redis: Redis): NewsCacheClient {
  return {
    get: (key) => redis.get(key),
    set: async (key, value, ttlSeconds) => {
      await redis.set(key, value, { ex: ttlSeconds });
    },
    setIfAbsent: async (key, value, ttlSeconds) =>
      await redis.set(key, value, { ex: ttlSeconds, nx: true }) === 'OK',
    del: async (key) => {
      await redis.del(key);
    },
  };
}

let cached: NewsCacheClient | null = null;
let cachedIdentity: string | undefined;

/**
 * The shared cache, or `null` when this deployment has no Redis configured.
 *
 * `null` is a supported state, not a failure: without Redis the News tab still
 * serves articles and simply never shows the AI card, because a per-instance
 * cache would neither hold the cross-user summary nor make the lock mean
 * anything across Vercel's serverless instances.
 */
export function getNewsCacheClient(): NewsCacheClient | null {
  const url = serverEnv.UPSTASH_REDIS_REST_URL;
  const token = serverEnv.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const identity = `${url}:${token}`;
  if (!cached || cachedIdentity !== identity) {
    cachedIdentity = identity;
    cached = toClient(new Redis({ url, token }));
  }
  return cached;
}
