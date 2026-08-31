/**
 * THE RULE STORE, AS A PORT — AND WHY IT IS A PORT.
 *
 * ===========================================================================
 * THE TABLES ARE WRITTEN AND NOT APPLIED
 * ===========================================================================
 * `202608300001_overview_alerts.sql` and `202608310001_overview_alert_hits.sql`
 * are both in the repository and neither has been run — they sit behind five
 * older migrations in the same state. Until they are applied,
 * `overview_alert_rules` is not in `src/types/database.ts`, so
 * `client.from('overview_alert_rules')` does not typecheck against
 * `SupabaseClient<Database>`.
 *
 * There are two ways past that and only one of them is honest. Casting the
 * client through `unknown` compiles today and keeps compiling forever, silently
 * outliving the reason it was added. Declaring the operations as an interface
 * does not: the adapter is written once the generated types know the tables, and
 * nothing here has to be unpicked.
 *
 * So this module owns the SHAPE — the table names, the columns, the RPC name and
 * its arguments, the validation and the normalization — and the caller owns the
 * round trip. That split is also what makes the sweep testable without a
 * database.
 *
 * ===========================================================================
 * A BAD ROW IS DROPPED, NOT REPAIRED
 * ===========================================================================
 * Every row is validated. One that fails is skipped rather than coerced: a rule
 * with a negative threshold or an unrecognised kind is a rule nobody can predict
 * the behaviour of, and evaluating a repaired version of it would fire an alert
 * the reader never wrote. The rest of the reader's rules still work, which is
 * the same degradation every loader on the overview performs.
 */

import { z } from 'zod';
import { OV_ALERT_KINDS, type OvAlertKind, type OvAlertRule } from './types';

/** The table `202608300001_overview_alerts.sql` creates. */
export const OV_ALERT_RULES_TABLE = 'overview_alert_rules';

/** The table `202608310001_overview_alert_hits.sql` creates. */
export const OV_ALERT_HITS_TABLE = 'overview_alert_hits';

/**
 * The function that writes a hit.
 *
 * A FUNCTION AND NOT TWO STATEMENTS. Recording a hit means inserting the row and
 * stamping `last_fired_at` on the rule, and those two must not be separable: a
 * hit written without the stamp leaves the rule permanently out of cooldown, so
 * the next sweep writes it again, and the one after that. PostgREST gives a
 * client no transaction to wrap two calls in, so the pair lives inside one
 * `plpgsql` body — one call, one transaction, both writes or neither.
 */
export const OV_ALERT_RECORD_HIT_RPC = 'record_overview_alert_hit';

/**
 * The service-role twin, for the scheduled sweep.
 *
 * `record_overview_alert_hit` resolves `auth.uid()`, which is null under the
 * service role, so a cron calling it would raise on every write. This one takes
 * the same arguments, derives the owner from the rule row, and is granted to
 * `service_role` alone — the shape `trigger_price_alert_service` already uses.
 * See `202608310002_overview_alert_hit_service.sql`.
 */
export const OV_ALERT_RECORD_HIT_SERVICE_RPC = 'record_overview_alert_hit_service';

/**
 * Exactly the columns the sweep reads, as a Supabase `select` string.
 *
 * Named rather than `*` so a column added later is not silently pulled into
 * every run, and so the migration and the reader can be diffed by eye.
 */
export const OV_ALERT_RULES_COLUMNS =
  'id, user_id, symbol, kind, threshold, enabled, last_fired_at';

const kindSchema = z.enum(OV_ALERT_KINDS as unknown as [string, ...string[]]);

const rowSchema = z.object({
  id: z.string().min(1),
  /*
    Present on every read; meaningful only on a service-role one. A reader's own
    id tells the sweep nothing it did not already know, and the parser keeps it
    optional so a caller selecting a narrower column list still works.
  */
  user_id: z.string().min(1).nullable().optional(),
  symbol: z.string().min(1).max(20),
  kind: kindSchema,
  /*
    Postgres `numeric` arrives over PostgREST as a STRING, not a number — the
    driver refuses to silently lose precision, and a schema expecting a number
    would reject every row on a table that is working perfectly. Coerced here,
    then required to be finite and positive, which is the rule the column's own
    check constraint already enforces at the other end.
  */
  threshold: z.coerce.number().finite().positive(),
  enabled: z.boolean(),
  /** Null until the rule has fired once. Written only by the RPC above. */
  last_fired_at: z.string().min(1).nullable().optional(),
});

const rowsSchema = z.array(z.unknown());

/**
 * Rows into rules.
 *
 * `symbol` is upper-cased here rather than trusted, because it is the join key
 * against the sweep's quote map and one lower-case row would simply never match
 * — a rule that silently never fires is worse than one that errors.
 */
export function parseOvAlertRules(rows: unknown): OvAlertRule[] {
  const list = rowsSchema.safeParse(rows);
  if (!list.success) return [];
  return list.data.flatMap((row) => {
    const parsed = rowSchema.safeParse(row);
    if (!parsed.success) return [];
    return [{
      id: parsed.data.id,
      userId: parsed.data.user_id ?? null,
      symbol: parsed.data.symbol.trim().toUpperCase(),
      kind: parsed.data.kind as OvAlertKind,
      threshold: parsed.data.threshold,
      enabled: parsed.data.enabled,
      lastFiredAt: parsed.data.last_fired_at ?? null,
    }];
  });
}

/** What a caller supplies to create a rule. The id and the stamp are the store's. */
export interface OvAlertRuleDraft {
  symbol: string;
  kind: OvAlertKind;
  /** Always positive. The direction is in the kind — see `types.ts`. */
  threshold: number;
  enabled?: boolean;
}

