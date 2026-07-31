import { z } from 'zod';

export const newsArticleSchema = z.object({
  id: z.string(), title: z.string().min(1), source: z.string().min(1),
  publishedAt: z.iso.datetime(), url: z.url(), imageUrl: z.url().nullable(),
  summary: z.string().nullable().optional(),
  symbols: z.array(z.string()), industries: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});
export const newsPageSchema = z.object({ articles: z.array(newsArticleSchema), nextCursor: z.string().nullable() });
export const newsDeliveryStatusSchema = z.enum(['live', 'cached', 'stale']);
export const newsProviderResultSchema = z.object({
  data: newsPageSchema,
  status: newsDeliveryStatusSchema,
  asOf: z.iso.datetime(),
});
export type NewsArticle = z.infer<typeof newsArticleSchema>;
export type NewsPage = z.infer<typeof newsPageSchema>;
export type NewsDeliveryStatus = z.infer<typeof newsDeliveryStatusSchema>;
export type NewsProviderResult = z.infer<typeof newsProviderResultSchema>;
export interface NewsProvider {
  readonly id: string;
  getMarketNews(cursor?: string): Promise<NewsProviderResult>;
  getSymbolNews(symbol: string, cursor?: string): Promise<NewsProviderResult>;
  getTopicNews?(topics: readonly string[], cursor?: string): Promise<NewsProviderResult>;
}
