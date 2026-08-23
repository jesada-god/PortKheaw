import { z } from 'zod';

/**
 * The AI summary as it travels from the summarizer through the Redis record and
 * the API route to the card. Deliberately free of `server-only` so the client
 * component can hold the same type the route serialises.
 *
 * `sourceIndex` is a position in `sources`, not in the news feed: the feed the
 * reader is looking at can have moved on since the summary was cached, so every
 * cited article carries its own link and headline here rather than being looked
 * up by index later.
 */
export const newsSummaryPointSchema = z.object({
  text: z.string().min(1),
  sourceIndex: z.number().int().min(0),
});

export const newsSummarySourceSchema = z.object({
  title: z.string().min(1),
  source: z.string().min(1),
  url: z.url(),
  publishedAt: z.iso.datetime(),
});

export const newsSummarySchema = z.object({
  overview: z.string().min(1),
  /*
   * Two, not the three the model is asked for: `points` here is what SURVIVED
   * validation (in-range, non-repeating `source_index`), and the summarizer
   * throws the whole summary away below two. A card built from one bullet is
   * not the feature.
   */
  points: z.array(newsSummaryPointSchema).min(2).max(4),
  sources: z.array(newsSummarySourceSchema).min(2).max(4),
  generatedAt: z.iso.datetime(),
});

export type NewsSummaryPoint = z.infer<typeof newsSummaryPointSchema>;
export type NewsSummarySource = z.infer<typeof newsSummarySourceSchema>;
export type NewsSummary = z.infer<typeof newsSummarySchema>;

/** What the API route sends for the summary card: `null` is a normal outcome. */
export const newsSummaryPayloadSchema = z.object({
  summary: newsSummarySchema,
  /** The stored summary was served while another request regenerates it. */
  stale: z.boolean(),
});

export type NewsSummaryPayload = z.infer<typeof newsSummaryPayloadSchema>;
