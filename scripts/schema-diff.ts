/**
 * Compares the DEVELOPMENT database against what `supabase/migrations/*.sql`
 * declares, and reports every difference.
 *
 * ===========================================================================
 * WHY THE MIGRATIONS, AND NOT PRODUCTION
 * ===========================================================================
 * The obvious comparison is dev against production, and it is the one this
 * deliberately does not make: reading production means connecting to
 * production, and `src/lib/dev/db-target.ts` refuses that by design. Weakening
 * the guard to satisfy a diagnostic would be trading the thing that prevents an
 * accident for a report about one.
 *
 * The migrations are the better reference anyway. They are what production was
 * built from, they are in version control, and they are what the next
 * environment will be built from too. A dev database that matches them matches
 * production for every object anybody has ever declared — and where it does not,
 * the missing object has a filename beside it.
 *
 * ===========================================================================
 * WHAT IT CAN AND CANNOT SEE
 * ===========================================================================
 * This reads the migrations as TEXT and the database through its catalogs. That
 * asymmetry is the method's limit and it is worth stating plainly:
 *
 *   * it finds objects the migrations NAME — tables, columns added by
 *     `add column`, named constraints, policies, functions, and which tables
 *     have RLS turned on. Those cover the four things this comparison was asked
 *     for;
 *   * it does NOT diff column TYPES, defaults, or policy BODIES. A column that
 *     exists with the wrong type reads as present here. Catching that needs the
 *     other database to compare against, which is exactly what is off-limits;
 *   * an object created and later dropped by a subsequent migration is tracked,
 *     so a dropped table is not reported as missing.
 *
 * Everything it reports is therefore a REAL difference. What it cannot promise
 * is that silence means identical.
 *
 *   npm run db:schema-diff
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import {
  DEV_ENV_FILE,
  ProductionTargetError,
  assertNotProductionDatabaseUrl,
  readEnvFile,
} from '../src/lib/dev/db-target';

let connectionString: string;
try {
  const dbUrl = readEnvFile(DEV_ENV_FILE).SUPABASE_DB_URL ?? process.env.SUPABASE_DB_URL ?? null;
  assertNotProductionDatabaseUrl(dbUrl, 'npm run db:schema-diff');
  connectionString = dbUrl!;
} catch (error) {
  console.error(error instanceof ProductionTargetError ? error.message : error);
  process.exit(1);
}

const MIGRATIONS_DIR = 'supabase/migrations';

interface Declared {
  tables: Map<string, string>;
  columns: Map<string, string>;
  constraints: Map<string, string>;
  policies: Map<string, string>;
  functions: Map<string, string>;
  rls: Map<string, string>;
}

/**
 * Strip comments before scanning.
 *
 * These files are heavily commented and the comments discuss the very objects
 * being searched for — "`202608240001` validates it afterwards" would otherwise
 * register as a declaration. Dollar-quoted function bodies are left alone: they
 * contain real `create policy` and `add constraint` statements that execute.
 */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

type Kind = keyof Declared;
interface Event { at: number; op: 'add' | 'remove'; kind: Kind; key: string }

/**
 * Every declaration in one file, IN TEXTUAL ORDER.
 *
 * Order is the whole point and the first version got it wrong: it collected all
 * the creates, then all the drops, and applied the drops last. These migrations
 * are written as `drop policy if exists "X" on public.Y; create policy "X" on
 * public.Y ...` — the idempotent re-create pattern — so processing by category
 * deleted every policy the file had just declared, and the report claimed one
 * policy existed in the entire schema.
 *
 * Collecting positions and sorting by them makes the scan mean what SQL means:
 * the last statement about an object wins.
 */
function eventsIn(sql: string): Event[] {
  const events: Event[] = [];
  const push = (at: number, op: Event['op'], kind: Kind, key: string) =>
    events.push({ at, op, kind, key });

  for (const m of sql.matchAll(/create table (?:if not exists )?public\.(\w+)/gi)) {
    push(m.index!, 'add', 'tables', m[1]!.toLowerCase());
  }
  for (const m of sql.matchAll(/drop table (?:if exists )?public\.(\w+)/gi)) {
    push(m.index!, 'remove', 'tables', m[1]!.toLowerCase());
  }
  for (const m of sql.matchAll(/create policy "([^"]+)" on public\.(\w+)/gi)) {
    push(m.index!, 'add', 'policies', `${m[2]!.toLowerCase()}::${m[1]!}`);
  }
  for (const m of sql.matchAll(/drop policy (?:if exists )?"([^"]+)" on public\.(\w+)/gi)) {
    push(m.index!, 'remove', 'policies', `${m[2]!.toLowerCase()}::${m[1]!}`);
  }
  for (const m of sql.matchAll(/create (?:or replace )?function public\.(\w+)/gi)) {
    push(m.index!, 'add', 'functions', m[1]!.toLowerCase());
  }
  for (const m of sql.matchAll(/drop function (?:if exists )?public\.(\w+)/gi)) {
    push(m.index!, 'remove', 'functions', m[1]!.toLowerCase());
  }

  /*
    `add column` and `add constraint` take their table from the enclosing
    `alter table`, so the block is matched first and the offsets inside it are
    made absolute — otherwise every inner statement would sort as position 0.
  */
  for (const block of sql.matchAll(/alter table (?:if exists )?public\.(\w+)([\s\S]*?);/gi)) {
    const table = block[1]!.toLowerCase();
    const base = block.index! + block[0]!.indexOf(block[2]!);
    const body = block[2]!;
    for (const c of body.matchAll(/add column (?:if not exists )?(\w+)/gi)) {
      push(base + c.index!, 'add', 'columns', `${table}.${c[1]!.toLowerCase()}`);
    }
    for (const c of body.matchAll(/drop column (?:if exists )?(\w+)/gi)) {
      push(base + c.index!, 'remove', 'columns', `${table}.${c[1]!.toLowerCase()}`);
    }
    for (const c of body.matchAll(/add constraint (\w+)/gi)) {
      push(base + c.index!, 'add', 'constraints', c[1]!.toLowerCase());
    }
    for (const c of body.matchAll(/drop constraint (?:if exists )?(\w+)/gi)) {
      push(base + c.index!, 'remove', 'constraints', c[1]!.toLowerCase());
    }
    if (/enable row level security/i.test(body)) push(base, 'add', 'rls', table);
  }

  return events.sort((left, right) => left.at - right.at);
}

