import { IndustryDetailClient } from '@/src/components/industry/IndustryDetailClient';
import { loadIndustryDetail } from '@/src/lib/overview/service';
import { createClient } from '@/src/lib/supabase/server';
import { WatchlistRepository } from '@/src/lib/watchlist/repository';

export default async function IndustryDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const slug = decodeURIComponent((await params).slug);
  const [industry, watched] = await Promise.all([
    loadIndustryDetail(slug),
    (async () => {
      const client = await createClient();
      if (!client) return [];
      const user = (await client.auth.getUser()).data.user;
      if (!user) return [];
      try {
        return (await new WatchlistRepository(client).getDefault()).items
          .map((item) => item.symbol);
      } catch {
        return [];
      }
    })(),
  ]);
  return <IndustryDetailClient industry={industry} watchedSymbols={watched} slug={slug} />;
}
