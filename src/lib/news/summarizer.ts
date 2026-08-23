import 'server-only';
import { GoogleGenAI, Type, type Schema } from '@google/genai';
import { z } from 'zod';
import { serverEnv } from '@/src/config/env/server';
import type { NewsArticle } from './types';
import {
  newsSummarySchema,
  type NewsSummary,
  type NewsSummaryPoint,
  type NewsSummarySource,
} from './summary-types';

/**
 * The model this feature calls, resolved at call time rather than pinned.
 *
 * A literal here is a slow-motion outage: Google retires model ids on its own
 * schedule, and a name compiled into the bundle can only be corrected by a
 * deploy. `GEMINI_MODEL` is the deployment's Gemini model and moves both
 * features together; `GEMINI_NEWS_MODEL` is the escape hatch for when the
 * summary wants a different one — a larger model for a while, or a pin that
 * holds this feature still while the translator moves. Unset is the normal
 * state, and `GEMINI_MODEL` itself always resolves (`server.ts` supplies
 * `DEFAULT_GEMINI_MODEL` when it is blank), so this never returns undefined.
 */
export function newsSummaryModel(): string {
  return serverEnv.GEMINI_NEWS_MODEL ?? serverEnv.GEMINI_MODEL;
}

export const NEWS_SUMMARY_TEMPERATURE = 0.2;
export const NEWS_SUMMARY_MAX_OUTPUT_TOKENS = 800;
/** Article body handed to the model, per article. */
export const NEWS_SUMMARY_CONTENT_CHARS = 1_500;
/** How many articles the model is allowed to choose its 3-4 bullets from. */
export const NEWS_SUMMARY_INPUT_COUNT = 6;
const NEWS_SUMMARY_TIMEOUT_MS = 20_000;
const NEWS_SUMMARY_RETRY_BASE_MS = 500;
/**
 * Two headlines are the same story when this much of the shorter one's
 * vocabulary also appears in the longer one. Aggregators republish a wire story
 * with a trailing clause added or removed, which is why the denominator is the
 * SHORTER title: Jaccard would score "Acme beats on earnings" against "Acme
 * beats on earnings, raises full-year outlook" at 0.57 and let both through.
 */
const TITLE_OVERLAP_DUPLICATE = 0.6;

/**
 * The house rules, with the only two lines that can differ left as holes.
 *
 * Everything that makes this summary safe to publish — nothing outside the
 * articles, no buy/sell call, no price forecast, Thai prose with company and
 * technical names left in English, one single-line bullet per article — is
 * identical for every surface and is written once here. A new surface chooses
 * only its angle: who it is speaking to, and what the overview is about. It does
 * not get to relax rule 1, 5, 6 or 7 by rewriting the list.
 */
function newsSummarySystemInstruction(role: string, overviewRule: string): string {
  return [
    role,
    '1. สรุปเฉพาะจากข่าวที่ให้มาเท่านั้น ห้ามเพิ่มข้อมูล ตัวเลข หรือเหตุการณ์จากความรู้ของตัวเอง',
    '2. ถ้าข่าวไหนเนื้อหาไม่พอ ให้เขียนเท่าที่หัวข้อข่าวบอกจริง อย่าเดา',
    `3. ${overviewRule}`,
    '4. points 3-4 ข้อ ข้อละไม่เกิน 1 บรรทัด 1 ข้อ = 1 ข่าว ห้ามสองข้อชี้ source_index เดียวกัน',
    '5. ห้ามคัดลอกประโยคจากต้นฉบับ เรียบเรียงใหม่เป็นภาษาไทย ชื่อบริษัท/ผลิตภัณฑ์/คำเฉพาะทางคงภาษาอังกฤษ',
    '6. ห้ามแนะนำซื้อ/ขาย/ถือ ห้ามคาดการณ์ราคา ถ้าต้นฉบับทำ ให้รายงานว่า "นักวิเคราะห์รายนี้มองว่า..."',
    '7. น้ำเสียงเป็นกลาง ไม่ hype',
  ].join('\n');
}

