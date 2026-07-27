/**
 * News feed probe.
 *
 * Answers, against a real deployment and real symbols, the questions the News
 * section makes to the reader: does `/api/news` return real articles for any
 * symbol, are they newest-first with no duplicate story, is the feed capped at the
 * ten the UI can expand to, and do the thumbnails point at images that actually
 * load from the publisher's CDN?
 *
 * Ordering and de-duplication are re-checked with the very functions the UI uses
 * (`selectLatestNews`), and image URLs are fetched for real — nothing is mocked
 * and no value is invented. A failure is reported as a failure and the process
 * exits non-zero.
 *
 * Run: npm run probe:news -- <base-url> [SYMBOL...]
 *   e.g. npm run probe:news -- https://example.vercel.app NVDA RKLB AAPL
 */

import { NEWS_MAX_COUNT, NEWS_PREVIEW_COUNT, selectLatestNews } from '@/src/lib/news/feed';
import { newsPageSchema } from '@/src/lib/news/types';
import { shouldRenderNewsImage } from '@/src/components/news/news-policy';

const [baseArg, ...symbolArgs] = process.argv.slice(2);
if (!baseArg || !/^https?:\/\//.test(baseArg)) {
  console.error('Usage: npm run probe:news -- <base-url> [SYMBOL...]');
  process.exit(2);
}
const BASE = baseArg.replace(/\/+$/, '');
const SYMBOLS = symbolArgs.filter((value) => /^[A-Za-z][A-Za-z0-9.\-]*$/.test(value));
const TARGETS: Array<string | null> = [null, ...(SYMBOLS.length ? SYMBOLS : ['NVDA', 'RKLB', 'AAPL'])];

interface Row {
  feed: string;
  status: number | string;
  provider: string;
  delivery: string;
  articles: number | string;
  ordered: string;
  unique: string;
  capped: string;
  images: string;
  preview: string;
}

type ImageOutcome = 'loads' | 'blocked' | 'broken';

const rows: Row[] = [];
let failures = 0;

function fail(message: string): string {
  failures += 1;
  return message;
}

/**
 * Fetches a thumbnail the way the card does — cross-origin, no referrer — and
 * separates the two very different outcomes:
 *
 * - `blocked`: the publisher refuses hotlinking (Cloudflare 401/403/451 on
 *   `biztoc.com`, for one). Their call, not a defect here; the card hides the
 *   optional thumbnail.
 * - `broken`: the link is dead or serves something that is not an image.
 */
async function checkImage(url: string): Promise<ImageOutcome> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
      referrer: '',
      signal: AbortSignal.timeout(10_000),
    });
    if ([401, 403, 451].includes(response.status)) return 'blocked';
    if (!response.ok) return 'broken';
    const type = response.headers.get('content-type') ?? '';
    await response.arrayBuffer();
    return type.startsWith('image/') ? 'loads' : 'broken';
  } catch {
    return 'broken';
  }
}

async function main(): Promise<void> {
for (const symbol of TARGETS) {
  const feed = symbol ?? 'market';
  const url = `${BASE}/api/news${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ''}`;
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  } catch (cause) {
    rows.push({ feed, status: fail('unreachable'), provider: '—', delivery: '—', articles: '—', ordered: '—', unique: '—', capped: '—', images: '—', preview: '—' });
    console.error(`${feed}: ${String(cause)}`);
    continue;
  }

  const payload = await response.json() as { data: unknown; error: { code: string } | null; meta: { provider: string | null; status: string } };
  if (!response.ok || payload.error || !payload.data) {
    rows.push({
      feed,
      status: fail(String(response.status)),
      provider: payload.meta?.provider ?? '—',
      delivery: payload.meta?.status ?? '—',
      articles: payload.error?.code ?? 'no data',
      ordered: '—', unique: '—', capped: '—', images: '—', preview: '—',
    });
    continue;
  }

  const parsed = newsPageSchema.safeParse(payload.data);
  if (!parsed.success) {
    rows.push({ feed, status: response.status, provider: payload.meta.provider ?? '—', delivery: payload.meta.status, articles: fail('schema mismatch'), ordered: '—', unique: '—', capped: '—', images: '—', preview: '—' });
    continue;
  }

  const articles = parsed.data.articles;
  const canonical = selectLatestNews(articles, NEWS_MAX_COUNT);
  const ordered = articles.every((item, index) => index === 0 || Date.parse(articles[index - 1]!.publishedAt) >= Date.parse(item.publishedAt));
  const unique = canonical.length === articles.length;
  const capped = articles.length <= NEWS_MAX_COUNT;

  const withImage = articles.filter((item) => shouldRenderNewsImage(false, item.imageUrl));
  const outcomes = await Promise.all(withImage.map((item) => checkImage(item.imageUrl as string)));
  const count = (outcome: ImageOutcome) => outcomes.filter((value) => value === outcome).length;
  // A broken link is a real defect to look at; a publisher block and a missing
  // image simply produce cards without thumbnails.
  if (count('broken')) failures += 1;

  rows.push({
    feed,
    status: response.status,
    provider: payload.meta.provider ?? '—',
    delivery: payload.meta.status,
    articles: articles.length,
    ordered: ordered ? 'yes' : fail('NO'),
    unique: unique ? 'yes' : fail(`NO (${articles.length - canonical.length} dup)`),
    capped: capped ? 'yes' : fail('NO'),
    images: `${count('loads')} load / ${count('blocked')} blocked / ${count('broken')} broken / ${articles.length - withImage.length} none`,
    preview: `${Math.min(articles.length, NEWS_PREVIEW_COUNT)} → ${Math.min(articles.length, NEWS_MAX_COUNT)}`,
  });
}

console.table(rows);
if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exitCode = 1;
  return;
}
console.log('\nAll news checks passed.');
}

void main();
