/**
 * WHICH DATABASE A SCRIPT IS ABOUT TO WRITE TO, AND THE REFUSAL THAT KEEPS IT
 * OFF PRODUCTION.
 *
 * ===========================================================================
 * WHY THIS THROWS INSTEAD OF RETURNING A BOOLEAN
 * ===========================================================================
 * A guard that returns `false` is a guard the caller can ignore, and every way
 * of ignoring it looks like ordinary code: a forgotten `if`, an `await` that was
 * dropped, a refactor that moved the check above the connection. The failure is
 * silent, it happens once, and by the time anybody reads the output the writes
 * have landed.
 *
 * So the only thing this module exports for the dangerous case is a function
 * that THROWS. There is no boolean to drop, no warning to scroll past, and no
 * "continue anyway" flag — a flag would be the same hole with a nicer name,
 * because the situation where somebody reaches for it is exactly the situation
 * where they are wrong.
 *
 * ===========================================================================
 * WHAT COUNTS AS PRODUCTION
 * ===========================================================================
 * Three answers, checked in order, and the check FAILS CLOSED at every step:
 *
 *   1. A known production project ref, listed below. A Supabase project ref is
 *      not a secret — it is the hostname in `NEXT_PUBLIC_SUPABASE_URL` and ships
 *      inside every browser bundle — so naming it here costs nothing and is the
 *      strongest of the three, because it does not depend on the machine the
 *      script happens to be running on.
 *
 *   2. Whatever `.env.local` points at. That file is this repo's production
 *      configuration by convention, so a project nobody remembered to add to the
 *      list above is still caught on any machine that has it. Read lazily and
 *      treated as absent when unreadable — its absence must not be the thing
 *      that makes a run safe.
 *
 *   3. A url that is missing, malformed, or not a Supabase host at all. Refused
 *      rather than passed through: "I could not tell what this is" and "this is
 *      safe" are different answers, and only one of them may let a write
 *      proceed.
 *
 * ===========================================================================
 * THE TEST THAT MATTERS
 * ===========================================================================
 * `db-target.test.ts` asserts that the production url THROWS. Weaken this
 * module — return instead of throw, empty the list, invert a comparison — and
 * that test goes red. It is written to fail if the guard is removed, which is
 * the only property that makes a guard worth having.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Project refs this repository must never write to from a script.
 *
 * Add to it, never remove from it. A ref that stops being production does not
 * become dangerous by remaining listed; one that is removed by mistake becomes
 * writable everywhere at once.
 */
export const PRODUCTION_PROJECT_REFS: readonly string[] = [
  // PortKheaw production (Supabase).
  'jjmenqktnabmajpqxzhr',
];

/** Where the dev credentials live. Never committed — `.gitignore` covers `.env*`. */
export const DEV_ENV_FILE = '.env.test';

/** Where production configuration lives on a developer machine. Read, never written. */
const PRODUCTION_ENV_FILE = '.env.local';

export class ProductionTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductionTargetError';
  }
}

/**
 * The project ref of a Supabase url — the label before `.supabase.co`.
 *
 * Null for anything this cannot confidently read, which the caller must treat
 * as "refuse", not as "not production". Comparing refs rather than whole urls is
 * deliberate: `https://ref.supabase.co`, a trailing slash, and a pooler host all
 * name one database, and a string comparison would call two of them safe.
 */
export function projectRefOf(url: string | null | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host.endsWith('.supabase.co') && !host.endsWith('.supabase.in')) return null;
  /*
    `<ref>.supabase.co` is the API host and `db.<ref>.supabase.co` is the
    database host for the SAME project. Both have to resolve to the same ref, or
    a connection string would slip past a check that only knew the API spelling.
  */
  const labels = host.split('.');
  const ref = (labels[0] === 'db' ? labels[1] : labels[0]) ?? '';
  return /^[a-z0-9]{16,}$/.test(ref) ? ref : null;
}

/**
 * The project ref of a POSTGRES connection string.
 *
 * Its own function because a pooler url hides the ref somewhere `projectRefOf`
 * would never look: the host is shared infrastructure
 * (`aws-1-ap-northeast-2.pooler.supabase.com`) and the project is in the
 * USERNAME, as `postgres.<ref>`. A guard that only read hostnames would wave
 * through the production pooler string that sits in `supabase/.temp/pooler-url`
 * on any machine that has ever linked the CLI — which is the most likely
 * production connection string anybody in this repo will ever have to hand.
 *
 * Null when it cannot be read, which callers must treat as "refuse".
 */