/** Stock Detail: the news of one company, for a holder of that company. */
export const SYMBOL_NEWS_SYSTEM_INSTRUCTION = newsSummarySystemInstruction(
  'คุณคือผู้ช่วยสรุปข่าวหุ้นสำหรับแอป PortKheaw ผู้อ่านเป็นนักลงทุนรายย่อยชาวไทย',
  'overview ไม่เกิน 2 บรรทัด บอกว่าตลาดกำลังโฟกัสอะไร',
);

/**
 * Dashboard: the same rules pointed at the market rather than at a company.
 *
 * The feed behind this one is already filtered to market-wide stories, so the
 * failure mode worth naming in the prompt is the model narrating whichever
 * single company happens to appear in a headline instead of the macro story the
 * headline is an instance of.
 */
export const MARKET_NEWS_SYSTEM_INSTRUCTION = newsSummarySystemInstruction(
  'คุณคือผู้ช่วยสรุปภาพรวมข่าวตลาดหุ้นสำหรับแอป PortKheaw ผู้อ่านเป็นนักลงทุนรายย่อยชาวไทย',
  'overview ไม่เกิน 2 บรรทัด บอกว่าภาพรวมตลาดกำลังโฟกัสอะไร ไม่ใช่ข่าวของบริษัทใดบริษัทหนึ่ง',
);

/** Structured output, enforced by the API rather than asked for in the prompt. */
export const NEWS_SUMMARY_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    overview: { type: Type.STRING },
    points: {
      type: Type.ARRAY,
      minItems: '3',
      maxItems: '4',
      items: {
        type: Type.OBJECT,
        properties: {
          text: { type: Type.STRING },
          source_index: { type: Type.INTEGER },
        },
        required: ['text', 'source_index'],
        propertyOrdering: ['text', 'source_index'],
      },
    },
  },
  required: ['overview', 'points'],
  propertyOrdering: ['overview', 'points'],
};

/** The model's own vocabulary — snake_case, and indexes into the prompt blocks. */
const modelResponseSchema = z.object({
  overview: z.string(),
  points: z.array(z.object({
    text: z.string(),
    source_index: z.number(),
  })),
});

/** Tokens a reader would recognise as the headline, case and punctuation aside. */
function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .split(' ')
      .filter(Boolean),
  );
}

function titleOverlap(left: Set<string>, right: Set<string>): number {
  const smaller = left.size <= right.size ? left : right;
  const larger = smaller === left ? right : left;
  if (!smaller.size) return 0;
  let shared = 0;
  for (const token of smaller) if (larger.has(token)) shared += 1;
  return shared / smaller.size;
}

/**
 * Drop the republished copies before spending tokens on them.
 *
 * `selectLatestNews` already collapses identical links and identical headlines;
 * what survives it is the aggregator that files the same story under a reworded
 * headline. Input order is preserved and the FIRST occurrence wins, so with a
 * newest-first feed the surviving copy is the most recent one.
 */
export function dedupeArticlesForSummary(
  articles: readonly NewsArticle[],
  limit: number = NEWS_SUMMARY_INPUT_COUNT,
): NewsArticle[] {
  const kept: Array<{ article: NewsArticle; tokens: Set<string> }> = [];
  for (const article of articles) {
    if (kept.length >= limit) break;
    const tokens = titleTokens(article.title);
    if (kept.some((seen) => titleOverlap(seen.tokens, tokens) > TITLE_OVERLAP_DUPLICATE)) continue;
    kept.push({ article, tokens });
  }
  return kept.map((entry) => entry.article);
}

/** Numbered blocks; the numbers ARE the `source_index` the model must cite. */
export function buildNewsSummaryPrompt(articles: readonly NewsArticle[]): string {
  return articles
    .map((article, index) => [
      `[${index}]`,
      `title: ${article.title}`,
      `source: ${article.source}`,
      `published_at: ${article.publishedAt}`,
      `content: ${(article.summary ?? '').slice(0, NEWS_SUMMARY_CONTENT_CHARS)}`,
    ].join('\n'))
    .join('\n\n');
}

function toSource(article: NewsArticle): NewsSummarySource {
  return {
    title: article.title,
    source: article.source,
    url: article.url,
    publishedAt: article.publishedAt,
  };
}