function readDeclarations(): Declared {
  const declared: Declared = {
    tables: new Map(), columns: new Map(), constraints: new Map(),
    policies: new Map(), functions: new Map(), rls: new Map(),
  };
  const files = readdirSync(resolve(process.cwd(), MIGRATIONS_DIR))
    .filter((name) => name.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = stripComments(readFileSync(resolve(process.cwd(), MIGRATIONS_DIR, file), 'utf8'));
    for (const event of eventsIn(sql)) {
      if (event.op === 'add') declared[event.kind].set(event.key, file);
      else declared[event.kind].delete(event.key);
    }
  }
  return declared;
}

interface Row { kind: string; name: string; state: string; detail: string }

async function main(): Promise<void> {
  const declared = readDeclarations();
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    const [tables, columns, constraints, policies, functions, rls, skipped] = await Promise.all([
      client.query<{ n: string }>("select table_name n from information_schema.tables where table_schema='public'"),
      client.query<{ n: string }>("select table_name || '.' || column_name n from information_schema.columns where table_schema='public'"),
      client.query<{ n: string }>("select conname n from pg_constraint c join pg_namespace ns on ns.oid=c.connamespace where ns.nspname='public'"),
      client.query<{ n: string }>("select tablename || '::' || policyname n from pg_policies where schemaname='public'"),
      client.query<{ n: string }>("select distinct p.proname n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public'"),
      client.query<{ n: string }>("select c.relname n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace where ns.nspname='public' and c.relrowsecurity"),
      client.query<{ filename: string; note: string }>("select filename, note from public.schema_migration_log where status='skipped'"),
    ]);

    const live = {
      tables: new Set(tables.rows.map((r) => r.n.toLowerCase())),
      columns: new Set(columns.rows.map((r) => r.n.toLowerCase())),
      constraints: new Set(constraints.rows.map((r) => r.n.toLowerCase())),
      policies: new Set(policies.rows.map((r) => r.n)),
      functions: new Set(functions.rows.map((r) => r.n.toLowerCase())),
      rls: new Set(rls.rows.map((r) => r.n.toLowerCase())),
    };

    const missing: Row[] = [];
    const check = (kind: string, want: Map<string, string>, have: Set<string>) => {
      for (const [name, file] of want) {
        if (!have.has(name)) missing.push({ kind, name, state: 'MISSING in dev', detail: file });
      }
    };
    check('table', declared.tables, live.tables);
    check('column', declared.columns, live.columns);
    check('constraint', declared.constraints, live.constraints);
    check('policy', declared.policies, live.policies);
    check('function', declared.functions, live.functions);
    check('rls', declared.rls, live.rls);

    console.log('SCHEMA COMPARISON — development vs supabase/migrations');
    console.log('');
    console.log('| object kind | declared | present in dev | missing |');
    console.log('|---|---:|---:|---:|');
    const summary: [string, Map<string, string>, Set<string>][] = [
      ['table', declared.tables, live.tables],
      ['column (added)', declared.columns, live.columns],
      ['constraint', declared.constraints, live.constraints],
      ['policy', declared.policies, live.policies],
      ['function', declared.functions, live.functions],
      ['RLS enabled', declared.rls, live.rls],
    ];
    for (const [kind, want, have] of summary) {
      const absent = [...want.keys()].filter((k) => !have.has(k)).length;
      console.log(`| ${kind} | ${want.size} | ${want.size - absent} | ${absent} |`);
    }

    console.log('');
    if (missing.length === 0) {
      console.log('No declared object is missing from the development database.');
    } else {
      console.log('DIFFERENCES');
      console.log('');
      console.log('| kind | object | state | declared by |');
      console.log('|---|---|---|---|');
      for (const row of missing) {
        console.log(`| ${row.kind} | \`${row.name}\` | ${row.state} | ${row.detail} |`);
      }
    }

    if (skipped.rows.length > 0) {
      console.log('');
      console.log('DELIBERATELY NOT APPLIED IN DEVELOPMENT');
      console.log('');
      for (const row of skipped.rows) {
        console.log(`  ${row.filename}`);
        console.log(`    ${row.note}`);
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
