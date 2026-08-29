import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/src/types/database';
import type { WatchlistItemRecord, WatchlistRecord, WatchlistSummary } from './types';

/**
 * Reading and writing a reader's watchlists.
 *
 * ===========================================================================
 * EVERY MUTATION GOES THROUGH AN RPC, AND THAT IS THE POINT
 * ===========================================================================
 * The single-list methods used to write the tables directly, which was fine
 * while "the user's watchlist" was a thing there could only be one of. With
 * several, three rules have to hold on every path — the name is unique per
 * account, the last list cannot be deleted, and nobody may point their Overview
 * at a list they do not own — and a rule enforced in TypeScript holds only for
 * the callers that remember it.
 *
 * So `create`, `rename`, `delete`, `chooseForOverview` and `setPinned` are thin
 * wrappers over `security definer` functions that take the lock, do the count,
 * and check ownership themselves. This class does no validation those functions
 * do not also do; what it adds is the shape the app wants back.
 *
 * READS stay direct queries under RLS, which is the right tool for them: the
 * policies already scope every row to its owner, and a definer function reading
 * on the caller's behalf would only move that guarantee somewhere less visible.
 */
export class WatchlistRepository {
  constructor(private readonly client: SupabaseClient<Database>) {}

  /**
   * The id of the list the app should show when nobody has said which.
   *
   * Delegates to `get_or_create_default_watchlist`, which since
   * `202608290003` means "the chosen list if it is chosen and still owned,
   * otherwise the oldest" — and creates one when the account has none.
   */
  async ensureDefault(): Promise<string> {
    const { data, error } = await this.client.rpc('get_or_create_default_watchlist');
    if (error || !data) throw error ?? new Error('Default watchlist was not created');
    return data;
  }

