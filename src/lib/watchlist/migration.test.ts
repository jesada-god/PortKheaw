import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(resolve(process.cwd(), `supabase/migrations/${file}`), 'utf8')
  .replace(/\s+/g, ' ')
  .toLowerCase();

const sql = read('202607180003_phase_3_watchlist.sql');
const multi = read('202608290003_multi_watchlists.sql');

describe('Phase 3 watchlist migration security contract', () => {
  it('enforced one watchlist per user, before 202608290003 lifted it', () => {
    expect(sql).toContain('unique (user_id)');
    expect(sql).toContain('unique (watchlist_id, symbol)');
  });

  it('enables RLS on both tables', () => {
    expect(sql).toContain('alter table public.watchlists enable row level security');
    expect(sql).toContain('alter table public.watchlist_items enable row level security');
  });

  it('authorizes every item operation through its parent owner', () => {
    expect(sql.match(/w\.id = watchlist_id and w\.user_id = \(select auth\.uid\(\)\)/g)).toHaveLength(5);
    for (const operation of ['select', 'insert', 'update', 'delete']) {
      expect(sql).toContain(`for ${operation} to authenticated`);
    }
  });

  it('creates a default watchlist safely for existing and new users', () => {
    expect(sql).toContain('get_or_create_default_watchlist');
    expect(sql).toContain("on conflict (user_id) do nothing");
    expect(sql).toContain("insert into public.watchlists (user_id, name) values (new.id, 'รายการโปรด')");
  });
});

describe('multi-watchlist migration contract', () => {
  it('lifts the one-per-user constraint', () => {
    expect(multi).toContain('drop constraint if exists watchlists_one_per_user');
  });

  /*
   * The whole data migration, asserted by what is ABSENT. `watchlist_items` has
   * always pointed at a `watchlist_id`, so nothing is re-parented — and a
   * migration that moved or deleted rows would be a migration that could lose
   * one. If somebody later adds a backfill here, this is the test that should
   * make them explain why.
   */
  it('moves, copies and deletes no item', () => {
    expect(multi).not.toContain('delete from public.watchlist_items');
    expect(multi).not.toContain('update public.watchlist_items set watchlist_id');
    expect(multi).not.toContain('insert into public.watchlist_items');
  });

  it('keeps names unique per account, case- and whitespace-insensitively', () => {
    expect(multi).toContain('create unique index if not exists watchlists_owner_normalized_name_key');
    expect(multi).toContain('on public.watchlists (user_id, lower(btrim(name)))');
  });

  it('refuses to delete the only list, under a lock so two deletes cannot race', () => {
    expect(multi).toContain('cannot delete the only watchlist');
    expect(multi).toContain('if remaining <= 1 then');
    const deleteFn = multi.slice(multi.indexOf('function public.delete_watchlist'));
    expect(deleteFn.slice(0, deleteFn.indexOf('$$;'))).toContain('pg_advisory_xact_lock');
  });

  /*
   * `on conflict (user_id)` needs an index to arbitrate against, so every
   * function that used one had to be rewritten when the constraint went. Missing
   * one breaks signup, which is why they are named rather than assumed.
   */
  it('rewrites both functions that depended on the dropped index', () => {
    for (const fn of ['public.get_or_create_default_watchlist()', 'public.handle_new_user()']) {
      expect(multi).toContain(`create or replace function ${fn}`);
    }
    const signup = multi.slice(multi.indexOf('function public.handle_new_user()'));
    const body = signup.slice(0, signup.indexOf('$$;'));
    expect(body).toContain('where not exists (select 1 from public.watchlists where user_id = new.id)');
    expect(body).not.toContain("insert into public.watchlists (user_id, name) values (new.id, 'รายการโปรด') on conflict (user_id)");
  });

  it('keeps the rest of the signup trigger intact', () => {
    const signup = multi.slice(multi.indexOf('function public.handle_new_user()'));
    const body = signup.slice(0, signup.indexOf('$$;'));
    for (const table of ['public.profiles', 'public.user_settings', 'public.user_subscriptions', 'public.user_roles', 'public.portfolios']) {
      expect(body, table).toContain(table);
    }
  });

  it('resolves ownership inside every definer function instead of taking a user id', () => {
    for (const fn of [
      'public.create_watchlist(input_name text)',
      'public.rename_watchlist(target_watchlist_id uuid, input_name text)',
      'public.delete_watchlist(target_watchlist_id uuid)',
      'public.set_overview_watchlist(target_watchlist_id uuid)',
    ]) expect(multi).toContain(fn);
    expect(multi).not.toContain('input_user_id');
    // Every one is a definer function with a pinned, empty search_path.
    expect(multi.match(/security definer set search_path = ''/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it('checks ownership before pointing the Overview at a list', () => {
    const fn = multi.slice(multi.indexOf('function public.set_overview_watchlist'));
    const body = fn.slice(0, fn.indexOf('$$;'));
    expect(body).toContain('where id = target_watchlist_id and user_id = requesting_user');
  });

  it('revokes anon and grants only authenticated on every new function', () => {
    for (const fn of [
      'public.create_watchlist(text)',
      'public.rename_watchlist(uuid, text)',
      'public.delete_watchlist(uuid)',
      'public.set_overview_watchlist(uuid)',
      'public.set_watchlist_item_pinned(uuid, text, boolean)',
    ]) {
      expect(multi, fn).toContain(`revoke all on function ${fn} from public, anon`);
      expect(multi, fn).toContain(`grant execute on function ${fn} to authenticated`);
    }
  });

  it('adds the preview columns without disturbing existing rows', () => {
    expect(multi).toContain('add column if not exists pinned boolean not null default false');
    expect(multi).toContain('add column if not exists overview_watchlist_id uuid');
    // Deleting the chosen list must clear the preference, never the settings row.
    expect(multi).toContain('references public.watchlists(id) on delete set null');
  });

  it('is wrapped in one transaction and documents its reversal', () => {
    expect(multi.startsWith('begin;')).toBe(true);
    expect(multi).toContain('commit;');
    expect(multi).toContain('reversal');
  });
});
