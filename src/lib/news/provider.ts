import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { serverEnv } from '@/src/config/env/server';
import { SharedRequestCache } from '@/src/lib/shared-request-cache';
import { NEWS_MAX_COUNT, selectLatestNews } from './feed';
import { safeExternalUrl } from './url';
import type {
  NewsArticle,
  NewsProvider,
  NewsProviderResult,
} from './types';

export type NewsErrorCode =
  | 'NEWS_PROVIDER_NOT_CONFIGURED'
  | 'NEWS_PROVIDER_INVALID_KEY'
  | 'NEWS_PROVIDER_RATE_LIMITED'
  | 'NEWS_PROVIDER_TIMEOUT'
  | 'NEWS_PROVIDER_UPSTREAM_FAILURE';
export class NewsProviderError extends Error {
  constructor(readonly code: NewsErrorCode, message: string, readonly retryAfterSeconds?: number) { super(message); this.name = 'NewsProviderError'; }
  get status() {
    if (this.code === 'NEWS_PROVIDER_NOT_CONFIGURED') return 503;
    if (this.code === 'NEWS_PROVIDER_RATE_LIMITED') return 429;
    return 502;
  }
  get retryable() {
    return this.code === 'NEWS_PROVIDER_RATE_LIMITED'
      || this.code === 'NEWS_PROVIDER_TIMEOUT'
      || this.code === 'NEWS_PROVIDER_UPSTREAM_FAILURE';
  }
}

const articleSchema = z.object({
  source: z.object({ name: z.string().nullish() }), title: z.string().nullish(), url: z.string().nullish(),
  description: z.string().nullish().optional(), urlToImage: z.string().nullish(), publishedAt: z.string().nullish(),
});
const responseSchema = z.object({ status: z.literal('ok'), articles: z.array(articleSchema) });
const errorSchema = z.object({ status: z.literal('error'), code: z.string().optional(), message: z.string().optional() });
const PAGE_SIZE = 30;

/**
 * NewsAPI keeps articles whose content the publisher withdrew, replacing every
 * field with the literal `[Removed]` tombstone. Those carry no story and no image,
 * so they are dropped instead of reaching the reader as an empty card.
 */
function isRemovedArticle(title: string, url: string): boolean {
  return /^\[removed\]$/i.test(title) || new URL(url).hostname === 'removed.com';
}

function retryAfter(response: Response): number | undefined {
  const value = Number(response.headers.get('retry-after')); return Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined;
}