export function projectRefOfConnectionString(value: string | null | undefined): string | null {
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) return null;

  const direct = projectRefOf(`https://${parsed.hostname}`);
  if (direct) return direct;

  // Pooler: the project rides in the username as `postgres.<ref>`.
  const user = decodeURIComponent(parsed.username).toLowerCase();
  const dotted = user.split('.');
  const ref = dotted.length > 1 ? dotted[dotted.length - 1]! : '';
  return /^[a-z0-9]{16,}$/.test(ref) ? ref : null;
}

/** A tiny `KEY=value` reader. No dependency, and it never throws on a missing file. */
export function readEnvFile(file: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(resolve(process.cwd(), file), 'utf8');
  } catch {
    return {};
  }
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const equals = trimmed.indexOf('=');
    if (equals <= 0) continue;
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

/**
 * Every ref this machine can currently identify as production.
 *
 * The hardcoded list plus whatever `.env.local` names. `readEnvFile` returning
 * nothing is a normal outcome — a CI box has no `.env.local` — and it narrows
 * this set rather than widening it, which is why the hardcoded list has to
 * exist and cannot be replaced by the file.
 */
export function knownProductionRefs(): Set<string> {
  const refs = new Set(PRODUCTION_PROJECT_REFS);
  const local = readEnvFile(PRODUCTION_ENV_FILE);
  const localRef = projectRefOf(local.NEXT_PUBLIC_SUPABASE_URL);
  if (localRef) refs.add(localRef);
  return refs;
}

/**
 * Refuse to continue unless `url` is a database this repo may write to.
 *
 * Throws {@link ProductionTargetError}. Returns nothing on success, so there is
 * no value a caller can accidentally use as permission — the only way to
 * proceed past this line is for it not to have thrown.
 *
 * `label` names the caller in the message, because the person reading it is
 * usually mid-incident and the useful sentence is "which script was this".
 */
export function assertNotProduction(url: string | null | undefined, label = 'this script'): void {
  const ref = projectRefOf(url);
  if (ref === null) {
    throw new ProductionTargetError(
      `${label} refused to run: could not read a Supabase project from ${url ?? '(no url)'}. `
      + `A target that cannot be identified is treated as production. `
      + `Point NEXT_PUBLIC_SUPABASE_URL at a development project, or run with ${DEV_ENV_FILE}.`,
    );
  }
  if (knownProductionRefs().has(ref)) {
    throw new ProductionTargetError(
      `${label} refused to run against PRODUCTION (project ${ref}). `
      + `This script writes. Use a development project — put its credentials in ${DEV_ENV_FILE}. `
      + `There is deliberately no override flag.`,
    );
  }
}

/**
 * The same refusal, for a Postgres connection string.
 *
 * Separate entry point because the parsing differs, identical policy because
 * the danger is identical — this is the one that actually runs DDL.
 */
export function assertNotProductionDatabaseUrl(
  value: string | null | undefined,
  label = 'this script',
): void {
  const ref = projectRefOfConnectionString(value);
  if (ref === null) {
    throw new ProductionTargetError(
      `${label} refused to run: could not read a Supabase project from the database url. `
      + `A target that cannot be identified is treated as production. `
      + `Put a development SUPABASE_DB_URL in ${DEV_ENV_FILE}.`,
    );
  }
  if (knownProductionRefs().has(ref)) {
    throw new ProductionTargetError(
      `${label} refused to run against the PRODUCTION database (project ${ref}). `
      + `This applies migrations. Use the development project's connection string. `
      + `There is deliberately no override flag.`,
    );
  }
}

export interface DevSupabaseTarget {
  url: string;
  anonKey: string;
  serviceKey: string;
  projectRef: string;
}

/**
 * The development target, resolved and checked.
 *
 * `.env.test` wins over the process environment, so a shell that still has
 * production values exported from an earlier task cannot quietly become the
 * target of a script somebody thought was pointed at dev. The guard runs LAST,
 * over whatever was actually resolved — checking the file and then connecting
 * with something else is the bug this ordering exists to prevent.
 *
 * Throws rather than calling `process.exit`, so a test can observe the refusal.
 * The scripts turn it into an exit code themselves.
 */
export function resolveDevSupabaseTarget(
  label = 'this script',
  env: NodeJS.ProcessEnv = process.env,
): DevSupabaseTarget {
  const file = readEnvFile(DEV_ENV_FILE);
  const url = file.NEXT_PUBLIC_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL ?? null;
  const anonKey = file.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ?? file.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ?? env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ?? null;
  const serviceKey = file.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? null;

  assertNotProduction(url, label);

  if (!anonKey || !serviceKey) {
    throw new ProductionTargetError(
      `${label} refused to run: ${DEV_ENV_FILE} is missing `
      + `${!anonKey ? 'NEXT_PUBLIC_SUPABASE_ANON_KEY' : 'SUPABASE_SERVICE_ROLE_KEY'}.`,
    );
  }

  return { url: url!, anonKey, serviceKey, projectRef: projectRefOf(url)! };
}