  /**
   * Every list this reader owns, oldest first, with its row count.
   *
   * Ordered by `created_at, id` — the same tie-break
   * `get_or_create_default_watchlist` and `resolveOverviewWatchlist` use, so
   * the switcher, the page and the Overview cannot disagree about which list is
   * first.
   *
   * The counts are tallied from a second SELECT rather than from a PostgREST
   * embedded aggregate. `Database` declares no relationship between these two
   * tables, so an embed would have to be cast past its own type — and a cast
   * that says "trust me about the shape of a query result" is exactly the kind
   * that survives a schema change it should have caught.
   *
   * Both statements run under RLS as the same reader, so the tally can only
   * count rows in lists this query already returned. A symbol added between the
   * two shows up as a count one higher than the rows a later read returns, which
   * is a label briefly ahead of the page rather than a wrong one.
   */
  async listAll(): Promise<WatchlistSummary[]> {
    await this.ensureDefault();
    const { data: lists, error } = await this.client
      .from('watchlists')
      .select('id, name, created_at')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
    if (error) throw error;
    if (!lists || lists.length === 0) return [];

    const { data: items, error: itemsError } = await this.client
      .from('watchlist_items')
      .select('watchlist_id')
      .in('watchlist_id', lists.map((list) => list.id));
    if (itemsError) throw itemsError;

    const counts = new Map<string, number>();
    for (const item of items ?? []) {
      counts.set(item.watchlist_id, (counts.get(item.watchlist_id) ?? 0) + 1);
    }

    return lists.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      // Absent means zero: an empty list is a normal state, not a failed count.
      itemCount: counts.get(row.id) ?? 0,
    }));
  }

  /** One list and its rows, or null when the id is not this reader's. */
  async getById(watchlistId: string): Promise<WatchlistRecord | null> {
    const [{ data: watchlist, error: watchlistError }, { data: items, error: itemsError }] = await Promise.all([
      this.client.from('watchlists').select('id, name, created_at').eq('id', watchlistId).maybeSingle(),
      this.client.from('watchlist_items').select('id, symbol, created_at, pinned')
        .eq('watchlist_id', watchlistId).order('created_at', { ascending: false }),
    ]);
    if (watchlistError) throw watchlistError;
    /*
      Null, not an exception. RLS makes another reader's list indistinguishable
      from one that does not exist, which is the correct behaviour — and the
      caller's answer to both is the same: send them to their own default.
    */
    if (!watchlist) return null;
    if (itemsError) throw itemsError;
    return {
      id: watchlist.id,
      name: watchlist.name,
      createdAt: watchlist.created_at,
      items: (items ?? []).map(toItem),
    };
  }

  /** The default list, resolved and loaded. */
  async getDefault(): Promise<WatchlistRecord> {
    const id = await this.ensureDefault();
    const record = await this.getById(id);
    if (!record) throw new Error('Watchlist not found');
    return record;
  }

  /**
   * The list to show, preferring an explicit request and falling back to the
   * default when it is absent or not this reader's.
   *
   * The fallback is silent on purpose: a stale id in a URL or a bookmark
   * pointing at a deleted list should land somebody on their watchlist, not on
   * an error about a list they may never have known existed.
   */
  async getForRequest(requestedId: string | null): Promise<WatchlistRecord> {
    if (requestedId) {
      const requested = await this.getById(requestedId);
      if (requested) return requested;
    }
    return this.getDefault();
  }

  async add(symbol: string, watchlistId?: string): Promise<WatchlistItemRecord> {
    const targetId = watchlistId ?? await this.ensureDefault();
    const { data, error } = await this.client.from('watchlist_items')
      .insert({ watchlist_id: targetId, symbol })
      .select('id, symbol, created_at, pinned').single();
    if (error || !data) throw error ?? new Error('Watchlist item was not created');
    return toItem(data);
  }

  async remove(symbol: string, watchlistId?: string): Promise<boolean> {
    const targetId = watchlistId ?? await this.ensureDefault();
    const { data, error } = await this.client.from('watchlist_items')
      .delete().eq('watchlist_id', targetId).eq('symbol', symbol).select('id');
    if (error) throw error;
    return Boolean(data?.length);
  }

  /** A new list. Throws 23505 when the account already has one by this name. */
  async create(name: string): Promise<string> {
    const { data, error } = await this.client.rpc('create_watchlist', { input_name: name });
    if (error || !data) throw error ?? new Error('Watchlist was not created');
    return data;
  }

  /**
   * Rename one list.
   *
   * `watchlistId` is required — the single-list version defaulted to "the"
   * list, which with several would silently rename whichever one happened to
   * resolve as the default rather than the one the reader had open.
   */
  async rename(watchlistId: string, name: string): Promise<void> {
    const { error } = await this.client.rpc('rename_watchlist', {
      target_watchlist_id: watchlistId, input_name: name,
    });
    if (error) throw error;
  }

  /** Delete one list. Throws 23514 when it is the reader's only one. */
  async delete(watchlistId: string): Promise<void> {
    const { error } = await this.client.rpc('delete_watchlist', {
      target_watchlist_id: watchlistId,
    });
    if (error) throw error;
  }

  /** Which list the Overview preview draws from. Null clears the choice. */
  async chooseForOverview(watchlistId: string | null): Promise<void> {
    const { error } = await this.client.rpc('set_overview_watchlist', {
      target_watchlist_id: watchlistId,
    });
    if (error) throw error;
  }

  /** Which list the Overview is currently set to, or null when unchosen. */
  async overviewChoice(): Promise<string | null> {
    const { data, error } = await this.client
      .from('user_settings').select('overview_watchlist_id').maybeSingle();
    if (error) throw error;
    return data?.overview_watchlist_id ?? null;
  }

  async setPinned(watchlistId: string, symbol: string, pinned: boolean): Promise<void> {
    const { error } = await this.client.rpc('set_watchlist_item_pinned', {
      target_watchlist_id: watchlistId, input_symbol: symbol, input_pinned: pinned,
    });
    if (error) throw error;
  }
}

function toItem(row: { id: string; symbol: string; created_at: string; pinned?: boolean | null }): WatchlistItemRecord {
  return {
    id: row.id,
    symbol: row.symbol,
    createdAt: row.created_at,
    /*
      Absent reads as false, which is what a row written before the column
      existed means: nobody has pinned it. Never null — the preview's ordering
      branches on this and a null would sort as neither pinned nor unpinned.
    */
    pinned: row.pinned === true,
  };
}
