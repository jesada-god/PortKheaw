import { selectLatestNews } from './feed';
import type { NewsArticle } from './types';

export const MARKET_WIDE_NEWS_LIMIT = 5;
export const MARKET_WIDE_RELEVANCE_THRESHOLD = 4;

const MACRO_PATTERNS = [
  /\b(?:federal reserve|fed|fomc|interest rates?|rate (?:cut|hike|decision))\b/i,
  /\b(?:inflation|cpi|pce|payrolls?|nonfarm|jobs report|unemployment|gdp|recession)\b/i,
  /\b(?:treasury|bond yields?|10-year yield|yield curve|us dollar|dollar index|dxy)\b/i,
  /\b(?:crude oil|oil prices?|commodit(?:y|ies)|gold prices?)\b/i,
  /\b(?:geopolitic|war|conflict|sanctions?|tariffs?|trade war)\b/i,
  /\b(?:systemic risk|financial stability|bank crisis|credit crisis|default|government shutdown)\b/i,
  /\b(?:regulation|regulator|antitrust|securities and exchange commission|\bsec\b)\b/i,
];

const MARKET_PATTERNS = [
  /\b(?:stock market|financial markets?|global markets?|equities|wall street)\b/i,
  /\b(?:s&p ?500|nasdaq|dow jones|russell 2000|index futures?|major indices)\b/i,
  /\b(?:stocks|shares)\b.*\b(?:rally|selloff|slump|surge|fall|rise|drop)\b/i,
];

const LOW_SIGNAL_PATTERNS = [
  /\b(?:stocks? to buy|stocks? to sell|buy rating|sell rating|price target|trading signal)\b/i,
  /\b(?:contract win|partnership agreement|quarterly earnings|earnings beat|earnings miss)\b/i,
];

function articleText(article: NewsArticle): string {
  return [
    article.title,
    article.summary ?? '',
    ...(article.tags ?? []),
    ...article.symbols,
    ...(article.industries ?? []),
  ].join(' ');
}

export function marketNewsRelevanceScore(article: NewsArticle): number {
  const text = articleText(article);
  const macroHits = MACRO_PATTERNS.filter((pattern) => pattern.test(text)).length;
  const marketHits = MARKET_PATTERNS.filter((pattern) => pattern.test(text)).length;
  const penalty = LOW_SIGNAL_PATTERNS.some((pattern) => pattern.test(text)) ? 5 : 0;
  return Math.min(6, macroHits * 3) + Math.min(4, marketHits * 2) - penalty;
}

/**
 * A dashboard story must establish both a market-wide subject and a material
 * macro/systemic catalyst. Single-stock recommendations and routine company
 * updates remain excluded even when their copy happens to contain "stocks".
 */
export function selectMarketWideNews(
  articles: readonly NewsArticle[],
  limit = MARKET_WIDE_NEWS_LIMIT,
): NewsArticle[] {
  const relevant = articles
    .map((article) => ({ article, score: marketNewsRelevanceScore(article) }))
    .filter(({ article, score }) =>
      score >= MARKET_WIDE_RELEVANCE_THRESHOLD
      && MARKET_PATTERNS.some((pattern) => pattern.test(articleText(article)))
      && !LOW_SIGNAL_PATTERNS.some((pattern) => pattern.test(articleText(article)))
    )
    .sort((left, right) => right.score - left.score)
    .map(({ article }) => article);
  // selectLatestNews performs canonical URL/title/id de-duplication and final
  // newest-first ordering after relevance has admitted the story.
  return selectLatestNews(relevant, limit);
}