/** What may be changed on an existing rule. Its kind and symbol may not. */
export interface OvAlertRulePatch {
  threshold?: number;
  enabled?: boolean;
}

/** One recorded hit, as the RPC is asked to write it. */
export interface OvAlertHitRecord {
  ruleId: string;
  symbol: string;
  kind: OvAlertKind;
  observedPrice: number;
  observedChangePercent: number | null;
  observedEarningsDays: number | null;
  observedAt: string;
  valueText: string;
}

/**
 * Everything this feature does to the database, and nothing else.
 *
 * Deliberately narrow: five operations, each one round trip. A store written
 * against the full Supabase surface could not be exercised by an in-memory
 * double without reimplementing that surface, which is the same reasoning
 * `src/lib/news/cache-client.ts` gives for its own four-method interface.
 *
 * Every method returns raw `unknown` and this module parses it, so a double is
 * a Map and nothing is faked away.
 */
export interface OvAlertStore {
  /** The signed-in reader's rules. RLS scopes it; no user id is passed. */
  listRules(): Promise<unknown>;
  /** Returns the created row. Raises 23505 on a duplicate symbol+kind. */
  createRule(draft: OvAlertRuleDraft): Promise<unknown>;
  /** Returns the updated row, or nothing when the id is not the reader's. */
  updateRule(id: string, patch: OvAlertRulePatch): Promise<unknown>;
  deleteRule(id: string): Promise<void>;
  /**
   * Writes the hit and stamps the rule, in one transaction.
   *
   * Returns the new hit row's id. See {@link OV_ALERT_RECORD_HIT_RPC}.
   */
  recordHit(record: OvAlertHitRecord): Promise<unknown>;
}

/**
 * The reader's rules, or none.
 *
 * A failed query is an empty list, not a thrown page. An alert section that
 * cannot load is a section that shows nothing; taking down the overview because
 * one optional block could not be read is the trade the whole page avoids.
 *
 * DISABLED RULES ARE RETURNED. They are filtered where they are evaluated, not
 * here — a CRUD surface needs to list them to let a reader switch one back on,
 * and a repository that hid them would make that impossible to build.
 */
export async function loadOvAlertRules(store: OvAlertStore): Promise<OvAlertRule[]> {
  try {
    return parseOvAlertRules(await store.listRules());
  } catch {
    return [];
  }
}

/** The rules the sweep will actually evaluate. */
export async function loadEnabledOvAlertRules(store: OvAlertStore): Promise<OvAlertRule[]> {
  return (await loadOvAlertRules(store)).filter((rule) => rule.enabled);
}

const singleRowSchema = z.object({ id: z.string().min(1) }).passthrough();

/** The id of a row a write returned, or null when it returned nothing usable. */
export function parseWrittenId(row: unknown): string | null {
  const parsed = singleRowSchema.safeParse(
    Array.isArray(row) ? row[0] : row,
  );
  if (parsed.success) return parsed.data.id;
  /* Some drivers return a bare scalar from an RPC that returns one value. */
  return typeof row === 'string' && row.length > 0 ? row : null;
}

export type OvAlertWriteResult =
  | { ok: true; rule: OvAlertRule }
  | { ok: false; code: 'invalid' | 'duplicate' | 'not-found' | 'database' };

function invalidDraft(draft: OvAlertRuleDraft): boolean {
  if (!draft.symbol.trim()) return true;
  if (!Number.isFinite(draft.threshold) || draft.threshold <= 0) return true;
  return !OV_ALERT_KINDS.includes(draft.kind);
}

/**
 * Create one rule.
 *
 * The threshold is checked here as well as by the column, because a caller that
 * sent a negative one deserves a typed refusal rather than a Postgres error
 * string — and because the sign rule is this module's invariant, not the
 * database's alone.
 *
 * A 23505 becomes `duplicate` rather than being swallowed: the unique index is
 * one rule per symbol per kind, and a reader pressing a button that appears to
 * do nothing is what swallowing it produces.
 */
export async function createOvAlertRule(
  store: OvAlertStore,
  draft: OvAlertRuleDraft,
): Promise<OvAlertWriteResult> {
  if (invalidDraft(draft)) return { ok: false, code: 'invalid' };
  try {
    const created = parseOvAlertRules([await store.createRule({
      ...draft,
      symbol: draft.symbol.trim().toUpperCase(),
    })]);
    const rule = created[0];
    return rule ? { ok: true, rule } : { ok: false, code: 'database' };
  } catch (error) {
    return { ok: false, code: isDuplicate(error) ? 'duplicate' : 'database' };
  }
}

/** Change a rule's threshold, or switch it on and off. */
export async function updateOvAlertRule(
  store: OvAlertStore,
  id: string,
  patch: OvAlertRulePatch,
): Promise<OvAlertWriteResult> {
  if (patch.threshold !== undefined
    && (!Number.isFinite(patch.threshold) || patch.threshold <= 0)) {
    return { ok: false, code: 'invalid' };
  }
  if (patch.threshold === undefined && patch.enabled === undefined) {
    return { ok: false, code: 'invalid' };
  }
  try {
    const updated = parseOvAlertRules([await store.updateRule(id, patch)]);
    const rule = updated[0];
    return rule ? { ok: true, rule } : { ok: false, code: 'not-found' };
  } catch {
    return { ok: false, code: 'database' };
  }
}

/**
 * Delete one rule.
 *
 * The hits it produced go with it — `overview_alert_hits.rule_id` cascades — and
 * that is deliberate. A hit is a record of a rule firing; keeping it after the
 * rule is gone leaves a row nobody can explain and a reader cannot delete.
 */
export async function deleteOvAlertRule(
  store: OvAlertStore,
  id: string,
): Promise<{ ok: boolean }> {
  try {
    await store.deleteRule(id);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

function isDuplicate(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === '23505';
}
