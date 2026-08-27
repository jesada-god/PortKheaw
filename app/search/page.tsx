import Header from '@/src/components/layout/Header';
import { SearchClient } from '@/src/components/search/SearchClient';
import { createClient } from '@/src/lib/supabase/server';
import { WatchlistRepository } from '@/src/lib/watchlist/repository';

/**
 * Search is a way to get somewhere, so the page's only server work is the one
 * thing the browser cannot know: which symbols are already being followed. The
 * search itself still runs against the existing endpoint from the client, one
 * debounced request per settled query.
 */
export default async function SearchPage() {
  const client = await createClient();
  const watchedSymbols = client
    ? await new WatchlistRepository(client).getDefault()
      .then((record) => record.items.map((item) => item.symbol))
      .catch(() => [])
    : [];

  return <div>
    <Header title="ค้นหา" subtitle="พิมพ์ชื่อบริษัทหรือ Symbol" />
    <SearchClient watchedSymbols={watchedSymbols} />
  </div>;
}
