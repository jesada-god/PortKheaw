/**
 * DOES THIS MIGRATION RUN? — asked without applying it.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * `docs/operations/migration-state.md` says the thing this script answers:
 *
 *     "not yet applied" here means "written, never run", not "run and observed
 *     absent"
 *
 * Every file under `-- STATUS: NOT YET APPLIED` is SQL nobody has executed, and
 * the first execution is against production, by hand, with the deploy waiting.
 * A syntax error, a `drop function` whose signature does not match, a CHECK that
 * an existing row fails — all of those are found at the worst possible moment.
 *
 * This finds them at the best one. It opens a transaction on the DEVELOPMENT
 * database, runs the file's body inside it, and ROLLS BACK. Nothing is applied,
 * nothing is left behind, and the answer is real rather than a parse check: the
 * statements ran against a real schema with real rows.
 *
 *   npm run db:validate -- supabase/migrations/202609200001_unify_alert_rules.sql
 *
 * ===========================================================================
 * WHAT IT DOES NOT TELL YOU
 * ===========================================================================
 * That the file is CORRECT. It tells you the file executes and, because dev and
 * production drift, only that it executes against dev. A migration whose
 * `drop constraint` names something only dev has still passes here.
 *
 * It also proves nothing about behaviour. Asserting what a migration should have
 * changed belongs beside the migration, in a test or in a probe written for it —
 * this is the floor, not the ceiling.
 *
 * ===========================================================================
 * IT REFUSES PRODUCTION, FOR THE REASON `apply-migrations.ts` GIVES
 * ===========================================================================
 * Same guard, applied before anything connects: `.env.test` wins over the
 * process environment, the API target and the database url must name the same
 * project, and a production ref throws. A rollback is not a safety net worth
 * betting a production database on — an open transaction holding DDL locks on a
 * live table is its own outage.
 */
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import {
  DEV_ENV_FILE,
  ProductionTargetError,
  assertNotProductionDatabaseUrl,
  projectRefOfConnectionString,
  readEnvFile,
  resolveDevSupabaseTarget,
} from '../src/lib/dev/db-target';

const file = process.argv[2];
if (!file) {
  console.error('usage: npm run db:validate -- <path to a .sql migration>');
  process.exit(1);
}

let connectionString: string;
let projectRef: string;
try {
  const api = resolveDevSupabaseTarget('npm run db:validate');
  const env = readEnvFile(DEV_ENV_FILE);
  const dbUrl = env.SUPABASE_DB_URL ?? process.env.SUPABASE_DB_URL ?? null;
  assertNotProductionDatabaseUrl(dbUrl, 'npm run db:validate');
  const dbRef = projectRefOfConnectionString(dbUrl)!;
  if (dbRef !== api.projectRef) {
    throw new ProductionTargetError(
      `npm run db:validate refused to run: ${DEV_ENV_FILE} names two different projects — `
      + `API ${api.projectRef}, database ${dbRef}. They must be the same project.`,
    );
  }
  connectionString = dbUrl!;
  projectRef = dbRef;
} catch (error) {
  console.error(error instanceof ProductionTargetError ? error.message : error);
  process.exit(1);
}

const raw = readFileSync(file, 'utf8');
if (!/^\s*commit;\s*$/mi.test(raw)) {
  console.error(`${file} has no \`commit;\` of its own — is it a migration?`);
  process.exit(1);
}
/*
  The file's own `begin;` and `commit;` come out.

  This runs the body inside a transaction of ITS OWN so it can roll back, and
  leaving the file's `commit` in would end that transaction — the rollback would
  then be a no-op over statements that had already landed, which is the one
  failure mode that turns a validator into an applier.
*/
const body = raw
  .replace(/^\s*begin;\s*$/mi, '')
  .replace(/^\s*commit;\s*$/mi, '');

async function main() {
  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
  });
  await client.connect();
  console.log(`Target: project ${projectRef} (development)`);
  console.log('DRY — the transaction is rolled back, nothing is applied\n');

  let ok = true;
  try {
    await client.query('begin');
    await client.query(body);
    console.log(`  ${file} ... executes`);
  } catch (error) {
    ok = false;
    console.error(`  ${file} ... DID NOT RUN\n`);
    console.error(error);
  } finally {
    await client.query('rollback').catch(() => undefined);
    await client.end();
  }

  console.log('\nrolled back — the development database is unchanged.');
  process.exit(ok ? 0 : 1);
}

void main();