export class NewsApiProvider implements NewsProvider {
  readonly id = 'newsapi';
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async get(query: string, cursor = '1'): Promise<NewsProviderResult> {
    const page = Math.max(1, Number.parseInt(cursor, 10) || 1);
    const url = new URL('https://newsapi.org/v2/everything');
    url.searchParams.set('q', query); url.searchParams.set('searchIn', 'title,description');
    url.searchParams.set('language', 'en'); url.searchParams.set('sortBy', 'publishedAt');
    url.searchParams.set('pageSize', String(PAGE_SIZE)); url.searchParams.set('page', String(page));
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: { Accept: 'application/json', 'X-Api-Key': this.apiKey }, signal: AbortSignal.timeout(8_000), cache: 'no-store' });
    } catch (cause) {
      if (cause instanceof Error && (cause.name === 'AbortError' || cause.name === 'TimeoutError')) throw new NewsProviderError('NEWS_PROVIDER_TIMEOUT', 'News provider timed out');
      throw new NewsProviderError('NEWS_PROVIDER_UPSTREAM_FAILURE', 'Could not reach news provider');
    }
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new NewsProviderError('NEWS_PROVIDER_UPSTREAM_FAILURE', 'News provider returned invalid data'); }
    const providerError = errorSchema.safeParse(payload);
    const code = providerError.success ? providerError.data.code ?? '' : '';
    if (response.status === 429 || /rateLimited|maximumResultsReached|apiKeyExhausted/i.test(code)) throw new NewsProviderError('NEWS_PROVIDER_RATE_LIMITED', 'News provider rate limit exceeded', retryAfter(response) ?? 60);
    if (response.status === 401 || response.status === 403 || /apiKeyInvalid|apiKeyMissing|apiKeyDisabled/i.test(code)) throw new NewsProviderError('NEWS_PROVIDER_INVALID_KEY', 'News provider rejected its API key');
    if (!response.ok) throw new NewsProviderError('NEWS_PROVIDER_UPSTREAM_FAILURE', 'News provider is temporarily unavailable');
    const parsed = responseSchema.safeParse(payload);
    if (!parsed.success) throw new NewsProviderError('NEWS_PROVIDER_UPSTREAM_FAILURE', 'News provider returned invalid data');
    const articles: NewsArticle[] = [];
    for (const item of parsed.data.articles) {
      const title = item.title?.trim(); const externalUrl = safeExternalUrl(item.url); const date = item.publishedAt ? new Date(item.publishedAt) : null;
      if (!title || !externalUrl || !date || Number.isNaN(date.valueOf()) || isRemovedArticle(title, externalUrl)) continue;
      const key = `${title.toLowerCase()}|${externalUrl}`;
      // `urlToImage` is the provider's own article image: mapped verbatim when it
      // is a usable link, and left null when the publisher supplied none. No image
      // is ever substituted or borrowed from another article.
      articles.push({
        id: createHash('sha256').update(key).digest('hex').slice(0, 20),
        title,
        summary: item.description?.trim() || null,
        source: item.source.name?.trim() || new URL(externalUrl).hostname,
        publishedAt: date.toISOString(),
        url: externalUrl,
        imageUrl: safeExternalUrl(item.urlToImage),
        symbols: [],
        tags: [],
      });
    }
    return {
      data: {
        // One ordering/de-duplication rule for every consumer, applied where the
        // data enters the system rather than in each UI.
        articles: selectLatestNews(articles, PAGE_SIZE),
        nextCursor: parsed.data.articles.length === PAGE_SIZE ? String(page + 1) : null,
      },
      status: 'live',
      asOf: this.now().toISOString(),
    };
  }
  getMarketNews(cursor?: string) {
    return this.get(
      '(Federal Reserve OR FOMC OR inflation OR CPI OR PCE OR payrolls OR GDP OR Treasury OR oil OR geopolitics OR regulation) AND (stock market OR Wall Street OR S&P 500 OR Nasdaq OR Dow)',
      cursor,
    );
  }
  getSymbolNews(symbol: string, cursor?: string) { return this.get(`(${symbol} AND (stock OR company))`, cursor); }
  getTopicNews(topics: readonly string[], cursor?: string) {
    const normalized = [...new Set(topics.map((topic) => topic.trim()).filter(Boolean))]
      .slice(0, 8);
    if (!normalized.length) return this.getMarketNews(cursor);
    const query = normalized
      .map((topic) => `"${topic.replace(/["\\]/g, ' ')}"`)
      .join(' OR ');
    return this.get(`(${query}) AND (stock OR company OR market)`, cursor);
  }
}

const newsCache = new SharedRequestCache();
let configuredKey: string | undefined; let instance: NewsProvider | undefined;
export class CachedNewsProvider implements NewsProvider {
  readonly id: string;
  constructor(
    private readonly source: NewsProvider,
    private readonly cache: SharedRequestCache = newsCache,
  ) {
    this.id = source.id;
  }
  private async load(key: string, operation: () => Promise<NewsProviderResult>) {
    const resolution = await this.cache.resolve(key, operation, {
      freshMs: 5 * 60_000,
      staleMs: 60 * 60_000,
      errorMs: 30_000,
    });
    return {
      ...resolution.value,
      status: resolution.state === 'fresh'
        ? resolution.value.status
        : resolution.state === 'stale' ? 'stale' : 'cached',
    } satisfies NewsProviderResult;
  }
  getMarketNews(cursor = '1') { return this.load(`market:${cursor}`, () => this.source.getMarketNews(cursor)); }
  getSymbolNews(symbol: string, cursor = '1') { return this.load(`symbol:${symbol}:${cursor}`, () => this.source.getSymbolNews(symbol, cursor)); }
  getTopicNews(topics: readonly string[], cursor = '1') {
    const normalized = [...new Set(topics.map((topic) => topic.trim()).filter(Boolean))]
      .slice(0, 8);
    return this.load(
      `topics:${normalized.join('|')}:${cursor}`,
      () => this.source.getTopicNews
        ? this.source.getTopicNews(normalized, cursor)
        : this.source.getMarketNews(cursor),
    );
  }
}
export function getNewsProvider(): NewsProvider {
  // Deliberately never borrow ALPHA_VANTAGE_API_KEY: market quota is reserved for market data.
  const key = serverEnv.NEWS_API_KEY;
  if (!key) throw new NewsProviderError('NEWS_PROVIDER_NOT_CONFIGURED', 'News provider configuration is required');
  if (!instance || configuredKey !== key) { configuredKey = key; instance = new CachedNewsProvider(new NewsApiProvider(key)); }
  return instance;
}
