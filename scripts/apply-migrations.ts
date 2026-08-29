/**
 * Applies `supabase/migrations/*.sql` in filename order to the DEVELOPMENT
 * database, once each, inside a transaction per file.
 *
 * ===========================================================================
 * WHY THIS EXISTS INSTEAD OF `supabase db push`
 * ===========================================================================
 * Two reasons, and the first one is not theoretical.
 *
 * THE CLI IS LINKED TO PRODUCTION. `supabase/.temp/project-ref` on this
 * repository names the production project, and `supabase/.temp/pooler-url`
 * holds a working production connection string with the password in it. A bare
 * `supabase db push` therefore does not push to whatever `.env.test` says — it
 * pushes to production, silently, because the link is ambient state that no
 * environment file overrides. That is precisely the accident the guard in
 * `src/lib/dev/db-target.ts` exists to make impossible, and a runner that
 * shelled out to the linked CLI would step straight around it.
 *
 * So this connects itself, to a url it has checked, and never consults the
 * link.
 *
 * Second: this repository's migrations are named `YYYYMMDDNNNN_name.sql` — a
 * twelve-digit prefix — while the CLI expects the fourteen-digit
 * `YYYYMMDDHHmmss` form. `db push` would either refuse them or order them by a
 * rule nobody here intended. Filename order is the order they were written and
 * reviewed in, so filename order is what this applies.
 *
 * ===========================================================================
 * WHAT IT RECORDS
 * ===========================================================================
 * A ledger table, `public.schema_migration_log`, one row per applied file. It
 * is created by this script rather than by a migration, because it is
 * infrastructure FOR migrations and a chicken-and-egg table cannot be one of
 * the things it tracks.
 *
 * Each file runs inside its own transaction. A file that fails rolls itself
 * back and stops the run — the remaining files are not attempted, because a
 * migration list is ordered for a reason and applying the tail over a failed
 * head produces a schema nobody has ever reviewed.
 *
 *   npm run db:apply            apply what has not been applied
 *   npm run db:apply -- --dry   list what would be applied, touch nothing
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import {
  DEV_ENV_FILE,
  ProductionTargetError,
  assertNotProductionDatabaseUrl,
  projectRefOfConnectionString,
  readEnvFile,
  resolveDevSupabaseTarget,
} from '../src/lib/dev/db-target';

const dryRun = process.argv.includes('--dry');

/*
  Both targets are resolved and checked before anything connects.

  The API target is checked as well as the database url, even though only the
  database url is used to write: they must name the SAME project, and a run
  where `.env.test` points its API at dev and its database at production is
  exactly the mix-up worth catching. There is no `createClient` and no `new
  Client` above this block.
*/
let connectionString: string;
let projectRef: string;
try {
  const api = resolveDevSupabaseTarget('npm run db:apply');
  const file = readEnvFile(DEV_ENV_FILE);
  const dbUrl = file.SUPABASE_DB_URL ?? process.env.SUPABASE_DB_URL ?? null;
  assertNotProductionDatabaseUrl(dbUrl, 'npm run db:apply');

  const dbRef = projectRefOfConnectionString(dbUrl)!;
  if (dbRef !== api.projectRef) {
    throw new ProductionTargetError(
      `npm run db:apply refused to run: ${DEV_ENV_FILE} names two different projects — `
      + `API ${api.projectRef}, database ${dbRef}. They must be the same project.`,
    );
  }
  connectionString = dbUrl!;
  projectRef = dbRef;
} catch (error) {
  console.error(error instanceof ProductionTargetError ? error.message : error);
  process.exit(1);
}

const MIGRATIONS_DIR = 'supabase/migrations';

function migrationFiles(): string[] {
  return readdirSync(resolve(process.cwd(), MIGRATIONS_DIR))
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

const LEDGER = `
  create table if not exists public.schema_migration_log (
    filename text primary key,
    applied_at timestamptz not null default now()
  );
`;

async function main(): Promise<void> {
  console.log(`Target: project ${projectRef} (development)`);
  console.log(`${dryRun ? 'DRY RUN — nothing will be written' : 'Applying'}\n`);

  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query(LEDGER);
    const applied = new Set(
      (await client.query<{ filename: string }>('select filename from public.schema_migration_log'))
        .rows.map((row) => row.filename),
    );

    const files = migrationFiles();
    const pending = files.filter((file) => !applied.has(file));
    console.log(`${files.length} migrations on disk, ${applied.size} already applied, ${pending.length} pending\n`);

    if (dryRun) {
      pending.forEach((file) => console.log(`  would apply  ${file}`));
      return;
    }

    for (const file of pending) {
      const sql = readFileSync(resolve(process.cwd(), MIGRATIONS_DIR, file), 'utf8');
      process.stdout.write(`  ${file} ... `);
      try {
        /*
          The file may open its own transaction — most of them begin with
          `begin;` and end with `commit;`. Postgres treats a nested `begin` as a
          warning and the file's own `commit` ends the outer block, so wrapping
          is not safe in general. Each file is sent as ONE query instead, which
          the server runs as an implicit transaction when the file does not open
          one itself, and as the file's own when it does.
        */
        await client.query(sql);
        await client.query(
          'insert into public.schema_migration_log (filename) values ($1) on conflict do nothing',
          [file],
        );
        console.log('ok');
      } catch (error) {
        console.log('FAILED');
        console.error(`\n${file} failed:\n${error instanceof Error ? error.message : error}\n`);
        console.error('Stopping. The remaining migrations were not attempted.');
        process.exitCode = 1;
        return;
      }
    }
    console.log(`\n${pending.length} migration(s) applied.`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
