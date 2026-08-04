import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const PROFILE_MIGRATION = '202607180001_phase_1_auth.sql';
const STATS_MIGRATION = '202608050002_public_member_stats.sql';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const USER_C = '33333333-3333-4333-8333-333333333333';

let db: PGlite;

async function count(): Promise<number> {
  const result = await db.query<{ member_count: number }>(
    'select member_count from public.app_public_stats where singleton = true',
  );
  return Number(result.rows[0].member_count);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create table auth.users (
      id uuid primary key,
      email text,
      raw_user_meta_data jsonb not null default '{}'::jsonb
    );
    create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  `);
  await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', PROFILE_MIGRATION), 'utf8'));
  await db.exec(`
    alter table public.profiles add column deleted_at timestamptz;
    insert into auth.users (id, email) values
      ('${USER_A}', 'a@example.test'),
      ('${USER_B}', 'b@example.test');
    update public.profiles set deleted_at = now() where id = '${USER_B}';
    create publication supabase_realtime for table public.profiles;
  `);
  await db.exec(readFileSync(resolve(process.cwd(), 'supabase/migrations', STATS_MIGRATION), 'utf8'));
});

describe('public member stats migration', () => {
  it('backfills one singleton from non-deleted profiles', async () => {
    expect(await count()).toBe(1);
    const rows = await db.query('select * from public.app_public_stats');
    expect(rows.rows).toHaveLength(1);
  });

  it('updates atomically for insert, hard delete, soft delete and restore', async () => {
    await db.exec(`insert into auth.users (id, email) values ('${USER_C}', 'c@example.test')`);
    expect(await count()).toBe(2);

    await db.exec(`update public.profiles set deleted_at = now() where id = '${USER_C}'`);
    expect(await count()).toBe(1);

    await db.exec(`update public.profiles set deleted_at = null where id = '${USER_C}'`);
    expect(await count()).toBe(2);

    await db.exec(`delete from auth.users where id = '${USER_C}'`);
    expect(await count()).toBe(1);
  });

  it('rolls the aggregate back with the profile transaction', async () => {
    await db.exec('begin');
    await db.exec(`update public.profiles set deleted_at = null where id = '${USER_B}'`);
    expect(await count()).toBe(2);
    await db.exec('rollback');
    expect(await count()).toBe(1);
  });

  it('grants anon and authenticated SELECT only, behind a SELECT policy', async () => {
    const grants = await db.query<{ grantee: string; privilege_type: string }>(`
      select grantee, privilege_type
      from information_schema.role_table_grants
      where table_schema = 'public'
        and table_name = 'app_public_stats'
        and grantee in ('anon', 'authenticated')
      order by grantee, privilege_type
    `);
    expect(grants.rows).toEqual([
      { grantee: 'anon', privilege_type: 'SELECT' },
      { grantee: 'authenticated', privilege_type: 'SELECT' },
    ]);

    const policies = await db.query<{ cmd: string; roles: string[] }>(`
      select cmd, roles from pg_policies
      where schemaname = 'public' and tablename = 'app_public_stats'
    `);
    expect(policies.rows).toHaveLength(1);
    expect(policies.rows[0].cmd).toBe('SELECT');
    expect(policies.rows[0].roles).toEqual(['anon', 'authenticated']);
  });

  it('publishes only the aggregate, never profiles or auth.users', async () => {
    const publication = await db.query<{ schemaname: string; tablename: string }>(`
      select schemaname, tablename
      from pg_publication_tables
      where pubname = 'supabase_realtime'
      order by schemaname, tablename
    `);
    expect(publication.rows).toEqual([
      { schemaname: 'public', tablename: 'app_public_stats' },
    ]);
  });
});