/**
 * Turn the model's answer into a summary, or into nothing.
 *
 * The model is told each bullet is one article and that no two may cite the same
 * one, so a repeated or out-of-range `source_index` means the answer is not
 * describing the articles it was given. Those bullets are dropped rather than
 * renumbered — renumbering would attach a sentence to an article that did not
 * produce it — and under two survivors the whole summary is discarded.
 *
 * `sources` is renumbered in citation order, so the card's [1][2][3] read down
 * the bullets in order instead of exposing the prompt's own block numbers.
 */
export function parseNewsSummaryResponse(
  raw: string | undefined,
  articles: readonly NewsArticle[],
  generatedAt: string,
): NewsSummary | null {
  if (!raw?.trim()) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = modelResponseSchema.safeParse(payload);
  if (!parsed.success) return null;

  const overview = parsed.data.overview.trim();
  if (!overview) return null;

  const cited = new Set<number>();
  const points: NewsSummaryPoint[] = [];
  const sources: NewsSummarySource[] = [];
  for (const point of parsed.data.points) {
    if (points.length >= 4) break;
    const index = point.source_index;
    const text = point.text.trim();
    if (!text) continue;
    if (!Number.isInteger(index) || index < 0 || index >= articles.length) continue;
    if (cited.has(index)) continue;
    cited.add(index);
    points.push({ text, sourceIndex: sources.length });
    sources.push(toSource(articles[index]));
  }
  if (points.length < 2) return null;

  const summary = newsSummarySchema.safeParse({ overview, points, sources, generatedAt });
  return summary.success ? summary.data : null;
}

/** The one call this module makes, isolated so tests never reach the network. */
export type NewsSummaryModelCall = (prompt: string) => Promise<string | undefined>;

function retryableStatus(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && (status === 429 || (status >= 500 && status < 600));
}

export interface SummarizeNewsOptions {
  articles: readonly NewsArticle[];
  callModel: NewsSummaryModelCall;
  now?: () => Date;
  /** Injected by tests so the backoff does not cost a real half-second. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Summarize a symbol's news, or return `null` because the answer could not be
 * trusted. Throws only when the provider itself failed — the caller uses that
 * difference to decide whether an immediate retry is worth allowing.
 *
 * This module never reads or writes a cache: see `summary-store.ts`.
 */
export async function summarizeNews({
  articles,
  callModel,
  now = () => new Date(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: SummarizeNewsOptions): Promise<NewsSummary | null> {
  const selected = dedupeArticlesForSummary(articles);
  // Three articles is the floor for three single-source bullets.
  if (selected.length < 3) return null;

  const prompt = buildNewsSummaryPrompt(selected);
  let raw: string | undefined;
  try {
    raw = await callModel(prompt);
  } catch (error) {
    // One retry, and only for the two statuses that mean "ask again later".
    if (!retryableStatus(error)) throw error;
    await sleep(NEWS_SUMMARY_RETRY_BASE_MS);
    raw = await callModel(prompt);
  }
  return parseNewsSummaryResponse(raw, selected, now().toISOString());
}

export interface GeminiNewsSummaryCallOptions {
  /** Which set of house rules to speak under — see the instructions above. */
  systemInstruction: string;
  model?: string;
}

/** Binds the pinned generation config to a real Gemini client. */
export function createGeminiNewsSummaryCall(
  apiKey: string,
  { systemInstruction, model = newsSummaryModel() }: GeminiNewsSummaryCallOptions,
): NewsSummaryModelCall {
  const client = new GoogleGenAI({ apiKey });
  return async (prompt) => {
    const response = await client.models.generateContent({
      model,
      contents: prompt,
      config: {
        systemInstruction,
        temperature: NEWS_SUMMARY_TEMPERATURE,
        maxOutputTokens: NEWS_SUMMARY_MAX_OUTPUT_TOKENS,
        responseMimeType: 'application/json',
        responseSchema: NEWS_SUMMARY_RESPONSE_SCHEMA,
        abortSignal: AbortSignal.timeout(NEWS_SUMMARY_TIMEOUT_MS),
      },
    });
    return response.text;
  };
}
